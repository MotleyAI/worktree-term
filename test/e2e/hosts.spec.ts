import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PROTOCOL_VERSION } from '../../src/protocol/index.js';
import { makeRepo, waitUntil } from '../support/daemon-host.js';
import { FakeDaemon } from '../support/fake-daemon.js';
import { installRemote, type FakeRemote } from '../support/fake-ssh.js';
import { byTestId, hostBanner, repoTab, terminalBox, TID, worktreeEntry } from './contract.js';
import {
  confirmAction,
  expect,
  hostEntries,
  hubRequests,
  isCurrent,
  LOCAL,
  makeRepoWith,
  newTerminal,
  nodeRemote,
  oneDaemon,
  openHostAction,
  openUi,
  ready,
  refuseBrowserDialogs,
  REMOTE,
  screenOf,
  selectRepo,
  selectWorktree,
  stopHub,
  test,
  typeLine,
  waitScreen,
  writeHubConfig,
  xtermOf,
} from './fixture.js';

const RESOLVE_ERROR = 'ssh: Could not resolve hostname box';

/** Replaces the remote's `wtd` with a shell script. */
const plantWtd = (remote: FakeRemote, script: string): void => {
  mkdirSync(dirname(remote.shim), { recursive: true });
  writeFileSync(remote.shim, `#!/bin/sh\n${script}\n`);
  chmodSync(remote.shim, 0o755);
};

test.describe('host status on repo tabs', () => {
  test('a remote tab is labelled with its host and shows a reconnecting host status, without a banner', async ({ hub, page, ssh }) => {
    const remote = ssh.addHost('box');
    // The first connect fails; the retry never answers, so the host stays reconnecting.
    plantWtd(remote, 'if [ -e "$HOME/once" ]; then exec sleep 600; fi; : > "$HOME/once"; exit 1');
    const app = join(remote.home, 'srv', 'app');
    writeHubConfig(hub, { hosts: [{ name: 'box', ssh: 'box', repos: [app] }] });
    await openUi(hub, page);
    const tab = page.locator(repoTab(app));
    await expect(tab).toContainText('box:app');
    await expect(tab.locator(byTestId(TID.hostStatus))).toHaveText('reconnecting', { timeout: 10_000 });
    await expect(page.locator(hostBanner(REMOTE))).toHaveCount(0);
  });

  test('a connected host shows no status on its tabs', async ({ hub, page }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    await expect(page.locator(worktreeEntry(repo))).toBeVisible();
    await expect(page.locator(repoTab(repo)).locator(byTestId(TID.hostStatus))).toHaveCount(0);
  });
});

test.describe('host banners', () => {
  test('a down remote host shows a banner with its name, status and reason, offering Install', async ({ hub, page, ssh }) => {
    ssh.failHost('box', RESOLVE_ERROR);
    writeHubConfig(hub, { hosts: [{ name: 'box', ssh: 'box', repos: ['/srv/app'] }] });
    await openUi(hub, page);
    const banner = page.locator(hostBanner(REMOTE));
    await expect(banner).toContainText('down', { timeout: 15_000 });
    await expect(banner).toContainText('box');
    await expect(banner).toContainText(RESOLVE_ERROR);
    await expect(banner.locator(byTestId(TID.hostAction))).toHaveText('Install');
    await expect(page.locator(repoTab('/srv/app')).locator(byTestId(TID.hostStatus))).toHaveText('down');
  });

  test('the banner disappears once the down host is connected', async ({ hub, page, ssh }) => {
    test.setTimeout(120_000);
    ssh.failHost('box', RESOLVE_ERROR);
    writeHubConfig(hub, { hosts: [{ name: 'box', ssh: 'box', repos: ['/srv/app'] }] });
    await openUi(hub, page);
    await expect(page.locator(hostBanner(REMOTE))).toContainText('down', { timeout: 15_000 });

    nodeRemote(ssh, 'box');
    await installRemote(hub, ssh, 'box');
    await expect(page.locator(hostBanner(REMOTE))).toHaveCount(0, { timeout: 30_000 });
    await expect(page.locator(repoTab('/srv/app')).locator(byTestId(TID.hostStatus))).toHaveCount(0);
  });
});

