import { existsSync, readFileSync, symlinkSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FLOW_HIGH, FrameKind, PROTOCOL_VERSION, type Terminal } from '../../src/protocol/index.js';
import { addWorktree, alive, DaemonHost, makeRepo, residentBytes, sleep, waitUntil, type WtdProcess } from '../support/daemon-host.js';
import { FakeDaemon, SocketProxy } from '../support/fake-daemon.js';
import type { HubClient } from '../support/hub-client.js';
import { HubHost } from '../support/hub-host.js';
import { REPO_ROOT } from '../support/exec.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

const ANY_TEXT: unknown = expect.any(String);
const ANY_INSTANCE: unknown = expect.stringMatching(/^[A-Za-z0-9_-]{1,64}$/);

const KiB = 1024;
const MiB = 1024 * KiB;

let host: HubHost;
let hub: WtdProcess;
let repo: string;
let wt: string;

beforeEach(async () => {
  host = await HubHost.createHub();
  repo = makeRepo(join(host.dir, 'repo'));
  wt = addWorktree(repo, join(host.dir, 'wt'), 'wt');
  host.writeRepos([repo]);
  hub = await host.startHub();
});

afterEach(async () => {
  await host.cleanup();
});

const packageVersion = (): string => {
  const pkg: unknown = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  if (typeof pkg !== 'object' || pkg === null || !('version' in pkg) || typeof pkg.version !== 'string') throw new Error('no version');
  return pkg.version;
};

const connected = (client: HubClient, from = 0, timeout = 10_000): Promise<{ instance: string | null }> =>
  client.waitHost(0, (h) => h.status === 'connected', { from, timeout });

/** Instance of host 0 once `connected`. */
const instanceOf = async (client: HubClient, from = 0): Promise<string> => {
  const { instance } = await connected(client, from);
  if (instance === null) throw new Error('connected without an instance');
  return instance;
};

/** Creates a terminal, attaches, and for a shell waits until it ran a command. */
const started = async (client: HubClient, command: string | null, worktree = wt): Promise<Terminal> => {
  const term = await client.create(0, worktree, { command });
  await client.attach(0, term.termId);
  if (command === null) {
    client.sendInput(0, term.termId, 'echo READY-$((6*7))\r');
    await client.waitOutput(0, term.termId, 'READY-42\r\n', 10_000);
    await sleep(300);
  }
  return term;
};

/** A connected session watching the repo. */
const watching = async (): Promise<HubClient> => {
  const client = await host.session();
  await connected(client);
  await client.watch(0, repo);
  return client;
};

describe('configuration snapshots', () => {
  it('lists no repos when the configuration has none', async () => {
    host.writeConfig({ port: host.port });
    const client = await host.session();
    expect(client.hosts()[0]?.repos).toEqual([]);
  });

  it('lists the configured repos for host 0', async () => {
    const client = await host.session();
    expect(client.hosts()[0]?.repos).toEqual([repo]);
  });

  it('expands ~/ against the home directory without resolving symbolic links', async () => {
    symlinkSync(repo, join(host.home, 'linked'));
    host.writeConfig({ port: host.port, repos: ['~/linked'] });
    const client = await host.session();
    expect(client.hosts()[0]?.repos).toEqual([join(host.home, 'linked')]);
  });

  it('gives a new session an edited configuration, leaving an open session unchanged', async () => {
    const open = await host.session();
    const other = makeRepo(join(host.dir, 'other'));
    host.writeRepos([repo, other]);
    const fresh = await host.session();
    expect(fresh.hosts()[0]?.repos).toEqual([repo, other]);
    await open.expectNone('hosts', (m) => m.hosts.some((h) => h.repos.includes(other)), 1000);
    expect(open.hosts()[0]?.repos).toEqual([repo]);
  });

  it('gives a new session an internal error and the last valid configuration when it became invalid', async () => {
    await host.session();
    host.writeConfig({ port: host.port, repos: [join(host.dir, 'x')], presets: [] });
    const client = await host.open(['wtd', `wtd.token.${host.token()}`]);
    await client.handshake();
    const error = await client.waitFor('error');
    expect(error).toMatchObject({ req: null, host: null, code: 'internal' });
    expect(error.message).toContain('presets');
    expect(client.hosts()[0]?.repos).toEqual([repo]);
  });
});

