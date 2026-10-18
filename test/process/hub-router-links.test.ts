import { hostname } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { DAEMON_PROTOCOL_VERSION } from '../../src/protocol/index.js';
import { alive, sleep, waitUntil } from '../support/daemon-host.js';
import { FakeDaemon } from '../support/fake-daemon.js';
import { ANY_INSTANCE, connected, fx, instanceOf, packageVersion, started, useHubRouterHost, watching } from '../support/hub-router.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });
useHubRouterHost();

describe('daemon links and host status', () => {
  it('starts the daemon and reports host 0 connected with its instance', async () => {
    expect(fx.host.daemonPids()).toEqual([]);
    const client = await fx.host.session();
    const entry = await connected(client);
    expect(entry).toEqual({
      idx: 0,
      name: hostname().slice(0, 64) || 'local',
      remote: false,
      status: 'connected',
      reason: null,
      daemonVersion: packageVersion(),
      instance: ANY_INSTANCE,
      login: null,
      repos: [fx.repo],
    });
    expect(fx.host.daemonPids()).toHaveLength(1);
    const daemon = await fx.host.client();
    expect((await daemon.handshake()).instance).toBe(entry.instance);
  });

  it('reports reconnecting, then connected with a new instance, when the daemon is killed', async () => {
    const client = await fx.host.session();
    const first = await instanceOf(client);
    const [pid] = fx.host.daemonPids();
    if (pid === undefined) throw new Error('no daemon');
    const from = client.mark();
    process.kill(pid, 'SIGKILL');
    expect(await client.waitHost(0, (h) => h.status === 'reconnecting', { from })).toMatchObject({ instance: null });
    const second = await instanceOf(client, from);
    expect(second).not.toBe(first);
  });

  it.each([
    ['an older', 3],
    ['a newer', 99],
  ])('reports a daemon of %s protocol as outdated with its version and instance, keeping the link', async (_name, protocol) => {
    const fake = await FakeDaemon.listen(fx.host.socket, { protocol, version: '9.9.9', instance: 'old_D-1' });
    const client = await fx.host.session();
    expect(await client.waitHost(0, (h) => h.status === 'outdated')).toMatchObject({
      daemonVersion: '9.9.9',
      instance: 'old_D-1',
      reason: null,
    });
    await sleep(1000);
    expect(fake.connections).toBe(1);
    expect(client.hosts()[0]?.status).toBe('outdated');
  });

  it('reports reconnecting, then down after 3 failures, and keeps retrying', async () => {
    const fake = await FakeDaemon.listen(fx.host.socket, { protocol: DAEMON_PROTOCOL_VERSION, accept: 'close' });
    const client = await fx.host.session();
    await client.waitHost(0, (h) => h.status === 'reconnecting');
    await client.waitHost(0, (h) => h.status === 'down', { timeout: 10_000 });
    expect(fake.connections).toBeGreaterThanOrEqual(3);
    const atDown = fake.connections;
    await waitUntil(() => fake.connections >= atDown + 2, 'retries while down', 15_000);
    expect(client.hosts()[0]?.status).toBe('down');
  });
});

