import { existsSync, rmSync, writeFileSync } from 'node:fs';
import type { Locator, Page } from '@playwright/test';
import { join } from 'node:path';
import type { HubHost } from '../support/hub-host.js';
import { extOrigin, fakeWorktrees, git } from '../support/daemon-host.js';
import { COMMANDS, runIn } from './attention-helpers.js';
import { byTestId, repoTab, termTab, TID, worktreeEntry } from './contract.js';
import {
  borderOf,
  confirmClose,
  detachedWorktree,
  expect,
  listedWorktrees,
  LOCAL,
  makeRepoWith,
  markOf,
  newTerminal,
  openPage,
  openUi,
  ready,
  selectRepo,
  selectWorktree,
  test,
  typeLine,
  waitScreen,
  watcher,
} from './fixture.js';

/** `--danger`, as computed. */
const DANGER = 'rgb(241, 76, 76)';
const label = (path: string): string => `${worktreeEntry(path)} ${byTestId(TID.worktreeLabel)}`;
const checkbox = (path: string): string => `${worktreeEntry(path)} input[type="checkbox"]`;
const boxOf = async (locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> => {
  const box = await locator.boundingBox();
  if (box === null) throw new Error('the element is not shown');
  return box;
};

test.describe('worktree sidebar', () => {
  test('labels show the branch, or the directory and short head when detached, with the path on hover', async ({ hub, page }) => {
    const { repo, worktrees } = makeRepoWith(hub, 'app', ['feature/x']);
    const feature = worktrees[0] ?? '';
    const detached = detachedWorktree(repo, 'wt2');
    hub.writeRepos([repo]);
    await openUi(hub, page);
    await expect(page.locator(label(repo))).toHaveText('main');
    await expect(page.locator(label(feature))).toHaveText('feature/x');
    await expect(page.locator(label(detached.path))).toHaveText(`wt2 @ ${detached.head.slice(0, 7)}`);
    expect((await listedWorktrees(page)).sort()).toEqual([repo, feature, detached.path].sort());
  });

  test('a prunable worktree is greyed and offers no new terminal', async ({ hub, page }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    const [prunable = ''] = fakeWorktrees(repo, 1);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    await expect(page.locator(worktreeEntry(prunable))).toHaveAttribute('data-prunable', 'true');
    await expect(page.locator(worktreeEntry(repo))).not.toHaveAttribute('data-prunable', 'true');
    await selectWorktree(page, prunable);
    for (const control of [TID.newTab, TID.splitRight, TID.splitDown]) await expect(page.locator(byTestId(control))).toBeDisabled();
    await expect(page.locator(byTestId(TID.presetChoices))).toHaveCount(0);
  });

  test('a removed worktree with a running terminal stays listed as gone until the terminal closes', async ({ hub, page }) => {
    const { repo, worktrees } = makeRepoWith(hub, 'app', ['doomed', 'other']);
    const doomed = worktrees[0] ?? '';
    hub.writeRepos([repo]);
    await openUi(hub, page);
    await selectWorktree(page, doomed);
    const term = await newTerminal(page);
    await ready(page, term);

    git(repo, 'worktree', 'remove', '--force', doomed);
    const entry = page.locator(worktreeEntry(doomed));
    await expect(entry).toHaveAttribute('data-gone', 'true');
    await expect(page.locator(checkbox(doomed))).toHaveCount(0);
    expect((await listedWorktrees(page)).at(-1)).toBe(doomed);

    await typeLine(page, term, "echo STILL''-USABLE");
    await waitScreen(page, term, 'STILL-USABLE');

    await page.locator(termTab(term)).locator(byTestId(TID.termTabClose)).click();
    await confirmClose(page);
    await expect(entry).toHaveCount(0);
  });

  test('a checkbox checked in one page shows as checked in another', async ({ hub, page, context }) => {
    const { repo, worktrees } = makeRepoWith(hub, 'app', ['feat']);
    const feat = worktrees[0] ?? '';
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const other = await openPage(hub, context);
    await expect(other.page.locator(checkbox(feat))).not.toBeChecked();

    await page.locator(checkbox(feat)).check();
    await expect(other.page.locator(checkbox(feat))).toBeChecked();
    await expect(page.locator(checkbox(feat))).toBeChecked();
  });

  test('a worktree is selected from the keyboard', async ({ hub, page }) => {
    const { repo, worktrees } = makeRepoWith(hub, 'app', ['feat', 'other']);
    const [feat = '', other = ''] = worktrees;
    hub.writeRepos([repo]);
    await openUi(hub, page);
    await selectWorktree(page, repo);
    await page.locator(label(feat)).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator(worktreeEntry(feat))).toHaveAttribute('aria-selected', 'true');
    await page.locator(label(other)).focus();
    await page.keyboard.press('Space');
    await expect(page.locator(worktreeEntry(other))).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator(worktreeEntry(feat))).toHaveAttribute('aria-selected', 'false');
  });

  test('a click anywhere in a worktree row selects it: top and bottom edges, right of the label, above the checkbox', async ({
    hub,
    page,
  }) => {
    const { repo, worktrees } = makeRepoWith(hub, 'app', ['feat']);
    const feat = worktrees[0] ?? '';
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const row = page.locator(worktreeEntry(feat));
    const rowBox = await boxOf(row);
    const starBox = await boxOf(page.locator(checkbox(feat)));
    const points = [
      { x: rowBox.width / 2, y: 1 },
      { x: rowBox.width / 2, y: rowBox.height - 2 },
      { x: rowBox.width - 3, y: rowBox.height / 2 },
      { x: starBox.x - rowBox.x + starBox.width / 2, y: (starBox.y - rowBox.y) / 2 },
    ];
    for (const position of points) {
      await selectWorktree(page, repo);
      // The point must miss the label and the checkbox, or the test proves nothing.
      expect(
        await row.evaluate(
          (el, p) => document.elementFromPoint(el.getBoundingClientRect().x + p.x, el.getBoundingClientRect().y + p.y) === el,
          position,
        ),
      ).toBe(true);
      await row.click({ position });
      await expect(row, `click at ${JSON.stringify(position)}`).toHaveAttribute('aria-selected', 'true');
    }
    await expect(page.locator(checkbox(feat))).not.toBeChecked();
  });

  test("clicking a worktree's checkbox toggles it without selecting the worktree", async ({ hub, page }) => {
    const { repo, worktrees } = makeRepoWith(hub, 'app', ['feat']);
    const feat = worktrees[0] ?? '';
    hub.writeRepos([repo]);
    await openUi(hub, page);
    await selectWorktree(page, repo);
    await page.locator(checkbox(feat)).click();
    await expect(page.locator(checkbox(feat))).toBeChecked();
    await expect(page.locator(worktreeEntry(feat))).toHaveAttribute('aria-selected', 'false');
    await expect(page.locator(worktreeEntry(repo))).toHaveAttribute('aria-selected', 'true');
  });

  test('right-clicking a worktree row opens its menu without selecting it', async ({ hub, page }) => {
    const { repo, worktrees } = makeRepoWith(hub, 'app', ['feat']);
    const feat = worktrees[0] ?? '';
    hub.writeRepos([repo]);
    await openUi(hub, page);
    await selectWorktree(page, repo);
    await page.locator(worktreeEntry(feat)).click({ button: 'right' });
    await expect(page.locator(byTestId(TID.worktreeMenu))).toBeVisible();
    await expect(page.locator(worktreeEntry(feat))).toHaveAttribute('aria-selected', 'false');
    await expect(page.locator(worktreeEntry(repo))).toHaveAttribute('aria-selected', 'true');
  });

  test('worktree list changes show without user action', async ({ hub, page }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    await expect(page.locator(worktreeEntry(repo))).toBeVisible();
    const added = `${repo}.worktrees/late`;
    git(repo, 'worktree', 'add', '-q', '-b', 'late', added);
    await expect(page.locator(label(added))).toHaveText('late');
  });
});

