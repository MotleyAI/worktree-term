import { COMMANDS, expectCounts, expectMark, runIn } from './attention-helpers.js';
import { pane, repoTab, terminalBox, termTab, worktreeEntry } from './contract.js';
import { expect, LOCAL, makeRepoWith, openUi, selectRepo, selectWorktree, test, watcher } from './fixture.js';
import { leaf, split, storeTabs } from './panes.js';

test.describe('attention marks', () => {
  test('a bell in a hidden worktree of a non-selected repo marks its repo tab and worktree row as needing input', async ({ hub, page }) => {
    const app = makeRepoWith(hub, 'app', []);
    const other = makeRepoWith(hub, 'other', ['feat']);
    const feat = other.worktrees[0] ?? '';
    hub.writeRepos([app.repo, other.repo]);
    await openUi(hub, page);
    await expect(page.locator(repoTab(app.repo))).toHaveAttribute('aria-selected', 'true');
    const client = await watcher(hub, other.repo);
    await runIn(client, feat, COMMANDS.ring);

    await expectMark(page, repoTab(other.repo), 'input');
    await expectMark(page, repoTab(app.repo), null);
    await selectRepo(page, other.repo);
    await expect(page.locator(worktreeEntry(other.repo))).toHaveAttribute('aria-selected', 'true');
    await expectMark(page, worktreeEntry(feat), 'input');
    await expectMark(page, worktreeEntry(other.repo), null);
  });

  test('new output of a hidden terminal marks its row and repo tab, and selecting its worktree clears every mark', async ({
    hub,
    page,
  }) => {
    const { repo, worktrees } = makeRepoWith(hub, 'app', ['feat']);
    const feat = worktrees[0] ?? '';
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const client = await watcher(hub, repo);
    const term = await runIn(client, feat, COMMANDS.ticker);

    await expectMark(page, worktreeEntry(feat), 'output');
    await expectMark(page, repoTab(repo), 'output');
    await selectWorktree(page, feat);
    await expect(page.locator(terminalBox(LOCAL, term))).toBeVisible();
    await expectMark(page, termTab(term), null);
    await expectMark(page, pane(term), null);
    await expectMark(page, worktreeEntry(feat), null);
    await expectMark(page, repoTab(repo), null);
  });

  test('a terminal tab shows the new-output mark of its hidden terminal until the tab is chosen', async ({ hub, page }) => {
    const { repo, worktrees } = makeRepoWith(hub, 'app', ['feat']);
    const feat = worktrees[0] ?? '';
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const client = await watcher(hub, repo);
    const shown = await runIn(client, feat, COMMANDS.quiet);
    const hidden = await runIn(client, feat, COMMANDS.ticker);
    await storeTabs(client, feat, [leaf(shown), leaf(hidden)], 0);
    await selectWorktree(page, feat);
    await expect(page.locator(terminalBox(LOCAL, shown))).toBeVisible();

    await expectMark(page, termTab(hidden), 'output');
    await expectMark(page, termTab(shown), null);
    await page.locator(termTab(hidden)).click();
    await expect(page.locator(terminalBox(LOCAL, hidden))).toBeVisible();
    await expectMark(page, termTab(hidden), null);
    await expectMark(page, worktreeEntry(feat), null);
  });

  test('a hidden terminal exiting with code 1 marks its tab failed, and its row until it is viewed', async ({ hub, page }) => {
    const { repo, worktrees } = makeRepoWith(hub, 'app', ['feat']);
    const feat = worktrees[0] ?? '';
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const client = await watcher(hub, repo);
    const shown = await runIn(client, feat, COMMANDS.quiet);
    const failing = await runIn(client, feat, COMMANDS.fail);
    await storeTabs(client, feat, [leaf(shown), leaf(failing)], 0);
    await selectWorktree(page, feat);
    await expect(page.locator(terminalBox(LOCAL, shown))).toBeVisible();
    await client.waitFor('termExited', (m) => m.termId === failing, { timeout: 10_000 });

    await expectMark(page, termTab(failing), 'failed');
    await expect(page.locator(termTab(failing))).toContainText('exited');
    await expectMark(page, worktreeEntry(feat), 'failed');
    await expectMark(page, repoTab(repo), 'failed');

    await page.locator(termTab(failing)).click();
    await expect(page.locator(terminalBox(LOCAL, failing))).toBeVisible();
    await expectMark(page, worktreeEntry(feat), null);
    await expectMark(page, repoTab(repo), null);
    await expectMark(page, termTab(failing), 'failed');
    // A lone pane has no header: its tab carries the mark.
    await expectMark(page, pane(failing), null);
  });

  test('a hidden terminal that printed and then stayed quiet for 3 s is marked done', async ({ hub, page }) => {
    const { repo, worktrees } = makeRepoWith(hub, 'app', ['feat']);
    const feat = worktrees[0] ?? '';
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const client = await watcher(hub, repo);
    await runIn(client, feat, COMMANDS.oneLine);
    await expectMark(page, worktreeEntry(feat), 'done');
    await expectCounts(page, worktreeEntry(feat), { done: 1 });
    await expectMark(page, repoTab(repo), 'done');
  });

  test('a worktree row and repo tab show the first-ranked mark with counts per mark, following events by themselves', async ({
    hub,
    page,
  }) => {
    const { repo, worktrees } = makeRepoWith(hub, 'app', ['feat']);
    const feat = worktrees[0] ?? '';
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const client = await watcher(hub, repo);
    const ringing = await runIn(client, feat, COMMANDS.ring);
    const failing = await runIn(client, feat, COMMANDS.fail);
    const succeeding = await runIn(client, feat, COMMANDS.succeed);
    await runIn(client, feat, COMMANDS.oneLine);
    await runIn(client, feat, COMMANDS.ticker);
    await client.waitFor('termExited', (m) => m.termId === failing, { timeout: 10_000 });
    await client.waitFor('termExited', (m) => m.termId === succeeding, { timeout: 10_000 });

    const all = { input: 1, failed: 1, exited: 1, done: 1, output: 1 };
    await expectMark(page, worktreeEntry(feat), 'input');
    await expectCounts(page, worktreeEntry(feat), all);
    await expectMark(page, repoTab(repo), 'input');
    await expectCounts(page, repoTab(repo), all);

    // Typing clears `input`; the echoed `y` is new output.
    client.sendInput(ringing, 'y');
    await expectMark(page, worktreeEntry(feat), 'failed');
    await expectCounts(page, worktreeEntry(feat), { failed: 1, exited: 1 });

    await client.ok({ t: 'closeTerm', termId: failing });
    await expectMark(page, worktreeEntry(feat), 'exited');
    await expectMark(page, repoTab(repo), 'exited');
    await client.ok({ t: 'closeTerm', termId: succeeding });
    await expectMark(page, worktreeEntry(feat), 'done');
    await expectMark(page, repoTab(repo), 'done');
  });

  test('a pane of a split tab shows its own mark and the tab shows the first-ranked mark of its panes', async ({ hub, page }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const client = await watcher(hub, repo);
    const left = await runIn(client, repo, 'read -r _; exit 3');
    const right = await runIn(client, repo, COMMANDS.ring);
    await storeTabs(client, repo, [split('right', leaf(left), leaf(right))]);
    await expect(page.locator(pane(left))).toBeVisible();
    await expect(page.locator(pane(right))).toBeVisible();

    await expectMark(page, pane(right), 'input');
    await expectMark(page, pane(left), null);
    await expectMark(page, termTab(left), 'input');
    await expectMark(page, worktreeEntry(repo), 'input');

    client.sendInput(left, '\r');
    await client.waitFor('termExited', (m) => m.termId === left, { timeout: 10_000 });
    await expectMark(page, pane(left), 'failed');
    await expectMark(page, termTab(left), 'input');
    // The failed terminal is shown, so the row counts only the one needing input.
    await expectCounts(page, worktreeEntry(repo), { input: 1 });

    await client.ok({ t: 'closeTerm', termId: right });
    await expect(page.locator(pane(right))).toHaveCount(0);
    await expectMark(page, termTab(left), 'failed');
    await expectMark(page, worktreeEntry(repo), null);
  });
});
