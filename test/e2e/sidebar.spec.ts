import { existsSync, writeFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { join } from 'node:path';
import type { HubHost } from '../support/hub-host.js';
import { fakeWorktrees, git } from '../support/daemon-host.js';
import { COMMANDS, runIn } from './attention-helpers.js';
import { byTestId, termTab, TID, worktreeEntry } from './contract.js';
import {
  confirmClose,
  detachedWorktree,
  expect,
  listedWorktrees,
  LOCAL,
  makeRepoWith,
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

const label = (path: string): string => `${worktreeEntry(path)} ${byTestId(TID.worktreeLabel)}`;
const checkbox = (path: string): string => `${worktreeEntry(path)} input[type="checkbox"]`;

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
    const { repo, worktrees } = makeRepoWith(hub, 'app', ['feat']);
    const feat = worktrees[0] ?? '';
    hub.writeRepos([repo]);
    await openUi(hub, page);
    await page.locator(label(feat)).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator(worktreeEntry(feat))).toHaveAttribute('aria-selected', 'true');
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

  test('switching to a repo with another filter shows its switch without animating it; a click animates', async ({ hub, page }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    const second = makeRepoWith(hub, 'second', []);
    hub.writeRepos([repo, second.repo]);
    await openUi(hub, page);
    // Long transitions, so a running one is still running when checked.
    await page.addStyleTag({ content: '* , *::before, *::after { transition-duration: 10s !important; }' });
    const toggle = page.locator(byTestId(TID.filterChecked));
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
  /** Gives `repo` a bare `origin` holding its `main`, with `origin/HEAD` pointing at it. */
  const withOrigin = (hub: HubHost, repo: string): void => {
    const origin = join(hub.dir, 'origin.git');
    git(hub.dir, 'init', '-q', '--bare', '-b', 'main', origin);
    git(repo, 'remote', 'add', 'origin', origin);
    git(repo, 'push', '-q', 'origin', 'main');
    git(repo, 'remote', 'set-head', 'origin', 'main');
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

  test('deleting a merged, clean worktree without running terminals asks nothing', async ({ hub, page }) => {
    const { repo, worktrees } = makeRepoWith(hub, 'app', ['feat']);
    const feat = worktrees[0] ?? '';
    withOrigin(hub, repo);
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
      'It has 1 commit not in origin/main.',
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

  test('deleting a detached worktree with commits says they are left only in the reflog', async ({ hub, page }) => {
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
    await expect(dialog.locator(byTestId(TID.confirmReason))).toHaveText(['It has 1 commit not in origin/main.']);
    await expect(dialog.locator(byTestId(TID.confirmNote))).toContainText('reachable only through the reflog');
  });

  test('the main worktree cannot be deleted, and Escape closes the menu', async ({ hub, page }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    await page.locator(worktreeEntry(repo)).click({ button: 'right' });
    const item = page.locator(byTestId(TID.deleteWorktree));
    await expect(item).toBeDisabled();
    await expect(item).toHaveAttribute('title', 'The main worktree cannot be deleted');
    await page.locator(byTestId(TID.worktreeMenu)).press('Escape');
    await expect(page.locator(byTestId(TID.worktreeMenu))).toHaveCount(0);
  });
});