test.describe('checked filter', () => {
  test('"checked only" persists across a reload, lists only checked worktrees and belongs to its repo', async ({ hub, page }) => {
    const { repo, worktrees } = makeRepoWith(hub, 'app', ['a', 'b', 'c']);
    const [a = '', b = '', c = ''] = worktrees;
    const second = makeRepoWith(hub, 'second', ['d']);
    const [d = ''] = second.worktrees;
    hub.writeRepos([repo, second.repo]);
    await openUi(hub, page);
    await selectWorktree(page, a);
    await page.locator(checkbox(a)).check();
    await page.locator(byTestId(TID.filterChecked)).check();
    await expect.poll(() => listedWorktrees(page)).toEqual([a]);

    await page.reload();
    await expect(page.locator(byTestId(TID.filterChecked))).toBeChecked();
    await expect(page.locator(worktreeEntry(a))).toBeVisible();
    expect(await listedWorktrees(page)).toEqual([a]);
    for (const hidden of [repo, b, c]) await expect(page.locator(worktreeEntry(hidden))).toHaveCount(0);

    // The other repo keeps showing all its worktrees.
    await selectRepo(page, second.repo);
    await expect(page.locator(byTestId(TID.filterChecked))).not.toBeChecked();
    await expect.poll(async () => (await listedWorktrees(page)).sort()).toEqual([second.repo, d].sort());

    // Turning it on there leaves the first repo's filter as it was.
    await page.locator(byTestId(TID.filterChecked)).check();
    await expect.poll(() => listedWorktrees(page)).toEqual([second.repo]);
    await page.locator(byTestId(TID.filterChecked)).uncheck();
    await expect.poll(async () => (await listedWorktrees(page)).sort()).toEqual([second.repo, d].sort());
    await selectRepo(page, repo);
    await expect(page.locator(byTestId(TID.filterChecked))).toBeChecked();
    expect(await listedWorktrees(page)).toEqual([a]);
  });

  for (const [name, tid] of [
    ['"Starred"', TID.filterChecked],
    ['"Open"', TID.filterOpen],
  ] as const) {
    test(`switching to a repo with another setting shows ${name} without animating it; a click animates`, async ({ hub, page }) => {
      const { repo } = makeRepoWith(hub, 'app', []);
      const second = makeRepoWith(hub, 'second', []);
      hub.writeRepos([repo, second.repo]);
      await openUi(hub, page);
      // Long transitions, so a running one is still running when checked.
      await page.addStyleTag({ content: '* , *::before, *::after { transition-duration: 10s !important; }' });
      const toggle = page.locator(byTestId(tid));
      const animating = (): Promise<boolean> =>
        toggle.evaluate((input) => input.getAnimations({ subtree: true }).some((a) => a.playState === 'running'));

      await toggle.check();
      expect(await animating()).toBe(true);

      await selectRepo(page, second.repo);
      await expect(toggle).not.toBeChecked();
      expect(await animating()).toBe(false);
      await selectRepo(page, repo);
      await expect(toggle).toBeChecked();
      expect(await animating()).toBe(false);
    });

    test(`a click does not animate ${name} when reduced motion is preferred`, async ({ hub, page }) => {
      const { repo } = makeRepoWith(hub, 'app', []);
      hub.writeRepos([repo]);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await openUi(hub, page);
      await page.addStyleTag({ content: '* , *::before, *::after { transition-duration: 10s !important; }' });
      const toggle = page.locator(byTestId(tid));

      await toggle.check();
      expect(await toggle.evaluate((input) => input.getAnimations({ subtree: true }).length)).toBe(0);
    });
  }

  test('the selected worktree stays listed and selected when unchecked under "checked only"', async ({ hub, page, wire }) => {
    const { repo, worktrees } = makeRepoWith(hub, 'app', ['a', 'b']);
    const [a = '', b = ''] = worktrees;
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const echoed = (path: string, checked: boolean, from: number): boolean =>
      wire.receivedFromHost(LOCAL, from).some((m) => m.t === 'checkedChanged' && m.worktree === path && m.checked === checked);
    const start = wire.markReceived();
    await page.locator(checkbox(a)).check();
    await page.locator(checkbox(b)).check();
    // Until the daemon confirms, a re-render shows the stored (unchecked) state again.
    await expect.poll(() => echoed(a, true, start) && echoed(b, true, start)).toBe(true);
    await selectWorktree(page, b);
    await page.locator(byTestId(TID.filterChecked)).check();
    await expect.poll(async () => (await listedWorktrees(page)).sort()).toEqual([a, b].sort());

    const from = wire.markReceived();
    await page.locator(checkbox(b)).uncheck();
    await expect.poll(() => echoed(b, false, from)).toBe(true);
    await expect(page.locator(worktreeEntry(b))).toHaveAttribute('aria-selected', 'true');
    expect((await listedWorktrees(page)).sort()).toEqual([a, b].sort());
    await expect(page.locator(checkbox(b))).not.toBeChecked();
  });

  test('a worktree checked and unchecked elsewhere joins and leaves the list without user action', async ({ hub, page }) => {
    const { repo, worktrees } = makeRepoWith(hub, 'app', ['b']);
    const [b = ''] = worktrees;
    hub.writeRepos([repo]);
    await openUi(hub, page);
    await selectWorktree(page, repo);
    await page.locator(byTestId(TID.filterChecked)).check();
    await expect.poll(() => listedWorktrees(page)).toEqual([repo]);

    const client = await watcher(hub, repo);
    await client.ok({ t: 'setChecked', worktree: b, checked: true });
    await expect.poll(async () => (await listedWorktrees(page)).sort()).toEqual([repo, b].sort());
    await client.ok({ t: 'setChecked', worktree: b, checked: false });
    await expect(page.locator(worktreeEntry(b))).toHaveCount(0);
  });
});

