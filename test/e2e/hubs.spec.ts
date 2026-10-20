import type { Page } from '@playwright/test';
import { join } from 'node:path';
import { makeRepo } from '../support/daemon-host.js';
import { freePort, type HubHost } from '../support/hub-host.js';
import { remoteHub } from '../support/remote-hub.js';
import { byTestId, hubsEntry, repoTab, TID } from './contract.js';
import {
  borderOf,
  expect,
  hubRequests,
  makeRepoWith,
  nodeRemote,
  openUi,
  runUi,
  selectedTabColour,
  test,
  writeHubConfig,
  type HostConfig,
} from './fixture.js';

const RESOLVE_ERROR = 'ssh: Could not resolve hostname box: Name or service not known';

/** A free port that is neither `hub`'s, which it may not listen on yet, nor any of `taken`. */
const tunnelPort = async (hub: HubHost, ...taken: readonly { port: number }[]): Promise<number> => {
  for (;;) {
    const port = await freePort(); // NOSONAR(S9382) — retries until a port outside `taken` is free
    if (port !== hub.port && !taken.some((t) => t.port === port)) return port;
  }
};

const originOf = (port: number): string => `http://127.0.0.1:${String(port)}`;

/** Waits until the tab shows `origin` with its fragment removed. */
const landedOn = async (page: Page, origin: string): Promise<void> => {
  await expect.poll(() => page.url(), { timeout: 30_000 }).toBe(`${origin}/`);
};

/** Opens the Hubs menu and picks the entry labelled `label`. */
const pick = async (page: Page, label: string): Promise<void> => {
  await page.locator(byTestId(TID.hubsMenu)).click();
  await page.locator(hubsEntry(label)).click();
};

/** The labels of the open Hubs menu, in order. */
const menuLabels = async (page: Page): Promise<string[]> => {
  await page.locator(byTestId(TID.hubsMenu)).click();
  const labels = await page.locator(byTestId(TID.hubsEntry)).allTextContents();
  await page.keyboard.press('Escape');
  return labels.map((label) => label.trim());
};

/** Configures a local repo and `hosts`, opens the home page, and returns the local repo. */
const home = async (hub: HubHost, page: Page, hosts: readonly HostConfig[]): Promise<string> => {
  const { repo } = makeRepoWith(hub, 'local-app', []);
  writeHubConfig(hub, { repos: [repo], hosts });
  await openUi(hub, page);
  await expect(page.locator(repoTab(repo))).toBeVisible();
  return repo;
};

