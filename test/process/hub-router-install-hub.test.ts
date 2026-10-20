import { describe, expect, it, vi } from 'vitest';
import { alive, sleep, waitUntil } from '../support/daemon-host.js';
import { FakeDaemon } from '../support/fake-daemon.js';
import {
  configure,
  connectRuns,
  fx,
  INSTALL_TIMEOUT,
  installedBox,
  PRINT_CODE,
  REMOTE_TIMEOUT,
  remoteInstance,
  restartHub,
  useHubRouterHost,
} from '../support/hub-router.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });
useHubRouterHost();

/** Pids of the SSH runs of `alias` that installed: neither connect, print-code nor a forward. */
const installRuns = (alias = 'box'): number[] =>
  fx.ssh
    .calls()
    .filter((call) => call.alias === alias && call.forward === null && !call.command.includes('connect') && call.command !== PRINT_CODE)
    .map((call) => call.pid);

describe('installing for a hub', () => {
  it(
    'installs the hub’s bundle and answers done, leaving the remote daemon and its terminal running',
    async () => {
      const { remote, remoteRepo } = await installedBox();
      const client = await fx.host.session();
      const instance = await remoteInstance(client, 1);
      const [daemonPid] = remote.daemonPids();
      await client.watch(1, remoteRepo);
      const term = await client.create(1, remoteRepo);
      const releases = remote.releases();
      expect(await client.hubRequest({ t: 'installHub', host: 1 }, INSTALL_TIMEOUT)).toEqual({ from: 'hub', m: { t: 'done', req: 3 } });
      expect(remote.releases()).toHaveLength(releases.length + 1);
      expect(remote.daemonPids()).toEqual([daemonPid]);
      expect((await remote.hello()).instance).toBe(instance);
      const state = await client.watch(1, remoteRepo);
      expect(state.terminals.find((t) => t.termId === term.termId)?.exit).toBeNull();
    },
    INSTALL_TIMEOUT + 30_000,
  );

  it(
    'never shuts down a remote daemon of another version',
    async () => {
      const { remote } = await installedBox();
      const fake = await FakeDaemon.listen(remote.socket, { protocol: 4, version: '0.0.4', instance: 'old_remote' });
      const client = await fx.host.session();
      await client.waitHost(1, (h) => h.status === 'outdated', { timeout: REMOTE_TIMEOUT });
      const releases = remote.releases();
      expect(await client.hubRequest({ t: 'installHub', host: 1 }, INSTALL_TIMEOUT)).toEqual({ from: 'hub', m: { t: 'done', req: 1 } });
      expect(remote.releases()).toHaveLength(releases.length + 1);
      await sleep(500);
      expect(fake.shutdowns).toBe(0);
      expect(client.hosts()[1]).toMatchObject({ status: 'outdated', instance: 'old_remote' });
    },
    INSTALL_TIMEOUT + 30_000,
  );

  it(
    'shares a running reinstall, installing once',
    async () => {
      const { remote } = await installedBox();
      await FakeDaemon.listen(remote.socket, { protocol: 4, version: '0.0.4', instance: 'old_remote' });
      const a = await fx.host.session();
      const b = await fx.host.session();
      await a.waitHost(1, (h) => h.status === 'outdated', { timeout: REMOTE_TIMEOUT });
      const releases = remote.releases();
      const installs = installRuns().length;
      const release = fx.ssh.holdHost('box');
      const reinstall = a.hubRequest({ t: 'reinstallDaemon', host: 1 }, INSTALL_TIMEOUT);
      await waitUntil(() => installRuns().length > installs, 'the reinstall’s installation to start', REMOTE_TIMEOUT);
      const install = b.hubRequest({ t: 'installHub', host: 1 }, INSTALL_TIMEOUT);
      await sleep(500);
      expect(installRuns()).toHaveLength(installs + 1);
      release();
      const [ra, rb] = await Promise.all([reinstall, install]);
      expect(installRuns()).toHaveLength(installs + 1);
      expect(ra.m.t).toBe('done');
      expect(rb.m.t).toBe('done');
      expect(remote.releases()).toHaveLength(releases.length + 1);
    },
    INSTALL_TIMEOUT + 30_000,
  );

  it(
    'starts a restart requested during an install only after the install ended',
    async () => {
      const { remote } = await installedBox();
      const a = await fx.host.session();
      const b = await fx.host.session();
      const old = await remoteInstance(a, 1);
      const connects = new Set(connectRuns());
      const laterConnects = (): number[] => connectRuns().filter((pid) => !connects.has(pid));
      const installs = new Set(installRuns());
      const release = fx.ssh.holdHost('box');
      const install = a.hubRequest({ t: 'installHub', host: 1 }, INSTALL_TIMEOUT);
      const run = await waitUntil(() => installRuns().find((pid) => !installs.has(pid)), 'the installation to start', REMOTE_TIMEOUT);
      const restart = b.hubRequest({ t: 'restartDaemon', host: 1 }, INSTALL_TIMEOUT);
      await sleep(500);
      expect(laterConnects()).toEqual([]);
      release();
      await waitUntil(() => laterConnects().length > 0, 'the restart to dial', INSTALL_TIMEOUT);
      expect(alive(run)).toBe(false);
      expect((await install).m.t).toBe('done');
      expect((await restart).m.t).toBe('done');
      expect((await remote.hello()).instance).not.toBe(old);
    },
    INSTALL_TIMEOUT + 30_000,
  );

  it('answers unknown-host for the local host', async () => {
    const client = await fx.host.session();
    expect((await client.hubRequest({ t: 'installHub', host: 0 })).m).toMatchObject({ t: 'error', req: 1, host: 0, code: 'unknown-host' });
  });

  it('answers unknown-host for a host removed from config.json since the session started, installing nothing', async () => {
    fx.ssh.addHost('box');
    configure([{ name: 'box', ssh: 'box' }]);
    const client = await fx.host.session();
    configure([]);
    expect((await client.hubRequest({ t: 'installHub', host: 1 })).m).toMatchObject({ t: 'error', req: 1, host: 1, code: 'unknown-host' });
    expect(installRuns()).toEqual([]);
  });

  it('installs over the alias config.json names now, not the one the session started with', async () => {
    fx.ssh.addHost('box');
    configure([{ name: 'box', ssh: 'old' }]);
    const client = await fx.host.session();
    configure([{ name: 'box', ssh: 'box' }]);
    expect((await client.hubRequest({ t: 'installHub', host: 1 }, INSTALL_TIMEOUT)).m).toMatchObject({
      t: 'error',
      host: 1,
      code: 'internal',
    });
    expect(installRuns('box').length).toBeGreaterThan(0);
    expect(installRuns('old')).toEqual([]);
  });

  it.each(['installHub', 'reinstallDaemon'] as const)('ends a %s that outlasts WTD_HUB_INSTALL_MS with internal', async (t) => {
    fx.ssh.addHost('box');
    fx.ssh.hangHost('box');
    configure([{ name: 'box', ssh: 'box' }]);
    await restartHub({ WTD_HUB_INSTALL_MS: '1000' });
    const client = await fx.host.session();
    const start = Date.now();
    expect((await client.hubRequest({ t, host: 1 }, 15_000)).m).toMatchObject({ t: 'error', req: 1, host: 1, code: 'internal' });
    expect(Date.now() - start).toBeLessThan(10_000);
  });

  it(
    'answers internal naming the cause when the installation fails',
    async () => {
      fx.ssh.addHost('box');
      configure([{ name: 'box', ssh: 'box' }]);
      const client = await fx.host.session();
      const reply = await client.hubRequest({ t: 'installHub', host: 1 }, INSTALL_TIMEOUT);
      expect(reply.m).toMatchObject({ t: 'error', req: 1, host: 1, code: 'internal' });
      expect(reply.m.t === 'error' ? reply.m.message : '').toMatch(/node/i);
    },
    INSTALL_TIMEOUT + 30_000,
  );
});
