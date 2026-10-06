import { chmodSync } from 'node:fs';
import { byTestId, pane, terminalBox, termTab, TID } from './contract.js';
import {
  confirmClose,
  expect,
  focusedPane,
  isCurrent,
  LOCAL,
  makeRepoWith,
  newTerminal,
  openPage,
  openUi,
  paneIds,
  PRESETS,
  ready,
  selectWorktree,
  splitPane,
  test,
  waitScreen,
  watcher,
  xtermOf,
} from './fixture.js';
import {
  activeRoot,
  balanced,
  createdTerm,
  createsSent,
  createTerms,
  divider,
  expectPlacement,
  fitted,
  layoutsSent,
  leaf,
  pointFor,
  reachable,
  shareOf,
  split,
  splitByKey,
  startDrag,
  storeTabs,
} from './panes.js';

const [, CAT] = PRESETS;

test.describe('split panes', () => {
  test('splitting right shows the old terminal left and the new one right, focused, on every page', async ({
    hub,
    page,
    wire,
    context,
  }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const left = await newTerminal(page);
    const full = createsSent(wire).at(-1);
    const other = await openPage(hub, context);
    await expect(other.page.locator(pane(left))).toBeVisible();

    const mark = wire.markSent();
    const right = await splitPane(page, 'right');
    expect(await paneIds(page)).toEqual([left, right]);
    await expectPlacement(page, left, right, 'right');
    await expect.poll(() => focusedPane(page)).toBe(right);

    const creates = createsSent(wire, mark);
    expect(creates).toEqual([expect.objectContaining({ preset: 'shell', command: null })]);
    // The first terminal filled the whole area; the new pane is half as wide and as high.
    expect(Math.abs((creates[0]?.cols ?? 0) - (full?.cols ?? 0) / 2)).toBeLessThanOrEqual(2);
    expect(Math.abs((creates[0]?.rows ?? 0) - (full?.rows ?? 0))).toBeLessThanOrEqual(1);
    await expect.poll(() => layoutsSent(wire, mark).map(activeRoot)).toContainEqual(split('right', leaf(left), leaf(right)));

    await expect.poll(() => paneIds(other.page)).toEqual([left, right]);
    await expectPlacement(other.page, left, right, 'right');
  });

  test('the split-down button shows the new terminal below the old one, focused, running the chosen preset', async ({
    hub,
    page,
    wire,
  }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const top = await newTerminal(page);
    const full = createsSent(wire).at(-1);

    const mark = wire.markSent();
    const bottom = await splitPane(page, 'down', 'cat');
    expect(await paneIds(page)).toEqual([top, bottom]);
    await expectPlacement(page, top, bottom, 'down');
    await expect.poll(() => focusedPane(page)).toBe(bottom);
    await waitScreen(page, bottom, 'PRESET-CAT');

    const creates = createsSent(wire, mark);
    expect(creates).toEqual([expect.objectContaining({ preset: CAT.name, command: CAT.command })]);
    // The first terminal filled the whole area; the new pane is as wide and half as high.
    expect(Math.abs((creates[0]?.cols ?? 0) - (full?.cols ?? 0))).toBeLessThanOrEqual(1);
    expect(Math.abs((creates[0]?.rows ?? 0) - (full?.rows ?? 0) / 2)).toBeLessThanOrEqual(2);
    await expect.poll(() => layoutsSent(wire, mark).map(activeRoot)).toContainEqual(split('down', leaf(top), leaf(bottom)));
  });

  test('Ctrl+Shift+D splits right and Ctrl+Shift+E splits the new pane down', async ({ hub, page, wire }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const left = await newTerminal(page);
    await ready(page, left);
    const mark = wire.markSent();

    const right = await splitByKey(page, 'right');
    await expectPlacement(page, left, right, 'right');
    await expect.poll(() => focusedPane(page)).toBe(right);

    const bottom = await splitByKey(page, 'down');
    await expectPlacement(page, right, bottom, 'down');
    await expectPlacement(page, left, bottom, 'right');
    await expect.poll(() => focusedPane(page)).toBe(bottom);
    expect(await paneIds(page)).toEqual([left, right, bottom]);
    await expect
      .poll(() => layoutsSent(wire, mark).map(activeRoot))
      .toContainEqual(split('right', leaf(left), split('down', leaf(right), leaf(bottom))));
  });

  test('splitting a terminal missing from the layout first gives it its own tab', async ({ hub, page, wire }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const client = await watcher(hub, repo);
    const [lone = 0] = await createTerms(client, repo, 1);
    await expect(page.locator(terminalBox(LOCAL, lone))).toBeVisible();
    const mark = wire.markSent();
    const added = await splitPane(page, 'right');
    await expect
      .poll(() => layoutsSent(wire, mark).at(-1))
      .toEqual({ tabs: [{ id: expect.any(String), root: split('right', leaf(lone), leaf(added)) }], active: 0 });
  });

  test('every pane of a three-pane tab is shown and fitted when its worktree is selected, and setVisible lists all three', async ({
    hub,
    page,
    wire,
  }) => {
    const { repo, worktrees } = makeRepoWith(hub, 'app', ['a', 'b']);
    const [a = '', b = ''] = worktrees;
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const client = await watcher(hub, repo);
    const [solo = 0] = await createTerms(client, a, 1);
    await storeTabs(client, a, [leaf(solo)]);
    const three = await createTerms(client, b, 3);
    const [t0 = 0, t1 = 0, t2 = 0] = three;
    await storeTabs(client, b, [split('right', leaf(t0), split('down', leaf(t1), leaf(t2)))]);
    await selectWorktree(page, a);
    await expect(page.locator(terminalBox(LOCAL, solo))).toBeVisible();

    const mark = wire.markSent();
    await selectWorktree(page, b);
    for (const term of three) await expect(page.locator(terminalBox(LOCAL, term))).toBeVisible();
    await expect(page.locator(terminalBox(LOCAL, solo))).toBeHidden();
    expect(await paneIds(page)).toEqual(three);
    for (const term of three) await expect.poll(() => fitted(page, term)).toBe(true);
    await expect
      .poll(() =>
        wire
          .sentToHost(LOCAL, mark)
          .flatMap((m) => (m.t === 'setVisible' ? [[...m.termIds].sort((x, y) => x - y)] : []))
          .at(-1),
      )
      .toEqual([...three].sort((x, y) => x - y));
  });

  test('moving terminals into and out of a split keeps each terminal object', async ({ hub, page }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const client = await watcher(hub, repo);
    const [one = 0, two = 0] = await createTerms(client, repo, 2);
    await storeTabs(client, repo, [leaf(one), leaf(two)], 1);
    await expect(page.locator(terminalBox(LOCAL, two))).toBeVisible();
    const from = client.mark();
    await page.locator(termTab(one)).click();
    await expect(page.locator(terminalBox(LOCAL, one))).toBeVisible();
    // The page's own setLayout lands before the ones below.
    await client.waitFor('layoutChanged', (m) => m.worktree === repo && m.layout.active === 0, { from });
    const handles = [
      { term: one, xterm: await xtermOf(page, one) },
      { term: two, xterm: await xtermOf(page, two) },
    ];
    const unchanged = async (): Promise<void> => {
      for (const { term, xterm } of handles) expect(await isCurrent(page, xterm, `${terminalBox(LOCAL, term)} .xterm`)).toBe(true);
    };

    await storeTabs(client, repo, [split('right', leaf(one), leaf(two))]);
    await expect.poll(() => paneIds(page)).toEqual([one, two]);
    for (const { term } of handles) await expect(page.locator(terminalBox(LOCAL, term))).toBeVisible();
    await unchanged();

    await storeTabs(client, repo, [leaf(one), leaf(two)], 1);
    await expect.poll(() => paneIds(page)).toEqual([two]);
    await expect(page.locator(terminalBox(LOCAL, one))).toBeHidden();
    await unchanged();
  });
});