test.describe('"Open" filter', () => {
  const openSwitch = (page: Page): Locator => page.locator(byTestId(TID.filterOpen));
  const starredSwitch = (page: Page): Locator => page.locator(byTestId(TID.filterChecked));
  const sortedListed = async (page: Page): Promise<string[]> => (await listedWorktrees(page)).sort();
  const selectedEntry = (page: Page, path: string): Promise<void> =>
    expect(page.locator(worktreeEntry(path))).toHaveAttribute('aria-selected', 'true');
  /** Closes the terminal tab `term` of `page`, confirming the dialog. */
  const closeTab = async (page: Page, term: number): Promise<void> => {
    await page.locator(termTab(term)).locator(byTestId(TID.termTabClose)).click();
    await confirmClose(page);
  };
  const storedRecord = (page: Page, key: string): Promise<unknown> =>
    page.evaluate((k): unknown => JSON.parse(localStorage.getItem(k) ?? 'null'), key);

  test('lists the worktrees with terminals in any state, gone ones included, and the selected one', async ({ hub, page }) => {
    const { repo, worktrees } = makeRepoWith(hub, 'app', ['a', 'b', 'c', 'd', 'e']);
    const [a = '', b = '', c = '', d = '', e = ''] = worktrees;
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const openLabel = page.locator('label', { has: openSwitch(page) });
    await expect(openSwitch(page)).toHaveAttribute('aria-label', 'Show only worktrees with open terminals');
    await expect(openLabel).toHaveAttribute('title', 'Show only worktrees with open terminals');
    await expect(openLabel).toHaveText('Open');
    // Directly after "Starred".
    expect(
      await starredSwitch(page).evaluate(
        (input, open) => input.closest('label')?.nextElementSibling === open.closest('label'),
        await openSwitch(page).elementHandle(),
      ),
    ).toBe(true);
    const client = await watcher(hub, repo);
    await runIn(client, a, COMMANDS.ticker);
    await runIn(client, b, COMMANDS.ring);
    const failing = await runIn(client, c, COMMANDS.fail);
    await runIn(client, e, COMMANDS.ticker);
    await client.waitFor('termExited', (m) => m.termId === failing, { timeout: 10_000 });
    git(repo, 'worktree', 'remove', '--force', e);
    await expect(page.locator(worktreeEntry(e))).toHaveAttribute('data-gone', 'true');
    await expect.poll(() => markOf(page, worktreeEntry(b)), { timeout: 10_000 }).toBe('input');

    // Viewed, the failed exit shows the ring instead of a mark.
    await selectWorktree(page, c);
    await expect(page.locator(worktreeEntry(c)).locator(byTestId(TID.ring))).toHaveCount(1);
    await expect(page.locator(worktreeEntry(c)).locator(byTestId(TID.mark))).toHaveCount(0);

    await selectWorktree(page, a);
    await openSwitch(page).check();
    await expect.poll(() => sortedListed(page)).toEqual([a, b, c, e].sort());
    for (const hidden of [repo, d]) await expect(page.locator(worktreeEntry(hidden))).toHaveCount(0);
  });

  test('with "Starred" on too, lists only checked worktrees with terminals, and the selected one', async ({ hub, page }) => {
    const { repo, worktrees } = makeRepoWith(hub, 'app', ['a', 'b', 'c', 'd']);
    const [a = '', b = '', c = '', d = ''] = worktrees;
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const client = await watcher(hub, repo);
    await runIn(client, a, COMMANDS.quiet);
    await runIn(client, c, COMMANDS.quiet);
    await client.ok({ t: 'setChecked', worktree: a, checked: true });
    await client.ok({ t: 'setChecked', worktree: b, checked: true });
    await expect(page.locator(checkbox(b))).toBeChecked();
    await expect(page.locator(checkbox(a))).toBeChecked();
    await selectWorktree(page, d);

    await starredSwitch(page).check();
    await openSwitch(page).check();
    await expect.poll(() => sortedListed(page)).toEqual([a, d].sort());
  });

  test('a terminal created from another page lists its hidden worktree', async ({ hub, page, context }) => {
    const { repo, worktrees } = makeRepoWith(hub, 'app', ['b']);
    const [b = ''] = worktrees;
    hub.writeRepos([repo]);
    await openUi(hub, page);
    await selectWorktree(page, repo);
    await openSwitch(page).check();
    await expect.poll(() => listedWorktrees(page)).toEqual([repo]);

    const other = await openPage(hub, context);
    await selectWorktree(other.page, b);
    await ready(other.page, await newTerminal(other.page));
    await expect.poll(() => sortedListed(page)).toEqual([repo, b].sort());
  });

  test('the last terminal closed from another page removes a worktree that is not selected', async ({ hub, page, context }) => {
    const { repo, worktrees } = makeRepoWith(hub, 'app', ['b']);
    const [b = ''] = worktrees;
    hub.writeRepos([repo]);
    await openUi(hub, page);
    await selectWorktree(page, repo);
    const other = await openPage(hub, context);
    await selectWorktree(other.page, b);
    const term = await newTerminal(other.page);
    await ready(other.page, term);
    await openSwitch(page).check();
    await expect.poll(() => sortedListed(page)).toEqual([repo, b].sort());

    await closeTab(other.page, term);
    await expect(page.locator(worktreeEntry(b))).toHaveCount(0);
    expect(await listedWorktrees(page)).toEqual([repo]);
  });

  test('the selected worktree keeps its place when its last terminal closes, until another is selected', async ({ hub, page }) => {
    const { repo, worktrees } = makeRepoWith(hub, 'app', ['a', 'b']);
    const [a = '', b = ''] = worktrees;
    hub.writeRepos([repo]);
    await openUi(hub, page);
    await runIn(await watcher(hub, repo), a, COMMANDS.quiet);
    await selectWorktree(page, b);
    const term = await newTerminal(page);
    await ready(page, term);
    await openSwitch(page).check();
    await expect.poll(() => sortedListed(page)).toEqual([a, b].sort());

    await closeTab(page, term);
    await expect(page.locator(byTestId(TID.presetChoices))).toBeVisible();
    await selectedEntry(page, b);
    expect(await sortedListed(page)).toEqual([a, b].sort());

    await selectWorktree(page, a);
    await expect(page.locator(worktreeEntry(b))).toHaveCount(0);
    expect(await listedWorktrees(page)).toEqual([a]);
  });

  test('a selected gone worktree leaves with its last terminal, and the first worktree "Open" shows is selected', async ({ hub, page }) => {
    const { repo, worktrees } = makeRepoWith(hub, 'app', ['b', 'g']);
    const [b = '', g = ''] = worktrees;
    hub.writeRepos([repo]);
    await openUi(hub, page);
    await runIn(await watcher(hub, repo), b, COMMANDS.quiet);
    await selectWorktree(page, g);
    const term = await newTerminal(page);
    await ready(page, term);
    git(repo, 'worktree', 'remove', '--force', g);
    await expect(page.locator(worktreeEntry(g))).toHaveAttribute('data-gone', 'true');
    await openSwitch(page).check();
    await expect.poll(() => sortedListed(page)).toEqual([b, g].sort());

    await closeTab(page, term);
    await expect(page.locator(worktreeEntry(g))).toHaveCount(0);
    await selectedEntry(page, b);
    expect(await listedWorktrees(page)).toEqual([b]);
  });

  test('persists per repo across reloads and keeps a "Starred" setting stored before it', async ({ hub, page }) => {
    const { repo, worktrees } = makeRepoWith(hub, 'app', ['a', 'b']);
    const [a = '', b = ''] = worktrees;
    const second = makeRepoWith(hub, 'second', ['s']);
    hub.writeRepos([repo, second.repo]);
    await openUi(hub, page);
    const key = `${String(LOCAL)}:${repo}`;
    await page.evaluate((k) => {
      localStorage.setItem('wtd.filters', JSON.stringify({ [k]: 'checked' }));
    }, key);
    await page.reload();
    await expect(starredSwitch(page)).toBeChecked();
    await expect(openSwitch(page)).not.toBeChecked();

    const client = await watcher(hub, repo);
    await runIn(client, a, COMMANDS.quiet);
    await runIn(client, b, COMMANDS.quiet);
    await client.ok({ t: 'setChecked', worktree: a, checked: true });
    await expect(page.locator(checkbox(a))).toBeChecked();
    await selectWorktree(page, a);
    await openSwitch(page).check();
    await expect.poll(() => listedWorktrees(page)).toEqual([a]);
    expect(await storedRecord(page, 'wtd.filters')).toEqual({ [key]: 'checked' });

    await page.reload();
    await expect(starredSwitch(page)).toBeChecked();
    await expect(openSwitch(page)).toBeChecked();
    await expect.poll(() => listedWorktrees(page)).toEqual([a]);

    await selectRepo(page, second.repo);
    await expect(starredSwitch(page)).not.toBeChecked();
    await expect(openSwitch(page)).not.toBeChecked();

    await selectRepo(page, repo);
    await openSwitch(page).uncheck();
    await expect(starredSwitch(page)).toBeChecked();
    await page.reload();
    await expect(starredSwitch(page)).toBeChecked();
    await expect(openSwitch(page)).not.toBeChecked();
    await expect.poll(() => listedWorktrees(page)).toEqual([a]);
  });

  test('its on colour differs from the star and from every attention mark', async ({ hub, page }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openUi(hub, page);
    const knob = (toggle: Locator): Promise<string> => toggle.evaluate((input) => getComputedStyle(input, '::after').backgroundColor);
    const off = await knob(openSwitch(page));
    await starredSwitch(page).check();
    const star = await knob(starredSwitch(page));
    await openSwitch(page).check();
    const on = await knob(openSwitch(page));

    expect(on).not.toBe(off);
    // The star, then the needs-input, failed-exit, done and new-output marks.
    for (const taken of [star, 'rgb(245, 196, 81)', 'rgb(229, 192, 123)', DANGER, 'rgb(35, 209, 139)', 'rgb(59, 142, 234)'])
      expect(on).not.toBe(taken);
  });

  test('at the minimum sidebar width both switches lie wholly inside the sidebar and toggle on click', async ({ hub, page }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    await page.evaluate(() => {
      localStorage.setItem('wtd.sidebarWidth', '160');
    });
    await page.reload();
    await expect(page.locator(byTestId(TID.sidebarResizer))).toHaveAttribute('aria-valuenow', '160');
    const sidebar = await boxOf(page.getByRole('navigation'));

    for (const toggle of [starredSwitch(page), openSwitch(page)]) {
      const box = await boxOf(toggle);
      expect(box.width).toBeGreaterThan(0);
      expect(box.height).toBeGreaterThan(0);
      expect(box.x).toBeGreaterThanOrEqual(sidebar.x);
      expect(box.y).toBeGreaterThanOrEqual(sidebar.y);
      expect(box.x + box.width).toBeLessThanOrEqual(sidebar.x + sidebar.width);
      expect(box.y + box.height).toBeLessThanOrEqual(sidebar.y + sidebar.height);
    }
    await starredSwitch(page).click();
    await expect(starredSwitch(page)).toBeChecked();
    await expect(openSwitch(page)).not.toBeChecked();
    await openSwitch(page).click();
    await expect(openSwitch(page)).toBeChecked();
    await expect(starredSwitch(page)).toBeChecked();
  });
});

