import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeRepo } from '../support/daemon-host.js';
import { byTestId, repoTab, TID, worktreeEntry } from './contract.js';
import { expect, listedWorktrees, makeRepoWith, openUi, selectRepo, selectWorktree, test } from './fixture.js';

test.describe('repo tabs', () => {
  test('duplicate names are disambiguated with leading segments, in hub order, with the path on hover', async ({ hub, page }) => {
    const one = makeRepo(join(hub.dir, 'a', 'x', 'app'));
    const two = makeRepo(join(hub.dir, 'b', 'y', 'app'));
    hub.writeRepos([one, two]);
    await openUi(hub, page);
    const tabs = page.locator(byTestId(TID.repoTab));
    await expect(tabs).toHaveText(['x/app', 'y/app']);
    expect(await tabs.evaluateAll((elements) => elements.map((e) => e.getAttribute('title')))).toEqual([one, two]);
  });

  test('a repo whose watch fails shows the error and its path', async ({ hub, page }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    const plain = join(hub.dir, 'plain');
    mkdirSync(plain);
    hub.writeRepos([repo, plain]);
    await openUi(hub, page);
    await selectRepo(page, plain);
    const error = page.locator(byTestId(TID.repoError));
    await expect(error).toContainText('not-a-repo');
    await expect(error).toContainText(plain);
  });
});

test.describe('selection', () => {
  test('the selected repo tab and worktree are restored after a reload', async ({ hub, page }) => {
    const first = makeRepoWith(hub, 'one', ['f1']);
    const second = makeRepoWith(hub, 'two', ['s1', 's2']);
    hub.writeRepos([first.repo, second.repo]);
    await openUi(hub, page);
    await selectRepo(page, second.repo);
    const target = second.worktrees[1] ?? '';
    await selectWorktree(page, target);

    await page.reload();
    await expect(page.locator(repoTab(second.repo))).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator(worktreeEntry(target))).toHaveAttribute('aria-selected', 'true');
  });

  test('a repo without a stored selection selects its first listed worktree', async ({ hub, page }) => {
    const first = makeRepoWith(hub, 'one', ['f1']);
    const second = makeRepoWith(hub, 'two', ['s1']);
    hub.writeRepos([first.repo, second.repo]);
    await openUi(hub, page);
    await expect(page.locator(repoTab(first.repo))).toHaveAttribute('aria-selected', 'true');
    const listed = await listedWorktrees(page);
    expect(listed[0]).toBe(first.repo);
    await expect(page.locator(worktreeEntry(first.repo))).toHaveAttribute('aria-selected', 'true');

    await selectRepo(page, second.repo);
    await expect(page.locator(worktreeEntry(second.repo))).toHaveAttribute('aria-selected', 'true');
  });
});