test.describe('dragging dividers', () => {
  test('a drag resizes the panes as the pointer moves and stores one setLayout on release, shown by a second page', async ({
    hub,
    page,
    wire,
    context,
  }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const left = await newTerminal(page);
    const right = await splitPane(page, 'right');
    const other = await openPage(hub, context);
    await expectPlacement(other.page, left, right, 'right');
    await expect(divider(page, '')).toHaveAttribute('data-split', 'right');

    const mark = wire.markSent();
    await startDrag(page, '', 'right', await pointFor(page, left, right, 'right', 0.3));
    await expect.poll(() => shareOf(page, left, right, 'right')).toBeCloseTo(0.3, 1);
    expect(layoutsSent(wire, mark)).toEqual([]);
    await page.mouse.up();

    await expect.poll(() => layoutsSent(wire, mark).length).toBe(1);
    await page.waitForTimeout(500); // NOSONAR(S2925) — absence check: nothing to synchronise on
    const sent = layoutsSent(wire, mark);
    expect(sent).toHaveLength(1);
    const root = activeRoot(sent[0]);
    if (root === undefined || !('split' in root)) throw new Error(`no split stored: ${JSON.stringify(sent)}`);
    expect(root.ratio).toBeCloseTo(0.3, 2);
    await expect.poll(() => shareOf(other.page, left, right, 'right')).toBeCloseTo(0.3, 1);
  });

  test('a drag stops at 5% and 95%', async ({ hub, page, wire }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const top = await newTerminal(page);
    const bottom = await splitPane(page, 'down');
    for (const [past, ratio] of [
      [0.01, 0.05],
      [0.99, 0.95],
    ] as const) {
      const mark = wire.markSent();
      await startDrag(page, '', 'down', await pointFor(page, top, bottom, 'down', past));
      await page.mouse.up();
      await expect.poll(() => layoutsSent(wire, mark).length).toBe(1);
      const root = activeRoot(layoutsSent(wire, mark)[0]);
      if (root === undefined || !('split' in root)) throw new Error('no split stored');
      expect(root.ratio).toBeCloseTo(ratio, 5);
    }
  });

  test('a pane closed elsewhere during a drag ends the drag and shows the layout without it', async ({ hub, page, wire }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const client = await watcher(hub, repo);
    const [left = 0, top = 0, bottom = 0] = await createTerms(client, repo, 3);
    await storeTabs(client, repo, [split('right', leaf(left), split('down', leaf(top), leaf(bottom)))]);
    await expect.poll(() => paneIds(page)).toEqual([left, top, bottom]);
    for (const term of [left, top, bottom]) await expect(page.locator(terminalBox(LOCAL, term))).toBeVisible();

    const mark = wire.markSent();
    await startDrag(page, '', 'right', await pointFor(page, left, top, 'right', 0.3));
    await expect.poll(() => shareOf(page, left, top, 'right')).toBeCloseTo(0.3, 1);
    await client.ok({ t: 'closeTerm', termId: bottom });

    await expect.poll(() => paneIds(page)).toEqual([left, top]);
    await expect(divider(page, 'b')).toHaveCount(0);
    // The daemon's layout still holds the ratio stored before the drag.
    await expect.poll(() => shareOf(page, left, top, 'right')).toBeCloseTo(0.5, 1);
    await page.mouse.move(await pointFor(page, left, top, 'right', 0.7), 300, { steps: 5 });
    await page.waitForTimeout(300); // NOSONAR(S2925) — absence check: nothing to synchronise on
    expect(await shareOf(page, left, top, 'right')).toBeCloseTo(0.5, 1);
    await page.mouse.up();
    await page.waitForTimeout(500); // NOSONAR(S2925) — absence check: nothing to synchronise on
    expect(layoutsSent(wire, mark)).toEqual([]);
  });

  test('a layout the daemon rejects is replaced by the last layout it reported', async ({ hub, page, wire }) => {
    test.skip(process.getuid?.() === 0, 'root writes into a read-only directory');
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const left = await newTerminal(page);
    const right = await splitPane(page, 'right');
    await expect.poll(() => shareOf(page, left, right, 'right')).toBeCloseTo(0.5, 1);

    // The daemon cannot persist state, so it answers setLayout with `internal`.
    chmodSync(hub.stateDir, 0o500);
    try {
      const sentMark = wire.markSent();
      const receivedMark = wire.markReceived();
      await startDrag(page, '', 'right', await pointFor(page, left, right, 'right', 0.3));
      await page.mouse.up();
      await expect.poll(() => layoutsSent(wire, sentMark).length).toBe(1);
      const request = wire.sentToHost(LOCAL, sentMark).find((m) => m.t === 'setLayout');
      if (request?.t !== 'setLayout') throw new Error('no setLayout');
      await expect.poll(() => wire.receivedFromHost(LOCAL, receivedMark).some((m) => m.t === 'error' && m.req === request.req)).toBe(true);
      await expect.poll(() => shareOf(page, left, right, 'right')).toBeCloseTo(0.5, 1);
    } finally {
      chmodSync(hub.stateDir, 0o700);
    }
  });
});