describe('daemon restart', () => {
  it.each([
    ['an older', 3],
    ['a newer', 99],
  ])('restarts an outdated daemon of %s protocol into one speaking the hub’s protocol', async (_name, protocol) => {
    const fake = await FakeDaemon.listen(fx.host.socket, { protocol });
    const client = await fx.host.session();
    await client.waitHost(0, (h) => h.status === 'outdated');
    const from = client.mark();
    const reply = await client.hubRequest({ t: 'restartDaemon', host: 0 }, 15_000);
    expect(reply).toEqual({ from: 'hub', m: { t: 'done', req: 1 } });
    expect(fake.shutdowns).toBe(1);
    await fake.closed;
    expect(await instanceOf(client, from)).not.toBe('fake_instance');
    // A daemon the session's reconnect started alongside the restart refuses to start and exits.
    await waitUntil(() => fx.host.daemonPids().length === 1, 'one daemon');
    const direct = await fx.host.client();
    expect((await direct.handshake()).protocol).toBe(DAEMON_PROTOCOL_VERSION);
  });

  it('restarts a newer daemon whose messages after hello are not valid for the hub’s protocol', async () => {
    const fake = await FakeDaemon.listen(fx.host.socket, {
      protocol: DAEMON_PROTOCOL_VERSION + 1,
      instance: 'newer_1',
      afterHello: ['{"t":"frobnicated","widgets":[1,2,3]}', '{"t":"repoState","repo":7}'],
    });
    const client = await fx.host.session();
    await client.waitHost(0, (h) => h.status === 'outdated');
    const from = client.mark();
    const reply = await client.hubRequest({ t: 'restartDaemon', host: 0 }, 15_000);
    expect(reply).toEqual({ from: 'hub', m: { t: 'done', req: 1 } });
    expect(fake.shutdowns).toBe(1);
    await fake.closed;
    const entry = await client.waitHost(0, (h) => h.status === 'connected', { from, timeout: 10_000 });
    expect(entry.instance).not.toBe('newer_1');
    expect(entry.daemonVersion).toBe(packageVersion());
  });

  it('shares one restart between concurrent requests from two sessions', async () => {
    const a = await fx.host.session();
    const b = await fx.host.session();
    const old = await instanceOf(a);
    await connected(b);
    const oldPid = await waitUntil(() => {
      const pids = fx.host.daemonPids();
      return pids.length === 1 ? pids[0] : undefined;
    }, 'one daemon');
    const fromA = a.mark();
    const fromB = b.mark();
    const replies = await Promise.all([
      a.hubRequest({ t: 'restartDaemon', host: 0 }, 15_000),
      b.hubRequest({ t: 'restartDaemon', host: 0 }, 15_000),
    ]);
    expect(replies.map((r) => r.m.t)).toEqual(['done', 'done']);
    // `done` follows the old daemon's socket going quiet; its process may still be exiting.
    await waitUntil(() => !alive(oldPid), 'the old daemon to exit');
    const newA = await instanceOf(a, fromA);
    const newB = await instanceOf(b, fromB);
    expect(newA).not.toBe(old);
    expect(newB).toBe(newA);
    // Both sessions reached the new daemon, so every reconnect has dialled; daemons they started alongside it exit.
    await waitUntil(() => fx.host.daemonPids().length === 1, 'one daemon');
    await sleep(500);
    expect(fx.host.daemonPids()).toHaveLength(1);
  });

  it('answers internal when the daemon does not go away within 10 s', async () => {
    const fake = await FakeDaemon.listen(fx.host.socket, { protocol: 99, onShutdown: 'ignore' });
    const client = await fx.host.session();
    await client.waitHost(0, (h) => h.status === 'outdated');
    const sentAt = Date.now();
    const reply = await client.hubRequest({ t: 'restartDaemon', host: 0 }, 20_000);
    expect(reply).toMatchObject({ from: 'hub', m: { t: 'error', req: 1, code: 'internal' } });
    expect(Date.now() - sentAt).toBeGreaterThanOrEqual(9500);
    expect(fake.shutdowns).toBe(1);
  });

  it('answers host-unavailable for a host that is not connected or outdated', async () => {
    const fake = await FakeDaemon.listen(fx.host.socket, { protocol: DAEMON_PROTOCOL_VERSION, accept: 'close' });
    const client = await fx.host.session();
    await client.waitHost(0, (h) => h.status === 'reconnecting' || h.status === 'down');
    const reply = await client.hubRequest({ t: 'restartDaemon', host: 0 });
    expect(reply).toMatchObject({ from: 'hub', m: { t: 'error', req: 1, host: 0, code: 'host-unavailable' } });
    expect(fake.shutdowns).toBe(0);
  });
});

describe('session end and hub shutdown', () => {
  it('keeps terminals running when a session closes', async () => {
    const first = await watching();
    const term = await started(first, null);
    const [daemonPid] = fx.host.daemonPids();
    first.close();
    await sleep(500);
    const second = await watching();
    const state = second.daemonEvents(0, 'repoState').at(-1);
    expect(state?.terminals.find((t) => t.termId === term.termId)?.exit).toBeNull();
    expect(fx.host.daemonPids()).toEqual([daemonPid]);
  });

  it('closes sessions with 1001 on SIGTERM and exits 0, leaving the daemon running', async () => {
    const client = await watching();
    const [daemonPid] = fx.host.daemonPids();
    fx.hub.kill('SIGTERM');
    await client.waitClosed();
    expect(client.closeCode).toBe(1001);
    expect(await fx.hub.exited).toEqual({ code: 0, signal: null });
    expect(alive(daemonPid ?? 0)).toBe(true);
  });

  it('closes sessions with 1001 on an authenticated shutdown request', async () => {
    const client = await fx.host.session();
    await fx.host.api('POST', '/api/shutdown');
    await client.waitClosed();
    expect(client.closeCode).toBe(1001);
    expect(await fx.hub.exited).toEqual({ code: 0, signal: null });
  });
});