test.describe('default selection', () => {
  const openSwitch = (page: Page): Locator => page.locator(byTestId(TID.filterOpen));
  const selectedEntry = (page: Page, path: string): Promise<void> =>
    expect(page.locator(worktreeEntry(path))).toHaveAttribute('aria-selected', 'true');

  test('follows the switches: turning "Open" on selects the first worktree with a terminal', async ({ hub, page }) => {
    const { repo, worktrees } = makeRepoWith(hub, 'app', ['a', 'b']);
    const [, b = ''] = worktrees;
    hub.writeRepos([repo]);
    await openUi(hub, page);
    await selectedEntry(page, repo);
    await runIn(await watcher(hub, repo), b, COMMANDS.quiet);
    await expect(page.locator(worktreeEntry(b)).locator(byTestId(TID.ring))).toHaveCount(1);
    await selectedEntry(page, repo);

    await openSwitch(page).check();
    await selectedEntry(page, b);
  });

  test('stays selected and listed when its last terminal closes', async ({ hub, page }) => {
    const { repo, worktrees } = makeRepoWith(hub, 'app', ['a', 'b']);
    const [, b = ''] = worktrees;
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const client = await watcher(hub, repo);
    const term = await runIn(client, b, COMMANDS.quiet);
    await openSwitch(page).check();
    await selectedEntry(page, b);

    await client.ok({ t: 'closeTerm', termId: term });
    await expect(page.locator(worktreeEntry(b)).locator(byTestId(TID.ring))).toHaveCount(0);
    await selectedEntry(page, b);
    expect(await listedWorktrees(page)).toEqual([b]);
  });

  test('stays selected and listed when it is unchecked under "Starred"', async ({ hub, page, wire }) => {
    const { repo, worktrees } = makeRepoWith(hub, 'app', ['a', 'b', 'c']);
    const [, b = '', c = ''] = worktrees;
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const client = await watcher(hub, repo);
    await client.ok({ t: 'setChecked', worktree: b, checked: true });
    await client.ok({ t: 'setChecked', worktree: c, checked: true });
    await expect(page.locator(checkbox(c))).toBeChecked();
    await page.locator(byTestId(TID.filterChecked)).check();
    await selectedEntry(page, b);

    const from = wire.markReceived();
    await client.ok({ t: 'setChecked', worktree: b, checked: false });
    await expect
      .poll(() => wire.receivedFromHost(LOCAL, from).some((m) => m.t === 'checkedChanged' && m.worktree === b && !m.checked))
      .toBe(true);
    await selectedEntry(page, b);
    await expect(page.locator(checkbox(b))).not.toBeChecked();
    expect((await listedWorktrees(page)).sort()).toEqual([b, c].sort());
  });
});

