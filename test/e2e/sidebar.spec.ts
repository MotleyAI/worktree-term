import { fakeWorktrees, git } from '../support/daemon-host.js';
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
  test('"checked only" persists across a reload, lists only checked worktrees and applies to every repo', async ({ hub, page }) => {
    const { repo, worktrees } = makeRepoWith(hub, 'app', ['a', 'b', 'c']);
    const [a = '', b = '', c = ''] = worktrees;
    const second = makeRepoWith(hub, 'second', []);
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

    await selectRepo(page, second.repo);
    await expect(page.locator(byTestId(TID.filterChecked))).toBeChecked();
    // Nothing checked there: its first worktree is selected and listed.
    await expect(page.locator(worktreeEntry(second.repo))).toHaveAttribute('aria-selected', 'true');
    expect(await listedWorktrees(page)).toEqual([second.repo]);
  });

  test('the selected worktree stays listed and selected when unchecked under "checked only"', async ({ hub, page, wire }) => {
    const { repo, worktrees } = makeRepoWith(hub, 'app', ['a', 'b']);
    const [a = '', b = ''] = worktrees;
    hub.writeRepos([repo]);
    await openUi(hub, page);
    await page.locator(checkbox(a)).check();
    await page.locator(checkbox(b)).check();
    await selectWorktree(page, b);
    await page.locator(byTestId(TID.filterChecked)).check();
    await expect.poll(async () => (await listedWorktrees(page)).sort()).toEqual([a, b].sort());

    const from = wire.markReceived();
    await page.locator(checkbox(b)).uncheck();
    await expect
      .poll(() => wire.receivedFromHost(LOCAL, from).some((m) => m.t === 'checkedChanged' && m.worktree === b && !m.checked))
      .toBe(true);
    await expect(page.locator(worktreeEntry(b))).toHaveAttribute('aria-selected', 'true');
    expect((await listedWorktrees(page)).sort()).toEqual([a, b].sort());
    await expect(page.locator(checkbox(b))).not.toBeChecked();
  });
});