test.describe('Hubs menu', () => {
  test('lists This machine, marked, and every remote host', async ({ hub, page, ssh }) => {
    ssh.failHost('box', RESOLVE_ERROR);
    ssh.failHost('gpu', RESOLVE_ERROR);
    await home(hub, page, [
      { name: 'box', ssh: 'box' },
      { name: 'gpu', ssh: 'gpu' },
    ]);
    expect(await menuLabels(page)).toEqual(['This machine', 'box', 'gpu']);
    await page.locator(byTestId(TID.hubsMenu)).click();
    await expect(page.locator(hubsEntry('This machine'))).toHaveAttribute('aria-current', 'true');
    await expect(page.locator(hubsEntry('box'))).not.toHaveAttribute('aria-current', 'true');
  });

  test('Escape on an entry closes the menu and keeps the focus on the Hubs button', async ({ hub, page, ssh }) => {
    ssh.failHost('box', RESOLVE_ERROR);
    await home(hub, page, [{ name: 'box', ssh: 'box' }]);
    await page.locator(byTestId(TID.hubsMenu)).click();
    await page.locator(hubsEntry('box')).focus();
    await page.keyboard.press('Escape');
    await expect(page.locator(byTestId(TID.hubsEntry))).toHaveCount(0);
    await expect(page.locator(byTestId(TID.hubsMenu))).toBeFocused();
  });

  test("is framed 3px in the selected tab's colour", async ({ hub, page, ssh }) => {
    ssh.failHost('box', RESOLVE_ERROR);
    await home(hub, page, [{ name: 'box', ssh: 'box' }]);
    await page.locator(byTestId(TID.hubsMenu)).click();
    const blue = await selectedTabColour(page);
    expect(await borderOf(page.locator(byTestId(TID.hubsList)))).toEqual(Array(4).fill(`3px ${blue}`));
  });

  test('is absent without remote hosts', async ({ hub, page }) => {
    await home(hub, page, []);
    await expect(page.locator(byTestId(TID.hubsMenu))).toHaveCount(0);
  });

  test('picking a host shows its own hub in the same tab, titled by the host', async ({ hub, page, ssh }) => {
    test.setTimeout(120_000);
    const box = await remoteHub(hub, ssh, 'box', [hub.port]);
    const port = await tunnelPort(hub, box);
    await home(hub, page, [{ name: 'box', ssh: 'box', port }]);
    await expect(page).toHaveTitle('worktree-term');
    let pages = 0;
    page.context().on('page', () => pages++);

    await pick(page, 'box');
    await landedOn(page, originOf(port));
    await expect(page).toHaveTitle('worktree-term — box');
    await expect(page.locator(repoTab(box.repo))).toBeVisible();
    await expect(page.locator(byTestId(TID.authMessage))).toHaveCount(0);
    expect(pages).toBe(0);
  });

  test('a remote page keeps its title and menu across a reload', async ({ hub, page, ssh }) => {
    test.setTimeout(120_000);
    const box = await remoteHub(hub, ssh, 'box', [hub.port]);
    ssh.failHost('gpu', RESOLVE_ERROR);
    const port = await tunnelPort(hub, box);
    await home(hub, page, [
      { name: 'box', ssh: 'box', port },
      { name: 'gpu', ssh: 'gpu' },
    ]);
    await pick(page, 'box');
    await landedOn(page, originOf(port));

    await page.reload();
    await expect(page).toHaveTitle('worktree-term — box');
    expect(await menuLabels(page)).toEqual(['This machine', 'box', 'gpu']);
    await page.locator(byTestId(TID.hubsMenu)).click();
    await expect(page.locator(hubsEntry('box'))).toHaveAttribute('aria-current', 'true');
  });

  test('This machine on a remote page goes back home, connected with the stored token', async ({ hub, page, ssh }) => {
    test.setTimeout(120_000);
    const box = await remoteHub(hub, ssh, 'box', [hub.port]);
    const port = await tunnelPort(hub, box);
    const repo = await home(hub, page, [{ name: 'box', ssh: 'box', port }]);
    await pick(page, 'box');
    await landedOn(page, originOf(port));

    await pick(page, 'This machine');
    await landedOn(page, hub.origin);
    await expect(page.locator(repoTab(repo))).toBeVisible();
    await expect(page.locator(byTestId(TID.authMessage))).toHaveCount(0);
    await expect(page).toHaveTitle('worktree-term');
  });

  test('switching from one remote to another goes through the home page', async ({ hub, page, ssh }) => {
    test.setTimeout(180_000);
    const box = await remoteHub(hub, ssh, 'box', [hub.port]);
    const gpu = await remoteHub(hub, ssh, 'gpu', [hub.port, box.port]);
    const boxPort = await tunnelPort(hub, box, gpu);
    const gpuPort = await tunnelPort(hub, box, gpu, { port: boxPort });
    await home(hub, page, [
      { name: 'box', ssh: 'box', port: boxPort },
      { name: 'gpu', ssh: 'gpu', port: gpuPort },
    ]);
    await pick(page, 'box');
    await landedOn(page, originOf(boxPort));
    const visited: string[] = [];
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) visited.push(frame.url());
    });

    await pick(page, 'gpu');
    await landedOn(page, originOf(gpuPort));
    await expect(page).toHaveTitle('worktree-term — gpu');
    await expect(page.locator(repoTab(gpu.repo))).toBeVisible();
    expect(visited).toContain(`${hub.origin}/#hub=gpu`);
  });
});

