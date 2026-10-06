import type { Page } from '@playwright/test';
import { byTestId, terminalBox, termTab, TID } from './contract.js';
import {
  expect,
  isCurrent,
  LOCAL,
  makeRepoWith,
  newTerminal,
  openPage,
  openUi,
  ready,
  screenOf,
  selectWorktree,
  test,
  typeLine,
  waitScreen,
  watcher,
  xtermOf,
} from './fixture.js';

test.describe('terminal tabs', () => {
  test('a new terminal runs a shell in the worktree, becomes the active tab and is listed in every page', async ({
    hub,
    page,
    wire,
    context,
  }) => {
    const { repo, worktrees } = makeRepoWith(hub, 'app', ['feat']);
    const feat = worktrees[0] ?? '';
    hub.writeRepos([repo]);
    await openUi(hub, page);
    await selectWorktree(page, feat);
    const mark = wire.markSent();
    const term = await newTerminal(page);
    const creates = wire.sentToHost(LOCAL, mark).filter((m) => m.t === 'createTerm');
    expect(creates).toEqual([expect.objectContaining({ worktree: feat, preset: 'shell', command: null })]);
    await expect
      .poll(() =>
        wire
          .sentToHost(LOCAL, mark)
          .some((m) => m.t === 'setLayout' && m.worktree === feat && JSON.stringify(m.layout).includes(`"term":${String(term)}`)),
      )
      .toBe(true);
    await expect(page.locator(termTab(term))).toHaveAttribute('aria-selected', 'true');

    await typeLine(page, term, 'pwd');
    await waitScreen(page, term, feat);

    const other = await openPage(hub, context);
    await selectWorktree(other.page, feat);
    await expect(other.page.locator(termTab(term))).toBeVisible();
  });

  test('a worktree without terminals offers to create one and creates none by itself', async ({ hub, page, wire }) => {
    const { repo, worktrees } = makeRepoWith(hub, 'app', ['feat']);
    const feat = worktrees[0] ?? '';
    hub.writeRepos([repo]);
    await openUi(hub, page);
    await selectWorktree(page, feat);
    await expect(page.locator(byTestId(TID.newTerminal))).toBeVisible();
    await page.waitForTimeout(1000);
    await expect(page.locator(byTestId(TID.termTab))).toHaveCount(0);
    expect(wire.sentToHost(LOCAL).filter((m) => m.t === 'createTerm')).toEqual([]);
  });

  test('a live terminal missing from the layout is shown as a tab', async ({ hub, page }) => {
    const { repo, worktrees } = makeRepoWith(hub, 'app', ['feat']);
    const feat = worktrees[0] ?? '';
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const client = await watcher(hub, repo);
    const term = await client.create(feat);
    await selectWorktree(page, feat);
    await expect(page.locator(termTab(term.termId))).toBeVisible();
  });

  test('an exited terminal says so and its screen stays readable', async ({ hub, page }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const term = await newTerminal(page);
    await ready(page, term);
    await typeLine(page, term, "echo BYE''-MARK; exit");
    await expect(page.locator(termTab(term))).toContainText('exited');
    await expect(page.locator(terminalBox(LOCAL, term))).toBeVisible();
    expect(await screenOf(page, term)).toContain('BYE-MARK');
  });
});