test.describe('host actions', () => {
  test('cancelling the confirmation sends nothing', async ({ hub, page, wire }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    const fake = await FakeDaemon.listen(hub.socket, { protocol: 99, version: '9.9.9' });
    try {
      const browserDialogs = refuseBrowserDialogs(page);
      await openUi(hub, page);
      await expect(page.locator(hostBanner(LOCAL))).toContainText('outdated');
      const mark = wire.markSent();
      await openHostAction(page, LOCAL, 'Restart daemon');
      await page.locator(byTestId(TID.confirmDialog)).locator(byTestId(TID.confirmCancel)).click();
      await expect(page.locator(byTestId(TID.confirmDialog))).toHaveCount(0);
      await page.waitForTimeout(500);
      expect(hubRequests(wire, mark)).toEqual([]);
      expect(fake.shutdowns).toBe(0);
      await expect(page.locator(hostBanner(LOCAL))).toContainText('outdated');
      expect(browserDialogs).toEqual([]);
    } finally {
      await fake.close().catch(() => undefined);
    }
  });

  test('without a record of the reported instance, the confirmation says every running terminal will be killed', async ({ hub, page }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    const fake = await FakeDaemon.listen(hub.socket, { protocol: 99, version: '9.9.9' });
    try {
      await openUi(hub, page);
      await openHostAction(page, LOCAL, 'Restart daemon');
      const dialog = page.locator(byTestId(TID.confirmDialog));
      await expect(dialog).toContainText(/every running terminal/i);
      await expect(dialog).toContainText(/kill/i);
      await expect(dialog.locator(byTestId(TID.confirmTarget))).toHaveCount(0);
    } finally {
      await fake.close().catch(() => undefined);
    }
  });

  test('after a reload, the confirmation names the terminals last seen on the instance the host reports', async ({ hub, page, wire }) => {
    const { repo, worktrees } = makeRepoWith(hub, 'app', ['feat']);
    const feat = worktrees[0] ?? '';
    hub.writeRepos([repo]);
    await openUi(hub, page);
    await selectWorktree(page, feat);
    const cat = await newTerminal(page, 'cat');
    await waitScreen(page, cat, 'PRESET-CAT');
    await selectWorktree(page, repo);
    const shell = await newTerminal(page, 'shell');
    await ready(page, shell);
    const instance = hostEntries(wire, LOCAL).findLast((h) => h.status === 'connected')?.instance ?? '';
    expect(instance).not.toBe('');

    // Replace the daemon by one of another protocol announcing the same instance.
    await stopHub(hub);
    process.kill(await oneDaemon(hub), 'SIGKILL');
    await waitUntil(() => hub.daemonPids().length === 0, 'the daemon to exit');
    rmSync(hub.socket, { force: true });
    const fake = await FakeDaemon.listen(hub.socket, { protocol: PROTOCOL_VERSION - 1, version: '0.0.9', instance });
    try {
      await hub.startHub();
      await page.reload();
      await expect(page.locator(hostBanner(LOCAL))).toContainText('outdated', { timeout: 15_000 });
      const mark = wire.markSent();
      await openHostAction(page, LOCAL, 'Restart daemon');
      const targets = page.locator(byTestId(TID.confirmTarget));
      await expect(targets).toHaveCount(2);
      await expect(targets.filter({ hasText: 'feat' })).toContainText('cat');
      await expect(targets.filter({ hasText: 'main' })).toContainText('shell');
      await expect(page.locator(byTestId(TID.confirmSeen))).not.toBeEmpty();
      expect(hubRequests(wire, mark)).toEqual([]);
    } finally {
      await fake.close().catch(() => undefined);
    }
  });

  test('reinstalling an outdated remote from the page shows its repos once it is connected', async ({ hub, page, ssh, wire }) => {
    test.setTimeout(150_000);
    const remote = nodeRemote(ssh, 'box');
    const app = makeRepo(join(remote.home, 'app'));
    await installRemote(hub, ssh, 'box');
    const before = remote.current();
    const fake = await FakeDaemon.listen(remote.socket, { protocol: PROTOCOL_VERSION - 1, version: '0.0.9' });
    writeHubConfig(hub, { hosts: [{ name: 'box', ssh: 'box', repos: [app] }] });
    try {
      const browserDialogs = refuseBrowserDialogs(page);
      await openUi(hub, page);
      await expect(page.locator(hostBanner(REMOTE))).toContainText('outdated', { timeout: 15_000 });
      const mark = wire.markSent();
      await openHostAction(page, REMOTE, 'Reinstall & restart');
      await expect(page.locator(byTestId(TID.confirmDialog))).toContainText(/every running terminal/i);
      expect(hubRequests(wire, mark)).toEqual([]);
      await confirmAction(page);
      await expect.poll(() => hubRequests(wire, mark)).toEqual([{ t: 'reinstallDaemon', host: REMOTE }]);
      await expect(page.locator(hostBanner(REMOTE))).toHaveCount(0, { timeout: 120_000 });
      expect(fake.shutdowns).toBeGreaterThanOrEqual(1);
      expect(remote.current()).not.toBe(before);
      await selectRepo(page, app);
      await expect(page.locator(worktreeEntry(app))).toBeVisible({ timeout: 15_000 });
      expect(browserDialogs).toEqual([]);
    } finally {
      await fake.close().catch(() => undefined);
    }
  });

  test('installing on a down remote without wtd connects it and shows its repos', async ({ hub, page, ssh, wire }) => {
    test.setTimeout(150_000);
    const remote = nodeRemote(ssh, 'box');
    const app = makeRepo(join(remote.home, 'app'));
    writeHubConfig(hub, { hosts: [{ name: 'box', ssh: 'box', repos: [app] }] });
    await openUi(hub, page);
    await expect(page.locator(hostBanner(REMOTE))).toContainText('down', { timeout: 15_000 });
    const mark = wire.markSent();
    await openHostAction(page, REMOTE, 'Install');
    await confirmAction(page);
    await expect.poll(() => hubRequests(wire, mark)).toEqual([{ t: 'reinstallDaemon', host: REMOTE }]);
    await expect(page.locator(hostBanner(REMOTE))).toHaveCount(0, { timeout: 120_000 });
    expect(remote.current()).not.toBeNull();
    await selectRepo(page, app);
    await expect(page.locator(worktreeEntry(app))).toBeVisible({ timeout: 15_000 });
  });

  test('a failed action shows its error on the page', async ({ hub, page, ssh }) => {
    test.setTimeout(120_000);
    // No Node on the remote's PATH nor in its login shell.
    ssh.addHost('box');
    writeHubConfig(hub, { hosts: [{ name: 'box', ssh: 'box', repos: ['/srv/app'] }] });
    await openUi(hub, page);
    await expect(page.locator(hostBanner(REMOTE))).toContainText('down', { timeout: 15_000 });
    await openHostAction(page, REMOTE, 'Install');
    await confirmAction(page);
    const notice = page.locator(byTestId(TID.notice));
    await expect(notice).toContainText('install', { timeout: 90_000 });
    await expect(notice).toContainText(/node/i);
    await expect(page.locator(hostBanner(REMOTE))).toContainText('down');
  });
});