describe('daemon links and host status', () => {
  it('starts the daemon and reports host 0 connected with its instance', async () => {
    expect(host.daemonPids()).toEqual([]);
    const client = await host.session();
    const entry = await connected(client);
    expect(entry).toEqual({
      idx: 0,
      name: hostname().slice(0, 64) || 'local',
      remote: false,
      status: 'connected',
      daemonVersion: packageVersion(),
      instance: ANY_INSTANCE,
      repos: [repo],
    });
    expect(host.daemonPids()).toHaveLength(1);
    const daemon = await host.client();
    expect((await daemon.handshake()).instance).toBe(entry.instance);
  });

  it('reports reconnecting, then connected with a new instance, when the daemon is killed', async () => {
    const client = await host.session();
    const first = await instanceOf(client);
    const [pid] = host.daemonPids();
    if (pid === undefined) throw new Error('no daemon');
    const from = client.mark();
    process.kill(pid, 'SIGKILL');
    expect(await client.waitHost(0, (h) => h.status === 'reconnecting', { from })).toMatchObject({ instance: null });
    const second = await instanceOf(client, from);
    expect(second).not.toBe(first);
  });

  it('reports a daemon of another protocol as outdated with its version, keeping the link', async () => {
    const fake = await FakeDaemon.listen(host.socket, { protocol: 99, version: '9.9.9' });
    const client = await host.session();
    expect(await client.waitHost(0, (h) => h.status === 'outdated')).toMatchObject({ daemonVersion: '9.9.9', instance: null });
    await sleep(1000);
    expect(fake.connections).toBe(1);
    expect(client.hosts()[0]?.status).toBe('outdated');
  });

  it('reports reconnecting, then down after 3 failures, and keeps retrying', async () => {
    const fake = await FakeDaemon.listen(host.socket, { protocol: PROTOCOL_VERSION, accept: 'close' });
    const client = await host.session();
    await client.waitHost(0, (h) => h.status === 'reconnecting');
    await client.waitHost(0, (h) => h.status === 'down', { timeout: 10_000 });
    expect(fake.connections).toBeGreaterThanOrEqual(3);
    const atDown = fake.connections;
    await waitUntil(() => fake.connections >= atDown + 2, 'retries while down', 15_000);
    expect(client.hosts()[0]?.status).toBe('down');
  });
});