test.describe('terminal lifetime', () => {
  test('each terminal is the same object in the same container across 20 switches', async ({ hub, page }) => {
    const { repo, worktrees } = makeRepoWith(hub, 'app', ['a', 'b']);
    const [a = '', b = ''] = worktrees;
    hub.writeRepos([repo]);
    await openUi(hub, page);
    await selectWorktree(page, a);
    const termA = await newTerminal(page);
    await selectWorktree(page, b);
    const termB = await newTerminal(page);
    const handles = [
      { term: termA, xterm: await xtermOf(page, termA) },
      { term: termB, xterm: await xtermOf(page, termB) },
    ];
    const containers = await Promise.all(handles.map(({ term }) => page.locator(terminalBox(LOCAL, term)).elementHandle()));

    for (let i = 0; i < 20; i++) {
      await selectWorktree(page, i % 2 === 0 ? a : b);
      for (const [n, { term, xterm }] of handles.entries()) {
        expect(await isCurrent(page, xterm, `${terminalBox(LOCAL, term)} .xterm`)).toBe(true);
        const container = containers[n];
        if (container === undefined) throw new Error(`no container for terminal ${String(term)}`);
        expect(await isCurrent(page, container, terminalBox(LOCAL, term))).toBe(true);
      }
    }
  });

  test('a hidden terminal keeps receiving output without a new attach', async ({ hub, page, wire }) => {
    const { repo, worktrees } = makeRepoWith(hub, 'app', ['a', 'b']);
    const [a = '', b = ''] = worktrees;
    hub.writeRepos([repo]);
    await openUi(hub, page);
    await selectWorktree(page, a);
    const term = await newTerminal(page);
    await ready(page, term);
    await typeLine(page, term, "sleep 2; echo HIDDEN''-OK");
    await selectWorktree(page, b);
    const mark = wire.markSent();
    await expect(page.locator(terminalBox(LOCAL, term))).toBeHidden();
    await waitScreen(page, term, 'HIDDEN-OK');

    await selectWorktree(page, a);
    await expect(page.locator(terminalBox(LOCAL, term))).toBeVisible();
    expect(await screenOf(page, term)).toContain('HIDDEN-OK');
    expect(wire.attachesSent(LOCAL, term, mark)).toBe(0);
  });

  test('switching between viewed worktrees sends only setVisible and resize', async ({ hub, page, wire }) => {
    const { repo, worktrees } = makeRepoWith(hub, 'app', ['a', 'b']);
    const [a = '', b = ''] = worktrees;
    hub.writeRepos([repo]);
    await openUi(hub, page);
    await selectWorktree(page, a);
    const termA = await newTerminal(page);
    await ready(page, termA);
    await selectWorktree(page, b);
    const termB = await newTerminal(page);
    await ready(page, termB);
    await page.waitForTimeout(500);

    const mark = wire.markSent();
    for (const path of [a, b, a, b]) await selectWorktree(page, path);
    await page.waitForTimeout(500);
    const sent = wire.sentMessages(mark);
    expect(wire.sentBinary(mark)).toEqual([]);
    expect(sent.map((m) => (m.t === 'host' ? m.m.t : m.t)).filter((t) => t !== 'setVisible' && t !== 'resize')).toEqual([]);
    expect(sent.some((m) => m.t === 'host' && m.m.t === 'setVisible')).toBe(true);
  });
});

test.describe('attach and acknowledgement', () => {
  test('50 MiB of numbered lines arrive once, in order, without the page being detached', async ({ hub, page, wire }) => {
    test.setTimeout(300_000);
    const LAST = 6_000_000;
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const term = await newTerminal(page);
    await ready(page, term);
    await typeLine(page, term, `printf 'SEQ''-START\\n'; seq 1 ${String(LAST)}; printf 'SEQ''-END\\n'`);
    const screen = await waitScreen(page, term, 'SEQ-END', 240_000);
    expect(screen).toContain(`${String(LAST)}\nSEQ-END`);

    const frames = wire.dataOf(LOCAL, term);
    expect(frames.filter((f) => f.kind === 'snapshot')).toHaveLength(1);
    const outputs: Uint8Array[] = [];
    let position = -1;
    for (const frame of frames) {
      if (frame.kind === 'input') continue;
      if (frame.kind === 'snapshot') {
        position = frame.offset;
        continue;
      }
      expect(frame.offset).toBe(position);
      position = frame.offset + frame.data.length;
      outputs.push(frame.data);
    }
    const output = Buffer.concat(outputs);
    const marker = output.indexOf('SEQ-START\r\n');
    expect(marker).toBeGreaterThanOrEqual(0);
    const start = marker + 'SEQ-START\r\n'.length;
    const end = output.indexOf('SEQ-END', start);
    expect(end - start).toBeGreaterThan(50 * 1024 * 1024);
    let at = start;
    for (let i = 1; i <= LAST; i++) {
      const line = `${String(i)}\r\n`;
      if (output.toString('latin1', at, at + line.length) !== line) {
        throw new Error(`line ${String(i)} missing or out of order at byte ${String(at - start)}`);
      }
      at += line.length;
    }
    expect(at).toBe(end);
    expect(wire.receivedFromHost(LOCAL).filter((m) => m.t === 'detached')).toEqual([]);
  });
});