test.describe('remote reconnect', () => {
  test('a killed SSH process keeps each terminal object of the remote, which then receives new output', async ({
    hub,
    page,
    ssh,
    wire,
  }) => {
    test.setTimeout(120_000);
    const remote = nodeRemote(ssh, 'box');
    const app = makeRepo(join(remote.home, 'app'));
    await installRemote(hub, ssh, 'box');
    writeHubConfig(hub, { hosts: [{ name: 'box', ssh: 'box', repos: [app] }] });
    await openUi(hub, page);
    await selectRepo(page, app);
    await expect(page.locator(worktreeEntry(app))).toBeVisible({ timeout: 15_000 });
    const term = await newTerminal(page, 'shell', REMOTE);
    await ready(page, term, REMOTE);
    await typeLine(page, term, "echo KEEP''-MARK", REMOTE);
    const before = await waitScreen(page, term, 'KEEP-MARK', 10_000, REMOTE);
    const xterm = await xtermOf(page, term, REMOTE);
    const instance = hostEntries(wire, REMOTE).findLast((h) => h.status === 'connected')?.instance;
    expect(instance).toBeTruthy();

    const from = wire.markReceived();
    for (const pid of ssh.livePids('box')) process.kill(pid, 'SIGKILL');
    await expect.poll(() => hostEntries(wire, REMOTE, from).map((h) => h.status), { timeout: 10_000 }).toContain('reconnecting');
    await expect
      .poll(() => hostEntries(wire, REMOTE, from).findLast((h) => h.status === 'connected')?.instance, { timeout: 15_000 })
      .toBe(instance);
    await expect.poll(() => screenOf(page, term, REMOTE), { timeout: 10_000 }).toBe(before);
    expect(await isCurrent(page, xterm, `${terminalBox(REMOTE, term)} .xterm`)).toBe(true);

    await typeLine(page, term, "echo AFTER''-LOSS", REMOTE);
    await waitScreen(page, term, 'AFTER-LOSS', 10_000, REMOTE);
    expect(await isCurrent(page, xterm, `${terminalBox(REMOTE, term)} .xterm`)).toBe(true);
  });
});