test.describe('hub opening status', () => {
  test('shows the opening while the host has not answered', async ({ hub, page, ssh }) => {
    const remote = ssh.addHost('box');
    remote.plantWtd('exec sleep 600');
    await home(hub, page, [{ name: 'box', ssh: 'box' }]);
    await pick(page, 'box');
    await expect(page.locator(byTestId(TID.hubStatus))).toHaveText('Opening box…');
    expect(page.url()).toBe(`${hub.origin}/`);
  });

  test('an opening the lost hub connection ended shows as failed, with a ×', async ({ hub, page, ssh }) => {
    ssh.addHost('box').plantWtd('exec sleep 600');
    await home(hub, page, [{ name: 'box', ssh: 'box' }]);
    await pick(page, 'box');
    const status = page.locator(byTestId(TID.hubStatus));
    await expect(status).toHaveText('Opening box…');
    // Killed, not stopped: the fake remote's `sleep` keeps a SIGTERMed hub's daemon-link pipes open.
    for (const pid of hub.hubPids()) process.kill(pid, 'SIGKILL');
    await expect(status).toContainText('box: the connection to the hub closed');
    await expect(status.locator(byTestId(TID.hubDismiss))).toBeVisible();
  });

  test('shows the Tailscale login link while waiting, then navigates once approved', async ({ hub, page, ssh }) => {
    test.setTimeout(120_000);
    const box = await remoteHub(hub, ssh, 'box', [hub.port]);
    const port = await tunnelPort(hub, box);
    await home(hub, page, [{ name: 'box', ssh: 'box', port }]);
    ssh.loginHost('box');
    await pick(page, 'box');
    const status = page.locator(byTestId(TID.hubStatus));
    await expect(status).toContainText('box needs Tailscale login', { timeout: 15_000 });
    const link = status.locator(byTestId(TID.hubLogin));
    await expect(link).toHaveText('Open login link');
    await expect(link).toHaveAttribute('href', /^https:\/\/login\.tailscale\.com\/a\/wtd\d+$/);
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /\bnoopener\b/);
    await expect(link).toHaveAttribute('rel', /\bnoreferrer\b/);

    const url = (await link.getAttribute('href')) ?? '';
    ssh.skipLogin('box');
    ssh.approveLogin(url);
    await landedOn(page, originOf(port));
    await expect(page).toHaveTitle('worktree-term — box');
  });

  test('an outdated remote is reinstalled from the status line, then opened', async ({ hub, page, ssh, wire }) => {
    test.setTimeout(180_000);
    const remote = nodeRemote(ssh, 'box');
    remote.plantWtd('exit 2');
    const remotePort = await tunnelPort(hub);
    remote.writeHubConfig({ port: remotePort, repos: [makeRepo(join(remote.home, 'app'))] });
    const port = await tunnelPort(hub, { port: remotePort });
    await home(hub, page, [{ name: 'box', ssh: 'box', port }]);

    await pick(page, 'box');
    const status = page.locator(byTestId(TID.hubStatus));
    await expect(status).toContainText(/^box: .*missing or too old/, { timeout: 15_000 });
    const reinstall = status.locator(byTestId(TID.hubReinstall));
    await expect(reinstall).toHaveText('Reinstall on box');
    const mark = wire.markSent();
    await reinstall.click();
    await expect(status).toHaveText('Installing on box…');
    await landedOn(page, originOf(port));
    expect(hubRequests(wire, mark).map((m) => m.t)).toEqual(['installHub', 'openHub']);
  });

  test('a failure shows its reason with a × that clears it, leaving the tab home', async ({ hub, page, ssh }) => {
    ssh.failHost('box', RESOLVE_ERROR);
    await home(hub, page, [{ name: 'box', ssh: 'box' }]);
    await pick(page, 'box');
    const status = page.locator(byTestId(TID.hubStatus));
    await expect(status).toContainText(`box: ${RESOLVE_ERROR}`, { timeout: 15_000 });
    await status.locator(byTestId(TID.hubDismiss)).click();
    await expect(page.locator(byTestId(TID.hubStatus))).toHaveCount(0);
    expect(page.url()).toBe(`${hub.origin}/`);
  });
});

test.describe('hub opening from the address', () => {
  test('wtd ui <host> opens that host’s hub without a click', async ({ hub, page, ssh }) => {
    test.setTimeout(120_000);
    const box = await remoteHub(hub, ssh, 'box', [hub.port]);
    const port = await tunnelPort(hub, box);
    const { repo } = makeRepoWith(hub, 'local-app', []);
    writeHubConfig(hub, { repos: [repo], hosts: [{ name: 'box', ssh: 'box', port }] });
    await page.goto(await runUi(hub, ['box']));
    await landedOn(page, originOf(port));
    await expect(page.locator(repoTab(box.repo))).toBeVisible();
  });

  test('a hub no remote host carries is reported and the page stays', async ({ hub, page, ssh, wire }) => {
    ssh.failHost('box', RESOLVE_ERROR);
    const { repo } = makeRepoWith(hub, 'local-app', []);
    writeHubConfig(hub, { repos: [repo], hosts: [{ name: 'box', ssh: 'box' }] });
    await page.goto(`${await runUi(hub)}&hub=nope`);
    await expect(page.locator(byTestId(TID.hubStatus))).toHaveText('no host named nope');
    await expect(page.locator(repoTab(repo))).toBeVisible();
    expect(page.url()).toBe(`${hub.origin}/`);
    expect(hubRequests(wire).filter((m) => m.t === 'openHub')).toEqual([]);
  });

  test('a malformed fragment is removed and ignored, the stored token connecting', async ({ hub, page, ssh, wire }) => {
    ssh.failHost('box', RESOLVE_ERROR);
    const repo = await home(hub, page, [{ name: 'box', ssh: 'box' }]);
    await page.goto('about:blank');
    await page.goto(`${hub.origin}/#code=x&hub=a b`);
    await expect(page.locator(repoTab(repo))).toBeVisible();
    await expect(page.locator(byTestId(TID.authMessage))).toHaveCount(0);
    expect(await page.evaluate(() => location.hash)).toBe('');
    await page.waitForTimeout(1000); // NOSONAR(S2925) — absence check: nothing to synchronise on
    expect(hubRequests(wire).filter((m) => m.t === 'openHub')).toEqual([]);
    await expect(page.locator(byTestId(TID.hubStatus))).toHaveCount(0);
  });
});