test.describe('lagging terminals', () => {
  test('a hidden terminal detached as lagging is attached again when it is shown', async ({ hub, page, wire }) => {
    test.setTimeout(120_000);
    const { repo, worktrees } = makeRepoWith(hub, 'app', ['a', 'b']);
    const [a = '', b = ''] = worktrees;
    hub.writeRepos([repo]);
    await openUi(hub, page);
    await selectWorktree(page, b);
    const term = await newTerminal(page);
    await ready(page, term);
    await typeLine(page, term, "sleep 2; seq 1 3000000; echo LAG''-DONE");
    await selectWorktree(page, a);
    const mark = wire.markSent();
    await page.evaluate(() => {
      const end = Date.now() + 7000;
      while (Date.now() < end) {
        // Busy: the page reads and acks nothing, so the daemon evicts the flooding terminal.
      }
    });
    await expect
      .poll(() => wire.receivedFromHost(LOCAL).some((m) => m.t === 'detached' && m.termId === term), { timeout: 15_000 })
      .toBe(true);
    await page.waitForTimeout(1500);
    expect(wire.attachesSent(LOCAL, term, mark)).toBe(0);

    await selectWorktree(page, b);
    await expect.poll(() => wire.attachesSent(LOCAL, term, mark), { timeout: 10_000 }).toBeGreaterThan(0);
    await waitScreen(page, term, 'LAG-DONE', 30_000);
  });
});

test.describe('choosing and closing tabs', () => {
  test('choosing a tab shows its terminal at once and stores it as active', async ({ hub, page, wire }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const first = await newTerminal(page);
    const second = await newTerminal(page);
    await expect(page.locator(terminalBox(LOCAL, first))).toBeHidden();
    const mark = wire.markSent();
    await page.locator(termTab(first)).click();
    await expect(page.locator(terminalBox(LOCAL, first))).toBeVisible({ timeout: 1000 });
    await expect(page.locator(terminalBox(LOCAL, second))).toBeHidden();
    await expect(page.locator(termTab(first))).toHaveAttribute('aria-selected', 'true');
    await expect
      .poll(() =>
        wire.sentToHost(LOCAL, mark).some((m) => {
          if (m.t !== 'setLayout') return false;
          const active = m.layout.tabs[m.layout.active]?.root;
          return active !== undefined && 'term' in active && active.term === first;
        }),
      )
      .toBe(true);
  });

  test('closing a tab sends closeTerm and removes the tab', async ({ hub, page, wire }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const first = await newTerminal(page);
    const second = await newTerminal(page);
    const mark = wire.markSent();
    await page.locator(termTab(second)).locator(byTestId(TID.termTabClose)).click();
    await expect
      .poll(() =>
        wire
          .sentToHost(LOCAL, mark)
          .filter((m) => m.t === 'closeTerm')
          .map((m) => m.termId),
      )
      .toEqual([second]);
    await expect(page.locator(termTab(second))).toHaveCount(0);
    await expect(page.locator(termTab(first))).toBeVisible();
  });
});

test.describe('window resizing', () => {
  test('resizing the window fits the shown terminal and resizes its PTY', async ({ hub, page, wire }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await page.setViewportSize({ width: 1280, height: 800 });
    await openUi(hub, page);
    const term = await newTerminal(page);
    await ready(page, term);
    const before = await page.locator(terminalBox(LOCAL, term)).locator('.xterm-screen').boundingBox();
    const mark = wire.markSent();
    await page.setViewportSize({ width: 800, height: 500 });
    await expect.poll(() => wire.sentToHost(LOCAL, mark).filter((m) => m.t === 'resize' && m.termId === term).length).toBeGreaterThan(0);
    const resize = wire
      .sentToHost(LOCAL, mark)
      .filter((m) => m.t === 'resize' && m.termId === term)
      .at(-1);
    const after = await page.locator(terminalBox(LOCAL, term)).locator('.xterm-screen').boundingBox();
    expect(after?.width).toBeLessThan(before?.width ?? 0);
    await typeLine(page, term, 'stty size');
    if (resize?.t !== 'resize') throw new Error('no resize');
    await waitScreen(page, term, `${String(resize.rows)} ${String(resize.cols)}`);
  });
});