describe('routing', () => {
  it('relays daemon messages and data byte-identically inside their envelopes', async () => {
    const backend = DaemonHost.create();
    try {
      await backend.start();
      const proxy = await SocketProxy.listen(host.socket, backend.socket);
      const client = await host.session();
      await connected(client);
      await client.watch(0, repo);
      const term = await started(client, null);
      client.sendInput(0, term.termId, 'echo round-$((40+2))-trip\r');
      await client.waitOutput(0, term.termId, 'round-42-trip');
      await sleep(500);
      const daemonTexts = proxy.controlTexts().filter((text) => !text.includes('"t":"hello"'));
      expect(daemonTexts.some((text) => text.includes('"t":"repoState"'))).toBe(true);
      expect(daemonTexts.some((text) => text.includes('"t":"termCreated"'))).toBe(true);
      for (const text of daemonTexts)
        expect(
          client.texts.some((envelope) => envelope.includes(text)),
          text,
        ).toBe(true);
      const daemonData = proxy.fromDaemon.filter((f) => f.kind !== FrameKind.control);
      expect(daemonData.some((f) => f.kind === FrameKind.snapshot)).toBe(true);
      expect(client.data.map((d) => d.raw.subarray(0, 3))).toEqual(daemonData.map((f) => Uint8Array.from([f.kind, 0, 0])));
      expect(client.data.map((d) => Buffer.from(d.raw.subarray(3)))).toEqual(daemonData.map((f) => Buffer.from(f.payload)));
      await proxy.close();
    } finally {
      await backend.cleanup();
    }
  });

  it('forwards requests without rewriting their ids, and acks only those the browser sends', async () => {
    const backend = DaemonHost.create();
    try {
      await backend.start();
      const proxy = await SocketProxy.listen(host.socket, backend.socket);
      const client = await host.session();
      await connected(client);
      client.autoAck = false;
      await client.watch(0, repo);
      const term = await started(client, 'seq 1 50000; echo SEQ-DONE; exec sleep 60');
      await client.waitOutput(0, term.termId, 'SEQ-DONE', 10_000);
      await sleep(500);
      const sent = (): unknown[] => proxy.controlTextsToDaemon().map((text): unknown => JSON.parse(text));
      expect(sent()).toContainEqual({ t: 'watchRepo', req: 1, repo });
      expect(sent().filter((m) => typeof m === 'object' && m !== null && 't' in m && m.t === 'ack')).toEqual([]);
      const position = client.view(0, term.termId).position;
      client.sendHost(0, { t: 'ack', termId: term.termId, offset: position });
      await waitUntil(
        () => sent().some((m) => JSON.stringify(m) === JSON.stringify({ t: 'ack', termId: term.termId, offset: position })),
        'the ack',
      );
      await proxy.close();
    } finally {
      await backend.cleanup();
    }
  });

  it('answers a request to a reconnecting host with host-unavailable and drops its fire-and-forget messages', async () => {
    await FakeDaemon.listen(host.socket, { protocol: PROTOCOL_VERSION, accept: 'close' });
    const client = await host.session();
    await client.waitHost(0, (h) => h.status === 'reconnecting' || h.status === 'down');
    const reply = await client.request(0, { t: 'watchRepo', repo });
    expect(reply).toEqual({ from: 'hub', m: { t: 'error', req: 1, host: 0, code: 'host-unavailable', message: ANY_TEXT } });
    const from = client.mark();
    client.sendHost(0, { t: 'ack', termId: 1, offset: 0 });
    client.sendHost(0, { t: 'resize', termId: 1, cols: 80, rows: 24 });
    client.sendHost(0, { t: 'setVisible', termIds: [1] });
    client.sendInput(0, 1, 'x');
    await sleep(500);
    expect(client.messages.slice(from).filter((m) => m.t === 'error')).toEqual([]);
    expect(client.isClosed).toBe(false);
  });

  it('answers a request to an outdated host with version-mismatch', async () => {
    await FakeDaemon.listen(host.socket, { protocol: 99 });
    const client = await host.session();
    await client.waitHost(0, (h) => h.status === 'outdated');
    const reply = await client.request(0, { t: 'watchRepo', repo });
    expect(reply).toMatchObject({ from: 'hub', m: { t: 'error', req: 1, host: 0, code: 'version-mismatch' } });
  });

  it('answers a message for an unknown host with unknown-host', async () => {
    const client = await host.session();
    await connected(client);
    const reply = await client.request(5, { t: 'watchRepo', repo });
    expect(reply).toMatchObject({ from: 'hub', m: { t: 'error', req: 1, code: 'unknown-host' } });
    const from = client.mark();
    client.sendHost(5, { t: 'setVisible', termIds: [] });
    expect(await client.waitFor('error', () => true, { from })).toMatchObject({ req: null, code: 'unknown-host' });
    expect(client.isClosed).toBe(false);
  });

  it('keeps sessions with the same request ids apart', async () => {
    const a = await host.session();
    const b = await host.session();
    await connected(a);
    await connected(b);
    await a.watch(0, repo);
    const term = await b.create(0, wt, { command: 'exec sleep 60' });
    expect(a.daemonEvents(0, 'done').map((m) => m.req)).toEqual([1]);
    expect(b.daemonEvents(0, 'done')).toEqual([]);
    await a.waitEvent(0, 'termCreated', (m) => m.term.termId === term.termId);
    expect(a.daemonEvents(0, 'termCreated').map((m) => m.req)).toEqual([null]);
    expect(b.daemonEvents(0, 'termCreated').map((m) => m.req)).toEqual([1]);
    expect(b.daemonEvents(0, 'repoState')).toEqual([]);
  });

  it.each([
    ['addRepo', { t: 'addRepo', host: 0, repo: '/x' }],
    ['removeRepo', { t: 'removeRepo', host: 0, repo: '/x' }],
    ['discoverRepos', { t: 'discoverRepos', host: 0 }],
    ['reinstallDaemon', { t: 'reinstallDaemon', host: 0 }],
  ] as const)('answers %s as not implemented', async (_name, body) => {
    const client = await host.session();
    const reply = await client.hubRequest(body);
    expect(reply).toMatchObject({ from: 'hub', m: { t: 'error', req: 1, code: 'internal' } });
    expect(reply.m.t === 'error' ? reply.m.message : '').toMatch(/not implemented/i);
  });

  it('relays a snapshot near the frame limit intact', async () => {
    const client = await watching();
    const awk = `awk 'BEGIN { for (l = 0; l < 5100; l++) { s = ""; for (c = 0; c < 500; c++) s = s "\\033[31ma\\033[32mb"; print s } }'; echo BIG-DONE`;
    const term = await client.create(0, wt, { command: awk, cols: 1000, rows: 50 });
    await client.waitEvent(0, 'termExited', (m) => m.termId === term.termId, { timeout: 90_000 });
    const view = await client.attach(0, term.termId, 60_000);
    const snapshot = view.attachments[0]?.snapshot;
    if (snapshot === undefined) throw new Error('no snapshot');
    expect(snapshot.length).toBeGreaterThan(8 * MiB);
    const direct = await host.client();
    await direct.watch(repo);
    const reference = (await direct.attach(term.termId, 60_000)).attachments[0]?.snapshot;
    expect(Buffer.from(snapshot).equals(Buffer.from(reference ?? new Uint8Array()))).toBe(true);
    expect(await view.screen.text()).toContain('BIG-DONE');
  }, 180_000);
});