test.describe('name search', () => {
  test('lists the worktrees whose label contains the text, belongs to its repo, persists, and × empties it', async ({ hub, page }) => {
    const { repo, worktrees } = makeRepoWith(hub, 'app', ['feature/login', 'fix/Logout', 'docs']);
    const [login = '', logout = '', docs = ''] = worktrees;
    const second = makeRepoWith(hub, 'second', ['logbook']);
    const [logbook = ''] = second.worktrees;
    hub.writeRepos([repo, second.repo]);
    await openUi(hub, page);
    await selectWorktree(page, docs);
    const search = page.locator(byTestId(TID.worktreeSearch));
    const clear = page.locator(byTestId(TID.worktreeSearchClear));
    await expect(clear).toHaveCount(0);

    // Ignores case; the selected worktree stays listed although it does not match.
    await search.fill('LOG');
    await expect.poll(async () => (await listedWorktrees(page)).sort()).toEqual([login, logout, docs].sort());
    await selectWorktree(page, login);
    await search.fill('log');
    await expect.poll(async () => (await listedWorktrees(page)).sort()).toEqual([login, logout].sort());
    await search.fill('login');
    await expect.poll(() => listedWorktrees(page)).toEqual([login]);

    await page.reload();
    await expect(search).toHaveValue('login');
    await expect.poll(() => listedWorktrees(page)).toEqual([login]);

    // The other repo has no search of its own; searching there leaves the first repo's.
    await selectRepo(page, second.repo);
    await expect(search).toHaveValue('');
    await expect.poll(async () => (await listedWorktrees(page)).sort()).toEqual([second.repo, logbook].sort());
    await selectWorktree(page, logbook);
    await search.fill('book');
    await expect.poll(() => listedWorktrees(page)).toEqual([logbook]);
    await selectRepo(page, repo);
    await expect(search).toHaveValue('login');
    await expect.poll(() => listedWorktrees(page)).toEqual([login]);

    await clear.click();
    await expect(search).toHaveValue('');
    await expect(search).toBeFocused();
    await expect(clear).toHaveCount(0);
    await expect.poll(async () => (await listedWorktrees(page)).sort()).toEqual([repo, login, logout, docs].sort());
    await page.reload();
    await expect(search).toHaveValue('');
    await selectRepo(page, second.repo);
    await expect(search).toHaveValue('book');
  });

  test('a refused storage write still narrows the list and is reported on the page', async ({ hub, page }) => {
    const { repo, worktrees } = makeRepoWith(hub, 'app', ['feat', 'docs']);
    const [feat = ''] = worktrees;
    hub.writeRepos([repo]);
    await page.addInitScript(() => {
      // eslint-disable-next-line @typescript-eslint/unbound-method -- called below with each storage as `this`
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (this: Storage, key: string, value: string): void {
        if (key === 'wtd.searches') throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
        setItem.call(this, key, value);
      };
    });
    await openUi(hub, page);
    await selectWorktree(page, feat);
    await page.locator(byTestId(TID.worktreeSearch)).fill('fea');
    await expect.poll(() => listedWorktrees(page)).toEqual([feat]);
    await expect(page.locator(byTestId(TID.notice))).toContainText("Saving the page's settings failed: The quota has been exceeded.");
  });

  test('applies together with "checked only"', async ({ hub, page }) => {
    const { repo, worktrees } = makeRepoWith(hub, 'app', ['feat-a', 'feat-b', 'other']);
    const [a = '', b = '', other = ''] = worktrees;
    hub.writeRepos([repo]);
    await openUi(hub, page);
    await selectWorktree(page, a);
    await page.locator(checkbox(a)).check();
    await page.locator(checkbox(other)).check();
    await page.locator(byTestId(TID.worktreeSearch)).fill('feat');
    await expect.poll(async () => (await listedWorktrees(page)).sort()).toEqual([a, b].sort());
    await page.locator(byTestId(TID.filterChecked)).check();
    await expect.poll(() => listedWorktrees(page)).toEqual([a]);
  });
});