test.describe('lagging terminals, shown or with the page hidden', () => {
  /** Blocks the page's main thread so it reads and acks nothing and the daemon evicts a flooding terminal. */
  const stall = async (page: Page): Promise<void> => {
    await page.evaluate(() => {
      const end = Date.now() + 7000;
      while (Date.now() < end) {
        // Busy.
      }
    });
  };

  const setVisibility = (page: Page, hidden: boolean): Promise<void> =>
    page.evaluate((isHidden) => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (isHidden ? 'hidden' : 'visible') });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => isHidden });
      document.dispatchEvent(new Event('visibilitychange'));
    }, hidden);

  test('a shown terminal detached as lagging is attached again at once', async ({ hub, page, wire }) => {
    test.setTimeout(120_000);
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const term = await newTerminal(page);
    await ready(page, term);
    await typeLine(page, term, "sleep 2; seq 1 3000000; echo LAG''-DONE");
    const mark = wire.markSent();
    await stall(page);
    await expect
      .poll(() => wire.receivedFromHost(LOCAL).some((m) => m.t === 'detached' && m.termId === term), { timeout: 15_000 })
      .toBe(true);
    await expect.poll(() => wire.attachesSent(LOCAL, term, mark), { timeout: 3000 }).toBeGreaterThan(0);
    await waitScreen(page, term, 'LAG-DONE', 30_000);
  });

  test('a shown terminal detached as lagging while the page is hidden is attached again when it becomes visible', async ({
    hub,
    page,
    wire,
  }) => {
    test.setTimeout(120_000);
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const term = await newTerminal(page);
    await ready(page, term);
    await typeLine(page, term, "sleep 2; seq 1 3000000; echo LAG''-DONE");
    await setVisibility(page, true);
    const mark = wire.markSent();
    await stall(page);
    await expect
      .poll(() => wire.receivedFromHost(LOCAL).some((m) => m.t === 'detached' && m.termId === term), { timeout: 15_000 })
      .toBe(true);
    await page.waitForTimeout(1500);
    expect(wire.attachesSent(LOCAL, term, mark)).toBe(0);
    await setVisibility(page, false);
    await expect.poll(() => wire.attachesSent(LOCAL, term, mark), { timeout: 3000 }).toBeGreaterThan(0);
    await waitScreen(page, term, 'LAG-DONE', 30_000);
  });
});

test.describe('terminal settings', () => {
  test('a terminal keeps 10000 lines of scrollback', async ({ hub, page }) => {
    test.setTimeout(120_000);
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const term = await newTerminal(page);
    await ready(page, term);
    await typeLine(page, term, "seq 1 12000; echo SB''-END");
    const lines = (await waitScreen(page, term, 'SB-END', 60_000)).split('\n');
    // The oldest kept number is about 12000 - 10000 - rows.
    expect(lines).not.toContain('1500');
    expect(lines).toContain('2100');
  });

  test('a terminal measures character widths per Unicode 11', async ({ hub, page }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const term = await newTerminal(page);
    await ready(page, term);
    // U+1F917 is wide in Unicode 11 but narrow in xterm's default Unicode 6 table: one step back lands on its second half.
    await typeLine(page, term, String.raw`printf 'W:\U0001F917\e[1DX\n'`);
    await expect.poll(async () => ((await screenOf(page, term)) ?? '').split('\n')).toContain('W: X');
  });

  test('a link opens in a new window without access to the page', async ({ hub, page, context }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const term = await newTerminal(page);
    await ready(page, term);
    const url = `${hub.origin}/link-target`;
    await typeLine(page, term, `clear; echo ${url}`);
    await expect.poll(async () => ((await screenOf(page, term)) ?? '').split('\n')[0]).toBe(url);
    const screen = page.locator(terminalBox(LOCAL, term)).locator('.xterm-screen');
    const popup = context.waitForEvent('page');
    // The URL starts the first row; a point a few pixels in is on it.
    await screen.hover({ position: { x: 12, y: 6 } });
    await screen.click({ position: { x: 12, y: 6 } });
    const opened = await popup;
    await expect.poll(() => opened.url()).toContain('/link-target');
    expect(await opened.evaluate(() => window.opener === null)).toBe(true);
  });
});
