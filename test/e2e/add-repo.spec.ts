import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { addWorktree, makeRepo } from '../support/daemon-host.js';
import { installRemote } from '../support/fake-ssh.js';
import { byTestId, hostBanner, repoTab, TID, worktreeEntry } from './contract.js';
import {
  confirmAction,
  expect,
  hubRequests,
  LOCAL,
  makeRepoWith,
  newTerminal,
  nodeRemote,
  openUi,
  ready,
  REMOTE,
  selectRepo,
  test,
  writeHubConfig,
} from './fixture.js';

/** Opens the add-repo dialog and returns it. */
const openAddRepo = async (page: Page): Promise<Locator> => {
  await page.locator(byTestId(TID.addRepo)).click();
  const dialog = page.locator(byTestId(TID.addRepoDialog));
  await expect(dialog).toBeVisible();
  return dialog;
};

/** Paths of the discovered repos the dialog offers, in order. */
const offered = (dialog: Locator): Promise<string[]> =>
  dialog.locator(byTestId(TID.addRepoOption)).evaluateAll((options) => options.map((o) => o.getAttribute('title') ?? ''));

test.describe('add repo', () => {
  test('picking a discovered repo adds its tab, selects it and shows its worktrees', async ({ hub, page, wire }) => {
    const src = join(hub.dir, 'src');
    const one = makeRepo(join(src, 'one'));
    const two = makeRepo(join(src, 'two'));
    const wt = addWorktree(two, join(hub.dir, 'two-feature'), 'feature');
    writeHubConfig(hub, { repos: [one], roots: [src] });
    await openUi(hub, page);
    await expect(page.locator(worktreeEntry(one))).toBeVisible();

    const dialog = await openAddRepo(page);
    await expect(dialog.locator(byTestId(TID.addRepoHost))).toHaveValue(String(LOCAL));
    await expect.poll(() => offered(dialog)).toEqual([two]);
    const mark = wire.markSent();
    await dialog.locator(byTestId(TID.addRepoOption)).first().click();
    await expect(dialog).toHaveCount(0);
    expect(hubRequests(wire, mark)).toEqual([{ t: 'addRepo', host: LOCAL }]);
    await expect(page.locator(repoTab(two))).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator(worktreeEntry(wt))).toBeVisible();
  });

  test('repos the host already lists are not offered', async ({ hub, page }) => {
    const root = join(hub.dir, 'r');
    const a = makeRepo(join(root, 'a'));
    const b = makeRepo(join(root, 'b'));
    writeHubConfig(hub, { repos: [a], roots: [root] });
    await openUi(hub, page);
    const dialog = await openAddRepo(page);
    await expect.poll(() => offered(dialog)).toEqual([b]);
  });

  test('the filter narrows the discovered repos by substring', async ({ hub, page }) => {
    const root = join(hub.dir, 'r');
    const alpha = makeRepo(join(root, 'alpha'));
    const beta = makeRepo(join(root, 'beta'));
    const betamax = makeRepo(join(root, 'betamax'));
    writeHubConfig(hub, { roots: [root] });
    await openUi(hub, page);
    const dialog = await openAddRepo(page);
    await expect.poll(() => offered(dialog)).toEqual([alpha, beta, betamax]);
    const filter = dialog.locator(byTestId(TID.addRepoFilter));
    await filter.fill('beta');
    await expect.poll(() => offered(dialog)).toEqual([beta, betamax]);
    await filter.fill('max');
    await expect.poll(() => offered(dialog)).toEqual([betamax]);
  });

  test('a typed path that is not a repository shows not-a-repo and keeps the dialog open', async ({ hub, page, wire }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    const plain = join(hub.dir, 'plain');
    mkdirSync(plain);
    writeHubConfig(hub, { repos: [repo], roots: [join(hub.dir, 'nothing-here')] });
    await openUi(hub, page);
    const dialog = await openAddRepo(page);
    const mark = wire.markSent();
    await dialog.locator(byTestId(TID.addRepoPath)).fill(plain);
    await dialog.locator(byTestId(TID.addRepoPath)).press('Enter');
    await expect(dialog.locator(byTestId(TID.addRepoError))).toContainText('not-a-repo');
    await expect(dialog).toBeVisible();
    expect(hubRequests(wire, mark)).toEqual([{ t: 'addRepo', host: LOCAL }]);
    await expect(page.locator(repoTab(plain))).toHaveCount(0);
  });

  test('a typed repository path is added and selected', async ({ hub, page }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    const other = makeRepoWith(hub, 'other', ['side']);
    writeHubConfig(hub, { repos: [repo], roots: [join(hub.dir, 'nothing-here')] });
    await openUi(hub, page);
    const dialog = await openAddRepo(page);
    await dialog.locator(byTestId(TID.addRepoPath)).fill(other.repo);
    await dialog.locator(byTestId(TID.addRepoPath)).press('Enter');
    await expect(dialog).toHaveCount(0);
    await expect(page.locator(repoTab(other.repo))).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator(worktreeEntry(other.worktrees[0] ?? ''))).toBeVisible();
  });

  test('Escape closes the dialog without sending anything', async ({ hub, page, wire }) => {
    const root = join(hub.dir, 'r');
    const b = makeRepo(join(root, 'b'));
    writeHubConfig(hub, { roots: [root] });
    await openUi(hub, page);
    const dialog = await openAddRepo(page);
    await expect.poll(() => offered(dialog)).toEqual([b]);
    const mark = wire.markSent();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await page.waitForTimeout(300);
    expect(hubRequests(wire, mark)).toEqual([]);
    await expect(page.locator(repoTab(b))).toHaveCount(0);
  });

  test('the host selector lists every host with its status, disables unconnected ones and adds to a remote', async ({ hub, page, ssh }) => {
    test.setTimeout(120_000);
    const remote = nodeRemote(ssh, 'box');
    const app = makeRepo(join(remote.home, 'app'));
    const other = makeRepo(join(remote.home, 'other'));
    await installRemote(hub, ssh, 'box');
    ssh.failHost('gpu', 'ssh: Could not resolve hostname gpu');
    writeHubConfig(hub, {
      roots: [join(hub.dir, 'nothing-here')],
      hosts: [
        { name: 'box', ssh: 'box', repos: [app], roots: [remote.home] },
        { name: 'gpu', ssh: 'gpu', repos: [] },
      ],
    });
    await openUi(hub, page);
    await expect(page.locator(hostBanner(2))).toContainText('down', { timeout: 15_000 });
    await selectRepo(page, app);
    await expect(page.locator(worktreeEntry(app))).toBeVisible({ timeout: 15_000 });

    const dialog = await openAddRepo(page);
    const select = dialog.locator(byTestId(TID.addRepoHost));
    await expect(select).toHaveValue(String(REMOTE));
    await expect(select.locator('option')).toHaveCount(3);
    await expect(select.locator(`option[value="${String(LOCAL)}"]`)).toBeEnabled();
    await expect(select.locator(`option[value="${String(REMOTE)}"]`)).toContainText('box');
    await expect(select.locator(`option[value="${String(REMOTE)}"]`)).toContainText('connected');
    const gpu = select.locator('option[value="2"]');
    await expect(gpu).toContainText('gpu');
    await expect(gpu).toContainText('down');
    await expect(gpu).toBeDisabled();

    await expect.poll(() => offered(dialog), { timeout: 15_000 }).toEqual([other]);
    await dialog.locator(byTestId(TID.addRepoOption)).first().click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator(repoTab(other))).toContainText('box:other');
    await expect(page.locator(repoTab(other))).toHaveAttribute('aria-selected', 'true');
  });

  test('a repo added by another session is watched and shown with its worktrees', async ({ hub, page }) => {
    const first = makeRepoWith(hub, 'one', []);
    const second = makeRepoWith(hub, 'two', ['side']);
    writeHubConfig(hub, { repos: [first.repo] });
    await openUi(hub, page);
    await expect(page.locator(worktreeEntry(first.repo))).toBeVisible();

    const other = await hub.session();
    try {
      await other.waitHost(LOCAL, (h) => h.status === 'connected', { timeout: 10_000 });
      const reply = await other.hubRequest({ t: 'addRepo', host: LOCAL, repo: second.repo });
      expect(reply.m.t).toBe('done');
    } finally {
      other.close();
    }
    await expect(page.locator(repoTab(second.repo))).toBeVisible();
    await selectRepo(page, second.repo);
    await expect(page.locator(worktreeEntry(second.worktrees[0] ?? ''))).toBeVisible();
  });
});