test.describe('pane limit and concurrent splits', () => {
  test('a tab of 8 panes disables the split controls and the split shortcuts do nothing', async ({ hub, page, wire }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const client = await watcher(hub, repo);
    const terms = await createTerms(client, repo, 8);
    await storeTabs(client, repo, [balanced(terms)]);
    await expect.poll(async () => (await paneIds(page)).length).toBe(8);

    await expect(page.locator(byTestId(TID.splitRight))).toBeDisabled();
    await expect(page.locator(byTestId(TID.splitDown))).toBeDisabled();
    await expect(page.locator(byTestId(TID.newTab))).toBeEnabled();
    const [first = 0] = terms;
    await page.locator(terminalBox(LOCAL, first)).click();
    const mark = wire.markSent();
    await page.keyboard.press('Control+Shift+KeyD');
    await page.keyboard.press('Control+Shift+KeyE');
    await page.waitForTimeout(500); // NOSONAR(S2925) — absence check: nothing to synchronise on
    await expect(page.locator(byTestId(TID.presetPicker))).toHaveCount(0);
    expect(createsSent(wire, mark)).toEqual([]);
  });

  test('two pages splitting the same tab at once both keep their new terminal visible', async ({ hub, page, wire, context }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const first = await newTerminal(page);
    const other = await openPage(hub, context);
    await expect(other.page.locator(pane(first))).toBeVisible();

    await page.locator(byTestId(TID.splitRight)).click();
    await other.page.locator(byTestId(TID.splitDown)).click();
    const options = [page, other.page].map((p) =>
      p.locator(byTestId(TID.presetPicker)).locator(byTestId(TID.presetOption), { hasText: 'shell' }),
    );
    for (const option of options) await expect(option).toBeVisible();
    const marks = [wire.markReceived(), other.wire.markReceived()];
    await Promise.all(options.map((option) => option.click()));
    const created = [await createdTerm(wire, marks[0] ?? 0), await createdTerm(other.wire, marks[1] ?? 0)];
    expect(created[0]).not.toBe(created[1]);

    for (const p of [page, other.page]) {
      for (const term of created) await expect.poll(() => reachable(p, term)).toBe(true);
    }
  });
});

