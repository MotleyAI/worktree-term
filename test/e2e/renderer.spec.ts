import { terminalBox } from './contract.js';
import {
  createShells,
  expect,
  LOCAL,
  makeRepoWith,
  newTerminal,
  openUi,
  ready,
  selectWorktree,
  test,
  typeLine,
  waitScreen,
  watcher,
} from './fixture.js';
import { holdsWebgl, liveWebgl, loseWebgl, maxLiveWebgl } from './webgl.js';

test.describe('renderer budget', () => {
  test('at most 8 WebGL contexts live, held by the 8 most recently shown terminals', async ({ hub, page }) => {
    const branches = Array.from({ length: 12 }, (_, i) => `w${String(i).padStart(2, '0')}`);
    const { repo, worktrees } = makeRepoWith(hub, 'app', branches);
    hub.writeRepos([repo]);
    await hub.start();
    const client = await watcher(hub, repo);
    const terms = (await createShells(client, worktrees)).map(([term = 0]) => term);
    await openUi(hub, page);

    for (const [i, worktree] of worktrees.entries()) {
      const term = terms[i] ?? 0;
      await selectWorktree(page, worktree);
      await expect(page.locator(terminalBox(LOCAL, term))).toBeVisible();
      await expect.poll(() => holdsWebgl(page, LOCAL, term)).toBe(true);
      expect(await maxLiveWebgl(page)).toBeLessThanOrEqual(8);
    }

    expect(await liveWebgl(page)).toBeLessThanOrEqual(8);
    expect(await maxLiveWebgl(page)).toBeLessThanOrEqual(8);
    for (const term of terms.slice(-8)) expect(await holdsWebgl(page, LOCAL, term)).toBe(true);
    for (const term of terms.slice(0, -8)) expect(await holdsWebgl(page, LOCAL, term)).toBe(false);
  });

  test('a lost WebGL context falls back to the DOM renderer and WebGL returns on the next show', async ({ hub, page }) => {
    const { repo, worktrees } = makeRepoWith(hub, 'app', ['a', 'b']);
    const [a = '', b = ''] = worktrees;
    hub.writeRepos([repo]);
    await openUi(hub, page);
    await selectWorktree(page, b);
    await newTerminal(page);
    await selectWorktree(page, a);
    const term = await newTerminal(page);
    await ready(page, term);
    await typeLine(page, term, "echo CTX''-MARK");
    await waitScreen(page, term, 'CTX-MARK');
    await expect.poll(() => holdsWebgl(page, LOCAL, term)).toBe(true);

    await loseWebgl(page, LOCAL, term);
    await expect.poll(() => holdsWebgl(page, LOCAL, term)).toBe(false);
    const rows = page.locator(terminalBox(LOCAL, term)).locator('.xterm-rows');
    await expect(rows).toContainText('CTX-MARK');
    await typeLine(page, term, "echo AFTER''-LOSS");
    await expect(rows).toContainText('AFTER-LOSS');

    await selectWorktree(page, b);
    await selectWorktree(page, a);
    await expect.poll(() => holdsWebgl(page, LOCAL, term)).toBe(true);
  });
});
