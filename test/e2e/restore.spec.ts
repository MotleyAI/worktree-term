import { waitUntil } from '../support/daemon-host.js';
import { FakeDaemon } from '../support/fake-daemon.js';
import { byTestId, hostBanner, terminalBox, termTab, TID, worktreeEntry } from './contract.js';
import {
  confirmAction,
  expect,
  hubRequests,
  isCurrent,
  LOCAL,
  makeRepoWith,
  newTerminal,
  oneDaemon,
  openHostAction,
  openUi,
  ready,
  refuseBrowserDialogs,
  screenOf,
  stopHub,
  test,
  typeLine,
  waitScreen,
  watcher,
  xtermOf,
} from './fixture.js';

test.describe('reconnect and restore', () => {
  test('a hub restart keeps each terminal object and its screen', async ({ hub, page, wire }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const term = await newTerminal(page);
    await ready(page, term);
    await typeLine(page, term, "echo KEEP''-MARK");
    const before = await waitScreen(page, term, 'KEEP-MARK');
    const xterm = await xtermOf(page, term);

    await stopHub(hub);
    await expect(page.locator(byTestId(TID.reconnecting))).toBeVisible();
    const mark = wire.markSent();
    await hub.startHub();
    await expect(page.locator(byTestId(TID.reconnecting))).toBeHidden({ timeout: 15_000 });
    await expect.poll(() => wire.attachesSent(LOCAL, term, mark), { timeout: 10_000 }).toBeGreaterThan(0);
    await expect.poll(() => screenOf(page, term)).toBe(before);
    expect(await isCurrent(page, xterm, `${terminalBox(LOCAL, term)} .xterm`)).toBe(true);

    await typeLine(page, term, "echo AFTER''-RESTART");
    await waitScreen(page, term, 'AFTER-RESTART');
    expect(await isCurrent(page, xterm, `${terminalBox(LOCAL, term)} .xterm`)).toBe(true);
  });

  test('a terminal closed while the hub was down is removed once the page reconnects', async ({ hub, page }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const closed = await newTerminal(page);
    const kept = await newTerminal(page);
    await ready(page, kept);
    const xterm = await xtermOf(page, closed);

    await stopHub(hub);
    await expect(page.locator(byTestId(TID.reconnecting))).toBeVisible();
    const direct = await watcher(hub, repo);
    await direct.ok({ t: 'closeTerm', termId: closed });
    direct.close();
    await hub.startHub();
    await expect(page.locator(byTestId(TID.reconnecting))).toBeHidden({ timeout: 15_000 });
    await expect.poll(() => xterm.evaluate((e) => e.isConnected), { timeout: 10_000 }).toBe(false);
    await expect(page.locator(termTab(closed))).toHaveCount(0);
    await expect(page.locator(termTab(kept))).toBeVisible();
  });

  test('a new daemon instance drops the old terminals', async ({ hub, page }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const term = await newTerminal(page);
    await ready(page, term);
    const xterm = await xtermOf(page, term);

    const old = await oneDaemon(hub);
    process.kill(old, 'SIGKILL');
    await waitUntil(
      () => {
        const pids = hub.daemonPids();
        return pids.length === 1 && pids[0] !== old;
      },
      'a new daemon',
      15_000,
    );
    await expect.poll(() => xterm.evaluate((e) => e.isConnected), { timeout: 15_000 }).toBe(false);
    await expect(page.locator(byTestId(TID.termTab))).toHaveCount(0);

    const fresh = await newTerminal(page);
    await ready(page, fresh);
    const freshXterm = await xtermOf(page, fresh);
    expect(await page.evaluate(([a, b]) => a === b, [xterm, freshXterm] as const)).toBe(false);
    expect(await xterm.evaluate((e) => e.isConnected)).toBe(false);
  });

  test('a full-screen program shows the same screen after a reload', async ({ hub, page }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const term = await newTerminal(page);
    await ready(page, term);
    await typeLine(page, term, "printf '\\033[?1049h\\033[H\\033[2JFULL''-SCREEN-MARK\\n'; sleep 600");
    const before = await waitScreen(page, term, 'FULL-SCREEN-MARK');
    expect(before).not.toContain('READY-MARK');

    await page.reload();
    await expect(page.locator(terminalBox(LOCAL, term))).toBeVisible();
    await expect.poll(() => screenOf(page, term), { timeout: 10_000 }).toBe(before);
  });
});

test.describe('outdated host', () => {
  test('restarting an outdated daemon through the in-page confirmation shows the repos again', async ({ hub, page, wire }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    const fake = await FakeDaemon.listen(hub.socket, { protocol: 99, version: '9.9.9' });
    try {
      const browserDialogs = refuseBrowserDialogs(page);
      await openUi(hub, page);
      await expect(page.locator(hostBanner(LOCAL))).toContainText('outdated');
      const mark = wire.markSent();
      await openHostAction(page, LOCAL, 'Restart daemon');
      expect(hubRequests(wire, mark)).toEqual([]);
      await confirmAction(page);
      await fake.closed;
      expect(fake.shutdowns).toBe(1);
      await expect.poll(() => hubRequests(wire, mark)).toEqual([{ t: 'restartDaemon', host: LOCAL }]);
      await expect(page.locator(hostBanner(LOCAL))).toHaveCount(0, { timeout: 15_000 });
      await expect(page.locator(worktreeEntry(repo))).toBeVisible();
      await oneDaemon(hub);
      expect(browserDialogs).toEqual([]);
    } finally {
      await fake.close().catch(() => undefined);
    }
  });
});
