import type { Page } from '@playwright/test';
import { HOG, NO_USER_MANAGER, SKIP_REASON, SMALL, userManagerEnv } from '../support/scopes.js';
import { expectMark } from './attention-helpers.js';
import { pane, terminalBox, termTab, worktreeEntry } from './contract.js';
import {
  expect,
  LOCAL,
  makeRepoWith,
  newTerminal,
  openPage,
  openUi,
  PRESETS,
  ready,
  selectWorktree,
  test,
  waitScreen,
  watcher,
} from './fixture.js';
import { createsSent, leaf, split, splitByKey, storeTabs } from './panes.js';

const OOM = 'killed: out of memory';
/** Prints a marker, waits for a line, then runs out of memory. */
const HOG_AFTER_MARK = `echo BEFORE''-HOG; read -r _; ${HOG}`;

/** Expects `termId`'s tab to say it was killed for lack of memory, its screen still showing what it printed. */
const expectOomTab = async (page: Page, termId: number): Promise<void> => {
  await expect(page.locator(termTab(termId))).toContainText(OOM, { timeout: 20_000 });
  await expect(page.locator(terminalBox(LOCAL, termId))).toBeVisible();
  await waitScreen(page, termId, 'BEFORE-HOG');
};

test.describe('out-of-memory exits', () => {
  test.skip(NO_USER_MANAGER !== null, SKIP_REASON); // NOSONAR(S1607) — conditional skip whose reason is SKIP_REASON

  test.beforeEach(({ hub }) => {
    hub.extraEnv = userManagerEnv();
  });

  test('a terminal killed for lack of memory says so on its tab on every page, its screen readable', async ({ hub, page, context }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const other = await openPage(hub, context);
    const client = await watcher(hub, repo);
    const hog = (await client.create(repo, { preset: 'tests', command: HOG_AFTER_MARK, memory: SMALL })).termId;
    await storeTabs(client, repo, [leaf(hog)]);
    for (const shown of [page, other.page]) await waitScreen(shown, hog, 'BEFORE-HOG');

    client.sendInput(hog, '\r');
    expect(await client.waitFor('termExited', (m) => m.termId === hog, { timeout: 20_000 })).toMatchObject({ oom: true });
    for (const shown of [page, other.page]) await expectOomTab(shown, hog);
    await expect(page.locator(termTab(hog))).not.toContainText('(exited)');
    await expectMark(page, termTab(hog), 'failed');
    await expect
      .poll(async () => (await page.locator(worktreeEntry(repo)).getAttribute('title')) ?? '')
      .toBe(`${repo}\ntests ${String(hog)}: ${OOM}`);
  });

  test('a pane of a split killed for lack of memory says so in its header, the other pane running', async ({ hub, page }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const client = await watcher(hub, repo);
    const hog = (await client.create(repo, { preset: 'tests', command: HOG_AFTER_MARK, memory: SMALL })).termId;
    const survivor = (await client.create(repo, { preset: 'shell', command: 'exec cat' })).termId;
    await storeTabs(client, repo, [split('right', leaf(hog), leaf(survivor))]);
    await waitScreen(page, hog, 'BEFORE-HOG');

    client.sendInput(hog, '\r');
    await client.waitFor('termExited', (m) => m.termId === hog && m.oom, { timeout: 20_000 });
    await expect(page.locator(pane(hog)).locator('.pane-header')).toContainText(OOM);
    await expect(page.locator(pane(survivor)).locator('.pane-header')).not.toContainText('killed');
    client.sendInput(survivor, 'still-here\r');
    await waitScreen(page, survivor, 'still-here');
  });

  test('a page opened after the kill says so on the tab', async ({ hub, page, context }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const client = await watcher(hub, repo);
    const hog = (await client.create(repo, { preset: 'tests', command: HOG, memory: SMALL })).termId;
    await storeTabs(client, repo, [leaf(hog)]);
    await client.waitFor('termExited', (m) => m.termId === hog && m.oom, { timeout: 20_000 });

    const later = await openPage(hub, context);
    await expect(later.page.locator(termTab(hog))).toContainText(OOM);
  });
});

test.describe('preset limits on new terminals', () => {
  const [SHELL, CAT] = PRESETS;

  test('a new tab carries its preset’s limits, and a split with a preset without limits carries none', async ({ hub, page, wire }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeConfig({ port: hub.port, repos: [repo], presets: [SHELL, { ...CAT, memory: { max: '24G' } }] });
    await openUi(hub, page);
    await selectWorktree(page, repo);

    const fromTab = wire.markSent();
    await newTerminal(page, 'cat');
    expect(createsSent(wire, fromTab)).toEqual([expect.objectContaining({ preset: 'cat', memory: { max: '24G' } })]);

    const first = await newTerminal(page, 'shell');
    await ready(page, first);
    const fromSplit = wire.markSent();
    await splitByKey(page, 'right', 'shell');
    expect(createsSent(wire, fromSplit)).toEqual([expect.objectContaining({ preset: 'shell', memory: {} })]);
  });
});