test.describe('remove repo', () => {
  test('removing a repo without terminals after confirming makes its tab disappear', async ({ hub, page, wire }) => {
    const a = makeRepoWith(hub, 'a', []);
    const b = makeRepoWith(hub, 'b', []);
    writeHubConfig(hub, { repos: [a.repo, b.repo] });
    await openUi(hub, page);
    await expect(page.locator(worktreeEntry(a.repo))).toBeVisible();
    const mark = wire.markSent();
    await page.locator(repoTab(a.repo)).locator(byTestId(TID.removeRepo)).click();
    await expect(page.locator(byTestId(TID.confirmDialog))).toBeVisible();
    expect(hubRequests(wire, mark)).toEqual([]);
    await confirmAction(page);
    await expect(page.locator(repoTab(a.repo))).toHaveCount(0);
    expect(hubRequests(wire, mark)).toEqual([{ t: 'removeRepo', host: LOCAL }]);
    await expect(page.locator(repoTab(b.repo))).toBeVisible();
  });

  test('a repo with a terminal keeps its tab and the page says to close its terminals first', async ({ hub, page }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    writeHubConfig(hub, { repos: [repo] });
    await openUi(hub, page);
    const term = await newTerminal(page);
    await ready(page, term);
    await page.locator(repoTab(repo)).locator(byTestId(TID.removeRepo)).click();
    await confirmAction(page);
    const notice = page.locator(byTestId(TID.notice));
    await expect(notice).toContainText(/close/i);
    await expect(notice).toContainText(/terminal/i);
    await expect(page.locator(repoTab(repo))).toBeVisible();
  });
});