test.describe('sidebar width', () => {
  test('dragging the sidebar edge resizes the sidebar within bounds, arrow keys nudge it, and the width survives a reload', async ({
    hub,
    page,
  }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const sidebar = page.getByRole('navigation');
    const resizer = page.locator(byTestId(TID.sidebarResizer));
    const dragTo = async (x: number): Promise<void> => {
      const box = await resizer.boundingBox();
      if (box === null) throw new Error('the sidebar resizer is not shown');
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(x, box.y + box.height / 2, { steps: 5 });
      await page.mouse.up();
    };
    const sidebarWidth = async (): Promise<number> => (await sidebar.boundingBox())?.width ?? 0;
    const left = (await sidebar.boundingBox())?.x ?? 0;

    await expect(resizer).toHaveAttribute('aria-valuenow', '260');
    await dragTo(left + 400);
    await expect(resizer).toHaveAttribute('aria-valuenow', '400');
    expect(await sidebarWidth()).toBe(400);
    const terminals = page.locator('.terminal-pane');
    expect((await terminals.boundingBox())?.x).toBe(left + 400);

    await dragTo(left + 20);
    await expect(resizer).toHaveAttribute('aria-valuenow', '160');
    await dragTo(left + 5000);
    await expect(resizer).toHaveAttribute('aria-valuenow', '640');

    await dragTo(left + 400);
    await resizer.focus();
    await page.keyboard.press('ArrowRight');
    await expect(resizer).toHaveAttribute('aria-valuenow', '416');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await expect(resizer).toHaveAttribute('aria-valuenow', '384');

    await page.reload();
    await expect(resizer).toHaveAttribute('aria-valuenow', '384');
    expect(await sidebarWidth()).toBe(384);
  });
});