test.describe('pane focus', () => {
  test('closing the focused pane of a two-pane split focuses the other, which receives typed input', async ({ hub, page }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const left = await newTerminal(page);
    await ready(page, left);
    const right = await splitPane(page, 'right');
    await expect.poll(() => focusedPane(page)).toBe(right);

    await page.locator(pane(right)).locator(byTestId(TID.paneClose)).click();
    await confirmClose(page);
    await expect.poll(() => paneIds(page)).toEqual([left]);
    await expect.poll(() => focusedPane(page)).toBe(left);
    await page.keyboard.type("echo FOCUS''-OK");
    await page.keyboard.press('Enter');
    await waitScreen(page, left, 'FOCUS-OK');
  });

  test('closing a focused pane focuses the first pane of the subtree that took its place', async ({ hub, page }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const client = await watcher(hub, repo);
    const [left = 0, top = 0, bottom = 0] = await createTerms(client, repo, 3);
    await storeTabs(client, repo, [split('right', leaf(left), split('down', leaf(top), leaf(bottom)))]);
    await expect(page.locator(terminalBox(LOCAL, left))).toBeVisible();
    await page.locator(terminalBox(LOCAL, bottom)).click();
    await expect.poll(() => focusedPane(page)).toBe(bottom);
    await page.locator(terminalBox(LOCAL, left)).click();
    await expect.poll(() => focusedPane(page)).toBe(left);

    await client.ok({ t: 'closeTerm', termId: left });
    await expect.poll(() => paneIds(page)).toEqual([top, bottom]);
    await expect.poll(() => focusedPane(page)).toBe(top);
  });
});