describe('back-pressure', () => {
  it('lets a browser that never acks receive at most FLOW_HIGH plus one chunk of a flood', async () => {
    const client = await watching();
    const term = await started(client, 'read go; seq 1 1500000; echo FLOOD-DONE');
    client.autoAck = false;
    const before = client.view(0, term.termId).bytes().length;
    const from = client.data.length;
    client.sendInput(0, term.termId, 'go\r');
    await client.waitEvent(0, 'detached', (m) => m.termId === term.termId, { timeout: 20_000 });
    const frames = client.data.slice(from).filter((d) => d.kind === 'output' && d.termId === term.termId);
    const largest = Math.max(0, ...frames.map((d) => d.data.length));
    expect(largest).toBeGreaterThan(0);
    expect(client.view(0, term.termId).bytes().length - before).toBeLessThanOrEqual(FLOW_HIGH + largest);
  });

  it('stays bounded for a session that stops reading, which can still send, while others keep receiving', async () => {
    const reader = await watching();
    const ticker = await started(reader, 'while true; do echo tick-$RANDOM; sleep 0.1; done');
    const stalled = await watching();
    const shell = await started(stalled, null);
    const floods: Terminal[] = [];
    for (let i = 0; i < 20; i++) floods.push(await stalled.create(0, wt, { command: 'yes flood-line-with-some-padding-to-fill-frames' }));
    await sleep(1000);
    const baseline = residentBytes(hub.pid);
    for (const flood of floods) await stalled.attach(0, flood.termId, 10_000);
    stalled.pauseReading();
    const marker = join(host.dir, 'typed-while-stalled');
    let peak = baseline;
    const tickerBefore = reader.view(0, ticker.termId).bytes().length;
    for (let i = 0; i < 10; i++) {
      await sleep(500);
      peak = Math.max(peak, residentBytes(hub.pid));
      if (i === 2) stalled.sendInput(0, shell.termId, `touch ${marker}\r`);
    }
    expect(peak - baseline).toBeLessThan(64 * MiB);
    expect(reader.view(0, ticker.termId).bytes().length).toBeGreaterThan(tickerBefore);
    await waitUntil(() => existsSync(marker), 'input from the stalled session');
    expect(alive(hub.pid)).toBe(true);
  });
});