test.describe('worktree status and deletion', () => {
  /** Gives `repo` a bare `origin` holding its `main`, with `origin/HEAD` pointing at it; returns the origin's path. */
  const withOrigin = (hub: HubHost, repo: string): string => {
    const origin = join(hub.dir, 'origin.git');
    git(hub.dir, 'init', '-q', '--bare', '-b', 'main', origin);
    git(repo, 'remote', 'add', 'origin', origin);
    git(repo, 'push', '-q', 'origin', 'main');
    git(repo, 'remote', 'set-head', 'origin', 'main');
    return origin;
  };

  const commit = (cwd: string, file: string): void => {
    writeFileSync(join(cwd, file), file);
    git(cwd, 'add', file);
    git(cwd, 'commit', '-q', '-m', file);
  };

  /** Asks to delete `path` and waits for the confirmation. */
  const askToDelete = async (page: Page, path: string): Promise<Locator> => {
    await page.locator(worktreeEntry(path)).click({ button: 'right' });
    await page.locator(byTestId(TID.deleteWorktree)).click();
    const dialog = page.locator(byTestId(TID.confirmDialog));
    await expect(dialog).toBeVisible();
    return dialog;
  };

  const titleOf = async (page: Page, path: string): Promise<string> =>
    (await page.locator(worktreeEntry(path)).getAttribute('title')) ?? '';

  test('hovering a worktree shows its path and what each of its terminals is doing', async ({ hub, page }) => {
    const { repo, worktrees } = makeRepoWith(hub, 'app', ['feat']);
    const feat = worktrees[0] ?? '';
    hub.writeRepos([repo]);
    await openUi(hub, page);
    await expect.poll(() => titleOf(page, feat)).toBe(`${feat}\nno terminals`);

    const client = await watcher(hub, repo);
    const ticker = await runIn(client, feat, COMMANDS.ticker);
    await expect.poll(() => titleOf(page, feat), { timeout: 10_000 }).toBe(`${feat}\nprobe ${String(ticker)}: running`);
    const failing = await runIn(client, feat, COMMANDS.fail);
    await expect
      .poll(() => titleOf(page, feat), { timeout: 10_000 })
      .toBe(`${feat}\nprobe ${String(ticker)}: running\nprobe ${String(failing)}: exited with code 1`);
  });

  test('deleting a clean worktree in the local main without running terminals asks nothing', async ({ hub, page }) => {
    const { repo, worktrees } = makeRepoWith(hub, 'app', ['feat']);
    const feat = worktrees[0] ?? '';
    hub.writeRepos([repo]);
    await openUi(hub, page);
    await page.locator(worktreeEntry(feat)).click({ button: 'right' });
    await page.locator(byTestId(TID.worktreeMenu)).locator(byTestId(TID.deleteWorktree)).click();
    await expect(page.locator(worktreeEntry(feat))).toHaveCount(0);
    expect(existsSync(feat)).toBe(false);
    await expect(page.locator(byTestId(TID.confirmDialog))).toHaveCount(0);
    await expect(page.locator(byTestId(TID.worktreeMenu))).toHaveCount(0);
    expect(git(repo, 'branch', '--list', 'feat')).toContain('feat');
  });

  test('deleting a worktree at risk names every reason, keeps it on cancel and deletes it on confirm', async ({ hub, page }) => {
    const { repo, worktrees } = makeRepoWith(hub, 'app', ['feat']);
    const feat = worktrees[0] ?? '';
    withOrigin(hub, repo);
    writeFileSync(join(feat, 'a'), 'a');
    git(feat, 'add', 'a');
    git(feat, 'commit', '-q', '-m', 'a');
    writeFileSync(join(feat, 'untracked'), 'new');
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const client = await watcher(hub, repo);
    const ticker = await runIn(client, feat, COMMANDS.ticker);
    await expect.poll(() => titleOf(page, feat), { timeout: 10_000 }).toContain(`probe ${String(ticker)}`);
    const dialog = page.locator(byTestId(TID.confirmDialog));
    const remove = async (): Promise<void> => {
      await page.locator(worktreeEntry(feat)).click({ button: 'right' });
      await page.locator(byTestId(TID.deleteWorktree)).click();
      await expect(dialog).toBeVisible();
    };

    await remove();
    await expect(dialog.locator(byTestId(TID.confirmReason))).toHaveText([
      'It has 1 commit not in main or origin/main.',
      'It has 1 uncommitted change, untracked files included.',
      `Running terminals will be closed: probe ${String(ticker)}.`,
    ]);
    await expect(dialog.locator(byTestId(TID.confirmNote))).toHaveText('Its branch is kept.');
    await dialog.locator(byTestId(TID.confirmCancel)).click();
    await expect(dialog).toHaveCount(0);
    expect(existsSync(feat)).toBe(true);

    await remove();
    const from = client.mark();
    await dialog.locator(byTestId(TID.confirmOk)).click();
    await expect(page.locator(worktreeEntry(feat))).toHaveCount(0);
    expect(existsSync(feat)).toBe(false);
    await client.waitFor('termClosed', (m) => m.termId === ticker, { from });
    expect(git(repo, 'rev-parse', 'feat')).toMatch(/^[0-9a-f]{40}$/);
  });

  test("the deletion dialog is framed 3px in red; a repo removal's is not", async ({ hub, page }) => {
    const { repo, worktrees } = makeRepoWith(hub, 'app', ['feat']);
    const feat = worktrees[0] ?? '';
    withOrigin(hub, repo);
    writeFileSync(join(feat, 'untracked'), 'new');
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const dialog = page.locator(byTestId(TID.confirmDialog));
    await page.locator(worktreeEntry(feat)).click({ button: 'right' });
    await page.locator(byTestId(TID.deleteWorktree)).click();
    await expect(dialog).toBeVisible();
    expect(await borderOf(dialog)).toEqual(Array(4).fill(`3px ${DANGER}`));
    await dialog.locator(byTestId(TID.confirmCancel)).click();

    await page.locator(repoTab(repo)).locator(byTestId(TID.removeRepo)).click();
    await expect(dialog).toBeVisible();
    expect((await borderOf(dialog)).every((side) => side.startsWith('1px ') && !side.endsWith(DANGER))).toBe(true);
  });

  test('deleting a detached worktree with commits says they become unreachable and names its head', async ({ hub, page }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    withOrigin(hub, repo);
    const detached = detachedWorktree(repo, 'loose');
    writeFileSync(join(detached.path, 'a'), 'a');
    git(detached.path, 'add', 'a');
    git(detached.path, 'commit', '-q', '-m', 'a');
    hub.writeRepos([repo]);
    await openUi(hub, page);
    await page.locator(worktreeEntry(detached.path)).click({ button: 'right' });
    await page.locator(byTestId(TID.deleteWorktree)).click();
    const dialog = page.locator(byTestId(TID.confirmDialog));
    await expect(dialog.locator(byTestId(TID.confirmReason))).toHaveText(['It has 1 commit not in main or origin/main.']);
    const head = git(detached.path, 'rev-parse', '--short=7', 'HEAD');
    await expect(dialog.locator(byTestId(TID.confirmNote))).toHaveText(
      `It has no branch: once it is deleted, its commits not in main or origin/main become unreachable; its head is ${head}.`,
    );
  });

  test("deleting a worktree whose remote cannot be reached says the fetch failed and git's reason", async ({ hub, page }) => {
    const { repo, worktrees } = makeRepoWith(hub, 'app', ['feat']);
    const feat = worktrees[0] ?? '';
    const origin = withOrigin(hub, repo);
    commit(feat, 'a');
    rmSync(origin, { recursive: true });
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const dialog = await askToDelete(page, feat);
    await expect(dialog.locator(byTestId(TID.confirmReason))).toHaveText([
      "It has 1 commit not in main or origin/main as last fetched; couldn't compare with a fresh origin/main because the fetch failed: " +
        `fatal: '${origin}' does not appear to be a git repository.`,
    ]);
    await expect(dialog.locator(byTestId(TID.confirmNote))).toHaveText('Its branch is kept.');
  });

  test('deleting a worktree branched off feature-x names feature-x first among the bases', async ({ hub, page }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    withOrigin(hub, repo);
    git(repo, 'branch', 'feature-x');
    git(repo, 'push', '-q', 'origin', 'feature-x');
    const feat = join(hub.dir, 'repos', 'app.worktrees', 'feat');
    git(repo, 'worktree', 'add', '-q', '-b', 'feat', feat, 'feature-x');
    commit(feat, 'a');
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const dialog = await askToDelete(page, feat);
    await expect(dialog.locator(byTestId(TID.confirmReason))).toHaveText([
      'It has 1 commit not in feature-x, origin/feature-x, main or origin/main.',
    ]);
    await expect(dialog.locator(byTestId(TID.confirmNote))).toHaveText('Its branch is kept.');
  });

  test('deleting a worktree without a base says there is no base branch to check', async ({ hub, page }) => {
    const { repo, worktrees } = makeRepoWith(hub, 'app', ['feat']);
    const feat = worktrees[0] ?? '';
    git(repo, 'branch', '-m', 'main', 'trunk');
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const dialog = await askToDelete(page, feat);
    await expect(dialog.locator(byTestId(TID.confirmReason))).toHaveText(['There is no base branch to check that its commits are merged.']);
    await expect(dialog.locator(byTestId(TID.confirmNote))).toHaveText('Its branch is kept.');
  });

  test("a failed fetch's reason is shown as text, not markup", async ({ hub, page }) => {
    const { repo, worktrees } = makeRepoWith(hub, 'app', ['feat']);
    const feat = worktrees[0] ?? '';
    withOrigin(hub, repo);
    extOrigin(repo, hub.dir, "echo '<b>denied</b> by <i>remote</i>' >&2; exit 1");
    commit(feat, 'a');
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const reason = (await askToDelete(page, feat)).locator(byTestId(TID.confirmReason));
    await expect(reason).toHaveText([
      "It has 1 commit not in main or origin/main as last fetched; couldn't compare with a fresh origin/main because the fetch failed: " +
        '<b>denied</b> by <i>remote</i>.',
    ]);
    await expect(reason.locator('b, i')).toHaveCount(0);
  });

  test('right-clicking the main worktree opens no menu and closes an open one', async ({ hub, page }) => {
    const { repo, worktrees } = makeRepoWith(hub, 'app', ['feat']);
    const feat = worktrees[0] ?? '';
    hub.writeRepos([repo]);
    await openUi(hub, page);
    await page.locator(worktreeEntry(repo)).click({ button: 'right' });
    await expect(page.locator(byTestId(TID.worktreeMenu))).toHaveCount(0);
    await page.locator(worktreeEntry(feat)).click({ button: 'right' });
    await expect(page.locator(byTestId(TID.worktreeMenu))).toBeVisible();
    await page.locator(worktreeEntry(repo)).click({ button: 'right' });
    await expect(page.locator(byTestId(TID.worktreeMenu))).toHaveCount(0);
  });

  test('Escape closes the worktree menu', async ({ hub, page }) => {
    const { repo, worktrees } = makeRepoWith(hub, 'app', ['feat']);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    await page.locator(worktreeEntry(worktrees[0] ?? '')).click({ button: 'right' });
    await page.locator(byTestId(TID.worktreeMenu)).press('Escape');
    await expect(page.locator(byTestId(TID.worktreeMenu))).toHaveCount(0);
  });
});
