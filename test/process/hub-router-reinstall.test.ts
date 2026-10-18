import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { alive, sleep, waitUntil } from '../support/daemon-host.js';
import { FakeDaemon } from '../support/fake-daemon.js';
import {
  configure,
  connectedHost,
  host,
  INSTALL_TIMEOUT,
  installedBox,
  instanceOf,
  nodeRemote,
  packageVersion,
  REMOTE_TIMEOUT,
  remoteInstance,
  ssh,
  useHubRouterHost,
} from '../support/hub-router.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });
useHubRouterHost();

describe('remote daemon restart and reinstall', () => {
  it('restarts a connected remote daemon into a new instance', async () => {
    const { remote } = await installedBox();
    const client = await host.session();
    const old = await remoteInstance(client, 1);
    const [oldPid] = remote.daemonPids();
    const from = client.mark();
    const reply = await client.hubRequest({ t: 'restartDaemon', host: 1 }, 20_000);
    expect(reply).toEqual({ from: 'hub', m: { t: 'done', req: 1 } });
    expect(await remoteInstance(client, 1, from)).not.toBe(old);
    await waitUntil(() => oldPid !== undefined && !alive(oldPid), 'the old remote daemon to exit');
    await waitUntil(() => remote.daemonPids().length === 1, 'one remote daemon');
  });

  it(
    'reinstalls an outdated remote: installs the hub’s bundle, shuts the old daemon down and connects to the new one',
    async () => {
      const { remote } = await installedBox();
      const releases = remote.releases();
      const fake = await FakeDaemon.listen(remote.socket, { protocol: 4, version: '0.0.4', instance: 'old_remote' });
      const client = await host.session();
      expect(await client.waitHost(1, (h) => h.status === 'outdated', { timeout: REMOTE_TIMEOUT })).toMatchObject({
        daemonVersion: '0.0.4',
        instance: 'old_remote',
      });
      const from = client.mark();
      const reply = await client.hubRequest({ t: 'reinstallDaemon', host: 1 }, INSTALL_TIMEOUT);
      expect(reply).toEqual({ from: 'hub', m: { t: 'done', req: 1 } });
      expect(fake.shutdowns).toBeGreaterThanOrEqual(1);
      const entry = await connectedHost(client, 1, from);
      expect(entry).toMatchObject({ daemonVersion: packageVersion() });
      expect(remote.releases()).toHaveLength(2);
      expect(remote.releases()).toEqual(expect.arrayContaining(releases));
      expect(remote.current()).not.toBe(join('versions', releases[0] ?? ''));
    },
    INSTALL_TIMEOUT + 30_000,
  );

  it(
    'installs wtd on a down remote that never had it and connects',
    async () => {
      const remote = nodeRemote('box');
      configure([{ name: 'box', ssh: 'box' }]);
      const client = await host.session();
      await client.waitHost(1, (h) => h.status === 'down', { timeout: 10_000 });
      const from = client.mark();
      const reply = await client.hubRequest({ t: 'reinstallDaemon', host: 1 }, INSTALL_TIMEOUT);
      expect(reply).toEqual({ from: 'hub', m: { t: 'done', req: 1 } });
      expect(await connectedHost(client, 1, from)).toMatchObject({ daemonVersion: packageVersion() });
      expect(remote.releases()).toHaveLength(1);
      expect(existsSync(remote.shim)).toBe(true);
    },
    INSTALL_TIMEOUT + 30_000,
  );

  it(
    'reports an installation failure as internal, naming the install step and the missing Node',
    async () => {
      ssh.addHost('box');
      configure([{ name: 'box', ssh: 'box' }]);
      const client = await host.session();
      await client.waitHost(1, (h) => h.status === 'down', { timeout: 10_000 });
      const reply = await client.hubRequest({ t: 'reinstallDaemon', host: 1 }, INSTALL_TIMEOUT);
      expect(reply).toMatchObject({ from: 'hub', m: { t: 'error', req: 1, host: 1, code: 'internal' } });
      const message = reply.m.t === 'error' ? reply.m.message : '';
      expect(message).toMatch(/^install:/);
      expect(message).toMatch(/node/i);
    },
    INSTALL_TIMEOUT + 30_000,
  );

  it(
    'lets a restart requested during a reinstall share it',
    async () => {
      const { remote } = await installedBox();
      await FakeDaemon.listen(remote.socket, { protocol: 4, version: '0.0.4', instance: 'old_remote' });
      const a = await host.session();
      const b = await host.session();
      await a.waitHost(1, (h) => h.status === 'outdated', { timeout: REMOTE_TIMEOUT });
      await b.waitHost(1, (h) => h.status === 'outdated', { timeout: REMOTE_TIMEOUT });
      const fromA = a.mark();
      const fromB = b.mark();
      const reinstall = a.hubRequest({ t: 'reinstallDaemon', host: 1 }, INSTALL_TIMEOUT);
      await sleep(200);
      const restart = b.hubRequest({ t: 'restartDaemon', host: 1 }, INSTALL_TIMEOUT);
      const [ra, rb] = await Promise.all([reinstall, restart]);
      expect(ra.m.t).toBe('done');
      expect(rb.m.t).toBe('done');
      const instanceA = await remoteInstance(a, 1, fromA);
      expect(await remoteInstance(b, 1, fromB)).toBe(instanceA);
      await waitUntil(() => remote.daemonPids().length === 1, 'one remote daemon');
      await sleep(500);
      expect(remote.daemonPids()).toHaveLength(1);
      expect(remote.releases()).toHaveLength(2);
    },
    INSTALL_TIMEOUT + 30_000,
  );

  it('refuses to reinstall the local host, touching no daemon', async () => {
    const client = await host.session();
    const instance = await instanceOf(client);
    const [pid] = host.daemonPids();
    const reply = await client.hubRequest({ t: 'reinstallDaemon', host: 0 });
    expect(reply).toMatchObject({ from: 'hub', m: { t: 'error', req: 1, host: 0, code: 'internal' } });
    await sleep(500);
    expect(host.daemonPids()).toEqual([pid]);
    expect(client.hosts()[0]).toMatchObject({ status: 'connected', instance });
  });

  it('answers a reinstall for an unknown host with unknown-host', async () => {
    const client = await host.session();
    const reply = await client.hubRequest({ t: 'reinstallDaemon', host: 7 });
    expect(reply).toMatchObject({ from: 'hub', m: { t: 'error', req: 1, code: 'unknown-host' } });
  });
});