describe('daemon restart', () => {
  it('restarts an outdated daemon into one speaking the hub’s protocol', async () => {
    const fake = await FakeDaemon.listen(host.socket, { protocol: 99 });
    const client = await host.session();
    await client.waitHost(0, (h) => h.status === 'outdated');
    const from = client.mark();
    const reply = await client.hubRequest({ t: 'restartDaemon', host: 0 }, 15_000);
    expect(reply).toEqual({ from: 'hub', m: { t: 'done', req: 1 } });
    expect(fake.shutdowns).toBe(1);
    await fake.closed;
    expect(await instanceOf(client, from)).not.toBe('fake_instance');
    expect(host.daemonPids()).toHaveLength(1);
    const direct = await host.client();
    expect((await direct.handshake()).protocol).toBe(PROTOCOL_VERSION);
  });

  it('shares one restart between concurrent requests from two sessions', async () => {
    const a = await host.session();
    const b = await host.session();
    const old = await instanceOf(a);
    await connected(b);
    const [oldPid] = host.daemonPids();
    const fromA = a.mark();
    const fromB = b.mark();
    const replies = await Promise.all([
      a.hubRequest({ t: 'restartDaemon', host: 0 }, 15_000),
      b.hubRequest({ t: 'restartDaemon', host: 0 }, 15_000),
    ]);
    expect(replies.map((r) => r.m.t)).toEqual(['done', 'done']);
    expect(alive(oldPid ?? 0)).toBe(false);
    await waitUntil(() => host.daemonPids().length === 1, 'one daemon');
    await sleep(500);
    expect(host.daemonPids()).toHaveLength(1);
    const newA = await instanceOf(a, fromA);
    const newB = await instanceOf(b, fromB);
    expect(newA).not.toBe(old);
    expect(newB).toBe(newA);
  });

  it('answers internal when the daemon does not go away within 10 s', async () => {
    const fake = await FakeDaemon.listen(host.socket, { protocol: 99, onShutdown: 'ignore' });
    const client = await host.session();
    await client.waitHost(0, (h) => h.status === 'outdated');
    const sentAt = Date.now();
    const reply = await client.hubRequest({ t: 'restartDaemon', host: 0 }, 20_000);
    expect(reply).toMatchObject({ from: 'hub', m: { t: 'error', req: 1, code: 'internal' } });
    expect(Date.now() - sentAt).toBeGreaterThanOrEqual(9500);
    expect(fake.shutdowns).toBe(1);
  });

  it('answers host-unavailable for a host that is not connected or outdated', async () => {
    const fake = await FakeDaemon.listen(host.socket, { protocol: PROTOCOL_VERSION, accept: 'close' });
    const client = await host.session();
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
    const [daemonPid] = host.daemonPids();
    first.close();
    await sleep(500);
    const second = await watching();
    const state = second.daemonEvents(0, 'repoState').at(-1);
    expect(state?.terminals.find((t) => t.termId === term.termId)?.exit).toBeNull();
    expect(host.daemonPids()).toEqual([daemonPid]);
  });

  it('closes sessions with 1001 on SIGTERM and exits 0, leaving the daemon running', async () => {
    const client = await watching();
    const [daemonPid] = host.daemonPids();
    hub.kill('SIGTERM');
    await client.waitClosed();
    expect(client.closeCode).toBe(1001);
    expect(await hub.exited).toEqual({ code: 0, signal: null });
    expect(alive(daemonPid ?? 0)).toBe(true);
  });

  it('closes sessions with 1001 on an authenticated shutdown request', async () => {
    const client = await host.session();
    await host.api('POST', '/api/shutdown');
    await client.waitClosed();
    expect(client.closeCode).toBe(1001);
    expect(await hub.exited).toEqual({ code: 0, signal: null });
  });
});
