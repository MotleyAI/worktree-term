import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FLOW_HIGH, FrameKind, PROTOCOL_VERSION, type Terminal } from '../../src/protocol/index.js';
import { addWorktree, alive, DaemonHost, makeRepo, residentBytes, sleep, waitUntil, type WtdProcess } from '../support/daemon-host.js';
import { FakeDaemon, SocketProxy } from '../support/fake-daemon.js';
import { currentNodeDir, FakeSsh, installRemote, type FakeRemote } from '../support/fake-ssh.js';
import type { HubClient, HubMessageOf } from '../support/hub-client.js';
import { HubHost } from '../support/hub-host.js';
import { REPO_ROOT } from '../support/exec.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

const ANY_TEXT: unknown = expect.any(String);
const ANY_INSTANCE: unknown = expect.stringMatching(/^[A-Za-z0-9_-]{1,64}$/);

const KiB = 1024;
const MiB = 1024 * KiB;

const SHELL = { name: 'shell', command: null };
const CLAUDE = { name: 'claude', command: 'claude' };

let host: HubHost;
let hub: WtdProcess;
let repo: string;
let wt: string;
let ssh: FakeSsh;

beforeEach(async () => {
  host = await HubHost.createHub();
  ssh = new FakeSsh(join(host.dir, 'ssh'));
  host.sshProgram = ssh.program;
  repo = makeRepo(join(host.dir, 'repo'));
  wt = addWorktree(repo, join(host.dir, 'wt'), 'wt');
  host.writeRepos([repo]);
  hub = await host.startHub();
});

afterEach(async () => {
  // Stop the hub first, so it starts no SSH runs while the fake remotes go away.
  for (const pid of host.hubPids()) process.kill(pid, 'SIGKILL');
  await waitUntil(() => host.hubPids().length === 0, 'hubs to exit').catch(() => undefined);
  await ssh.cleanup();
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

/** The preset lists of every `presets` message received so far. */
const presetsOf = (client: HubClient): HubMessageOf<'presets'>['presets'][] =>
  client.messages.flatMap((m) => (m.t === 'presets' ? [m.presets] : []));

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

  it('sends the configured presets exactly, in their order', async () => {
    host.presets = [CLAUDE, SHELL];
    host.writeRepos([repo]);
    const client = await host.session();
    expect(presetsOf(client)).toEqual([[CLAUDE, SHELL]]);
  });

  it('gives a new session an edited configuration, leaving an open session unchanged', async () => {
    const open = await host.session();
    expect(presetsOf(open)).toEqual([[SHELL]]);
    const other = makeRepo(join(host.dir, 'other'));
    host.presets = [SHELL, CLAUDE];
    host.writeRepos([repo, other]);
    const fresh = await host.session();
    expect(fresh.hosts()[0]?.repos).toEqual([repo, other]);
    expect(presetsOf(fresh)).toEqual([[SHELL, CLAUDE]]);
    await open.expectNone('hosts', (m) => m.hosts.some((h) => h.repos.includes(other)), 1000);
    expect(open.hosts()[0]?.repos).toEqual([repo]);
    expect(presetsOf(open)).toEqual([[SHELL]]);
  });

  it.each([
    ['an empty presets list', []],
    [
      'two presets named a',
      [
        { name: 'a', command: null },
        { name: 'a', command: 'x' },
      ],
    ],
    ['a preset whose command is empty', [{ name: 'a', command: '' }]],
  ])('gives a new session an internal error and the last valid repos and presets after an edit to %s', async (_name, presets) => {
    host.presets = [CLAUDE, SHELL];
    host.writeRepos([repo]);
    expect(presetsOf(await host.session())).toEqual([[CLAUDE, SHELL]]);
    host.writeConfig({ port: host.port, repos: [join(host.dir, 'x')], presets });
    const client = await host.open(['wtd', `wtd.token.${host.token()}`]);
    await client.handshake();
    const error = await client.waitFor('error');
    expect(error).toMatchObject({ req: null, host: null, code: 'internal' });
    expect(error.message).toContain('presets');
    expect(client.hosts()[0]?.repos).toEqual([repo]);
    expect(presetsOf(client)).toEqual([[CLAUDE, SHELL]]);
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
      reason: null,
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

  it.each([
    ['an older', 3],
    ['a newer', 99],
  ])('reports a daemon of %s protocol as outdated with its version and instance, keeping the link', async (_name, protocol) => {
    const fake = await FakeDaemon.listen(host.socket, { protocol, version: '9.9.9', instance: 'old_D-1' });
    const client = await host.session();
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
      expect(client.data.map((d) => Buffer.from(d.raw.subarray(0, 3)))).toEqual(daemonData.map((f) => Buffer.from([f.kind, 0, 0])));
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
    await b.watch(0, repo);
    const term = await b.create(0, wt, { command: 'exec sleep 60' });
    await a.waitEvent(0, 'termCreated', (m) => m.term.termId === term.termId);
    expect(a.daemonEvents(0, 'done').map((m) => m.req)).toEqual([1]);
    expect(b.daemonEvents(0, 'done').map((m) => m.req)).toEqual([1]);
    expect(a.daemonEvents(0, 'termCreated').map((m) => m.req)).toEqual([null]);
    expect(b.daemonEvents(0, 'termCreated').map((m) => m.req)).toEqual([2]);
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
  it.each([
    ['an older', 3],
    ['a newer', 99],
  ])('restarts an outdated daemon of %s protocol into one speaking the hub’s protocol', async (_name, protocol) => {
    const fake = await FakeDaemon.listen(host.socket, { protocol });
    const client = await host.session();
    await client.waitHost(0, (h) => h.status === 'outdated');
    const from = client.mark();
    const reply = await client.hubRequest({ t: 'restartDaemon', host: 0 }, 15_000);
    expect(reply).toEqual({ from: 'hub', m: { t: 'done', req: 1 } });
    expect(fake.shutdowns).toBe(1);
    await fake.closed;
    expect(await instanceOf(client, from)).not.toBe('fake_instance');
    // A daemon the session's reconnect started alongside the restart refuses to start and exits.
    await waitUntil(() => host.daemonPids().length === 1, 'one daemon');
    const direct = await host.client();
    expect((await direct.handshake()).protocol).toBe(PROTOCOL_VERSION);
  });

  it('restarts a newer daemon whose messages after hello are not valid for the hub’s protocol', async () => {
    const fake = await FakeDaemon.listen(host.socket, {
      protocol: PROTOCOL_VERSION + 1,
      instance: 'newer_1',
      afterHello: ['{"t":"frobnicated","widgets":[1,2,3]}', '{"t":"repoState","repo":7}'],
    });
    const client = await host.session();
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
    const a = await host.session();
    const b = await host.session();
    const old = await instanceOf(a);
    await connected(b);
    const oldPid = await waitUntil(() => {
      const pids = host.daemonPids();
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
    await waitUntil(() => host.daemonPids().length === 1, 'one daemon');
    await sleep(500);
    expect(host.daemonPids()).toHaveLength(1);
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

const REMOTE_TIMEOUT = 20_000;
const INSTALL_TIMEOUT = 150_000;

interface RemoteHostConfig {
  name: string;
  ssh: string;
  repos?: readonly string[];
  roots?: readonly string[];
}

/** Writes `config.json` with the local repo, `hosts` and any other keys. */
const configure = (hosts: readonly RemoteHostConfig[], extra: Record<string, unknown> = {}): void => {
  host.writeConfig({ port: host.port, repos: [repo], hosts, ...extra });
};

/** A remote whose PATH offers this runner's Node, so the hub's installer finds one there. */
const nodeRemote = (alias: string): FakeRemote =>
  ssh.addHost(alias, { path: `${currentNodeDir(join(ssh.dir, `node-${alias}`))}:${ssh.pathWithoutNode}` });

/** The remote `box`, installed, holding one repo, configured as host 1. */
const installedBox = async (): Promise<{ remote: FakeRemote; remoteRepo: string }> => {
  const remote = nodeRemote('box');
  await installRemote(host, ssh, 'box');
  const remoteRepo = makeRepo(join(remote.home, 'src', 'app'));
  configure([{ name: 'box', ssh: 'box', repos: [remoteRepo] }]);
  return { remote, remoteRepo };
};

const connectedHost = (client: HubClient, idx: number, from = 0, timeout = REMOTE_TIMEOUT): Promise<{ instance: string | null }> =>
  client.waitHost(idx, (h) => h.status === 'connected', { from, timeout });

/** Instance of host `idx` once `connected`. */
const remoteInstance = async (client: HubClient, idx: number, from = 0): Promise<string> => {
  const { instance } = await connectedHost(client, idx, from);
  if (instance === null) throw new Error('connected without an instance');
  return instance;
};

/** Reads `config.json` as JSON. */
const configFile = (): unknown => JSON.parse(readFileSync(host.configPath, 'utf8'));

describe('remote hosts', () => {
  it('lists configured remote hosts after the local host, in configuration order', async () => {
    ssh.failHost('b-alias', 'ssh: Could not resolve hostname b-alias');
    ssh.failHost('a-alias', 'ssh: Could not resolve hostname a-alias');
    configure([
      { name: 'b', ssh: 'b-alias' },
      { name: 'a', ssh: 'a-alias', repos: ['/srv/a'] },
    ]);
    const client = await host.session();
    expect(client.hosts().map((h) => [h.idx, h.name, h.remote, h.repos])).toEqual([
      [0, hostname().slice(0, 64) || 'local', false, [repo]],
      [1, 'b', true, []],
      [2, 'a', true, ['/srv/a']],
    ]);
  });

  it('connects a remote host through its SSH command, reporting its name, index and the remote daemon’s instance', async () => {
    const { remote, remoteRepo } = await installedBox();
    const client = await host.session();
    const entry = await connectedHost(client, 1);
    expect(entry).toEqual({
      idx: 1,
      name: 'box',
      remote: true,
      status: 'connected',
      reason: null,
      daemonVersion: packageVersion(),
      instance: ANY_INSTANCE,
      repos: [remoteRepo],
    });
    expect(remote.daemonPids()).toHaveLength(1);
    expect((await remote.hello()).instance).toBe(entry.instance);
    const link = ssh.calls().find((call) => call.alias === 'box' && call.command.includes('connect'));
    expect(link?.command).toBe('"$HOME/.local/bin/wtd" connect');
    expect(link?.args.slice(0, 12)).toEqual([
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=10',
      '-o',
      'ControlMaster=auto',
      '-o',
      'ControlPersist=10m',
      '-o',
      `ControlPath=${host.runDir}/ssh-%C`,
      '-o',
      'ServerAliveInterval=15',
    ]);
  });

  it('round-trips requests, terminals and output through a remote host', async () => {
    const { remoteRepo } = await installedBox();
    const client = await host.session();
    await connectedHost(client, 1);
    const state = await client.watch(1, remoteRepo);
    expect(state.worktrees.map((w) => w.path)).toEqual([remoteRepo]);
    const term = await client.create(1, remoteRepo);
    await client.attach(1, term.termId);
    client.sendInput(1, term.termId, 'echo remote-$((40+2))-trip\r');
    await client.waitOutput(1, term.termId, 'remote-42-trip', 10_000);
    expect(client.daemonEvents(0, 'termCreated')).toEqual([]);
  });

  it('reports reconnecting, then connected to the same daemon, when the SSH process is killed', async () => {
    await installedBox();
    const client = await host.session();
    const first = await remoteInstance(client, 1);
    const pids = await waitUntil(() => {
      const live = ssh.livePids('box');
      return live.length > 0 ? live : undefined;
    }, 'the hub’s SSH process');
    const from = client.mark();
    for (const pid of pids) process.kill(pid, 'SIGKILL');
    expect(await client.waitHost(1, (h) => h.status === 'reconnecting', { from })).toMatchObject({ instance: null });
    expect(await remoteInstance(client, 1, from)).toBe(first);
  });

  it('reports a host whose SSH command keeps failing as down, naming SSH’s last error line', async () => {
    ssh.failHost('box', 'ssh: Could not resolve hostname box');
    configure([{ name: 'box', ssh: 'box' }]);
    const client = await host.session();
    expect(await client.waitHost(1, (h) => h.status === 'reconnecting')).toMatchObject({
      reason: 'ssh: Could not resolve hostname box',
      instance: null,
    });
    expect(await client.waitHost(1, (h) => h.status === 'down', { timeout: 10_000 })).toMatchObject({
      reason: 'ssh: Could not resolve hostname box',
      daemonVersion: null,
      instance: null,
    });
    expect(client.hosts()[0]?.status).toBe('connected');
  });

  it('reports a remote without wtd as down, with a reason', async () => {
    ssh.addHost('box');
    configure([{ name: 'box', ssh: 'box' }]);
    const client = await host.session();
    const entry = await client.waitHost(1, (h) => h.status === 'down', { timeout: 10_000 });
    expect(entry.reason).toEqual(expect.stringMatching(/\S/));
  });

  it('keeps its memory bounded and the reason short when SSH writes 8 MiB to standard error without a newline', async () => {
    const before = residentBytes(hub.pid);
    ssh.spewHost('box', 8 * MiB);
    configure([{ name: 'box', ssh: 'box' }]);
    const client = await host.session();
    const entry = await client.waitHost(1, (h) => h.status === 'down', { timeout: 30_000 });
    expect(entry.reason?.length ?? 0).toBeGreaterThan(0);
    expect(entry.reason?.length ?? 0).toBeLessThanOrEqual(1024);
    expect(residentBytes(hub.pid) - before).toBeLessThan(16 * MiB);
  });

  it('answers requests to a down remote host with host-unavailable', async () => {
    ssh.failHost('box', 'ssh: Could not resolve hostname box');
    configure([{ name: 'box', ssh: 'box' }]);
    const client = await host.session();
    await client.waitHost(1, (h) => h.status === 'reconnecting' || h.status === 'down');
    const reply = await client.request(1, { t: 'watchRepo', repo: '/srv/app' });
    expect(reply).toMatchObject({ from: 'hub', m: { t: 'error', req: 1, host: 1, code: 'host-unavailable' } });
  });

  it('ends the SSH processes of a closed session', async () => {
    await installedBox();
    const client = await host.session();
    await connectedHost(client, 1);
    const pids = ssh.livePids('box');
    expect(pids.length).toBeGreaterThan(0);
    client.close();
    await waitUntil(() => pids.every((pid) => !alive(pid)), 'the session’s SSH processes to end', 5000);
  });
});

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

describe('repo discovery through the hub', () => {
  it('discovers repos below the host’s configured roots, at depth 3', async () => {
    const one = makeRepo(join(host.home, 'src', 'one'));
    const deep = makeRepo(join(host.home, 'src', 'a', 'b', 'deep'));
    makeRepo(join(host.home, 'src', 'a', 'b', 'c', 'too-deep'));
    makeRepo(join(host.home, 'elsewhere', 'outside'));
    host.writeConfig({ port: host.port, repos: [repo], roots: ['~/src'] });
    const client = await host.session();
    await connected(client);
    const reply = await client.hubRequest({ t: 'discoverRepos', host: 0 });
    expect(reply).toEqual({ from: 'hub', m: { t: 'reposDiscovered', req: 1, host: 0, repos: [deep, one] } });
  });

  it('discovers below the home directory by default', async () => {
    const mine = makeRepo(join(host.home, 'GitHub', 'mine'));
    const client = await host.session();
    await connected(client);
    const reply = await client.hubRequest({ t: 'discoverRepos', host: 0 });
    expect(reply.m.t === 'reposDiscovered' ? reply.m.repos : []).toContain(mine);
  });

  it('discovers on a remote host against the remote home', async () => {
    const remote = nodeRemote('box');
    await installRemote(host, ssh, 'box');
    const found = makeRepo(join(remote.home, 'code', 'found'));
    configure([{ name: 'box', ssh: 'box', roots: ['~/code'] }]);
    const client = await host.session();
    await connectedHost(client, 1);
    const reply = await client.hubRequest({ t: 'discoverRepos', host: 1 });
    expect(reply).toEqual({ from: 'hub', m: { t: 'reposDiscovered', req: 1, host: 1, repos: [found] } });
  });

  it('keeps a hub-level request apart from a daemon request with the same id', async () => {
    const client = await host.session();
    await connected(client);
    const from = client.mark();
    client.sendJson({ t: 'host', host: 0, m: { t: 'watchRepo', req: 7, repo } });
    client.sendJson({ t: 'discoverRepos', req: 7, host: 0 });
    await client.waitFor('reposDiscovered', (m) => m.req === 7, { from });
    await client.waitEvent(0, 'done', (m) => m.req === 7, { from });
    await sleep(1000);
    const replies = client.messages.slice(from).filter((m) => {
      if (m.t === 'host') return 'req' in m.m && m.m.req === 7;
      return 'req' in m && m.req === 7;
    });
    expect(replies.map((m) => (m.t === 'host' ? `host:${m.m.t}` : m.t)).sort()).toEqual(['host:done', 'reposDiscovered']);
  });

  it('answers discovery for a host that is not connected as routing does', async () => {
    ssh.failHost('box', 'ssh: Could not resolve hostname box');
    configure([{ name: 'box', ssh: 'box' }]);
    const client = await host.session();
    await client.waitHost(1, (h) => h.status === 'reconnecting' || h.status === 'down');
    expect(await client.hubRequest({ t: 'discoverRepos', host: 1 })).toMatchObject({
      from: 'hub',
      m: { t: 'error', req: 1, host: 1, code: 'host-unavailable' },
    });
    expect(await client.hubRequest({ t: 'discoverRepos', host: 9 })).toMatchObject({
      from: 'hub',
      m: { t: 'error', code: 'unknown-host' },
    });
  });

  it('answers discovery for an outdated host with version-mismatch', async () => {
    await FakeDaemon.listen(host.socket, { protocol: 99 });
    const client = await host.session();
    await client.waitHost(0, (h) => h.status === 'outdated');
    expect(await client.hubRequest({ t: 'discoverRepos', host: 0 })).toMatchObject({ m: { t: 'error', code: 'version-mismatch' } });
  });
});

describe('adding repos', () => {
  it('adds a repo to config.json, answers done, then lists it in hosts', async () => {
    const added = makeRepo(join(host.dir, 'added'));
    const client = await host.session();
    await connected(client);
    const from = client.mark();
    const reply = await client.hubRequest({ t: 'addRepo', host: 0, repo: added });
    expect(reply).toEqual({ from: 'hub', m: { t: 'done', req: 1 } });
    const listed = await client.waitHost(0, (h) => h.repos.includes(added), { from });
    expect(listed.repos).toEqual([repo, added]);
    const doneAt = client.messages.findIndex((m, i) => i >= from && m.t === 'done');
    const hostsAt = client.messages.findIndex((m, i) => i >= from && m.t === 'hosts' && m.hosts[0]?.repos.includes(added) === true);
    expect(doneAt).toBeLessThan(hostsAt);
    expect(configFile()).toEqual({ port: host.port, repos: [repo, added] });
  });

  it('refuses a directory that is not a repository’s main worktree with not-a-repo, leaving config.json unchanged', async () => {
    const plain = join(host.dir, 'plain');
    mkdirSync(plain);
    const before = readFileSync(host.configPath, 'utf8');
    const client = await host.session();
    await connected(client);
    expect(await client.hubRequest({ t: 'addRepo', host: 0, repo: plain })).toMatchObject({
      from: 'hub',
      m: { t: 'error', req: 1, host: 0, code: 'not-a-repo' },
    });
    expect(await client.hubRequest({ t: 'addRepo', host: 0, repo: wt })).toMatchObject({ m: { t: 'error', code: 'not-a-repo' } });
    expect(readFileSync(host.configPath, 'utf8')).toBe(before);
  });

  it('answers done without an edit for a repo already listed, as given or by a ~/ form', async () => {
    symlinkSync(repo, join(host.home, 'linked'));
    host.writeConfig({ port: host.port, repos: [repo, '~/linked'] });
    const before = readFileSync(host.configPath, 'utf8');
    const client = await host.session();
    await connected(client);
    expect((await client.hubRequest({ t: 'addRepo', host: 0, repo })).m).toEqual({ t: 'done', req: 1 });
    expect((await client.hubRequest({ t: 'addRepo', host: 0, repo: join(host.home, 'linked') })).m).toEqual({ t: 'done', req: 2 });
    expect(readFileSync(host.configPath, 'utf8')).toBe(before);
  });

  it('lists a repo added to a remote host in every open session', async () => {
    const { remote, remoteRepo } = await installedBox();
    const second = makeRepo(join(remote.home, 'src', 'second'));
    const a = await host.session();
    const b = await host.session();
    await connectedHost(a, 1);
    await connectedHost(b, 1);
    const fromB = b.mark();
    expect((await a.hubRequest({ t: 'addRepo', host: 1, repo: second })).m).toEqual({ t: 'done', req: 1 });
    expect((await a.waitHost(1, (h) => h.repos.includes(second))).repos).toEqual([remoteRepo, second]);
    expect((await b.waitHost(1, (h) => h.repos.includes(second), { from: fromB })).repos).toEqual([remoteRepo, second]);
    expect(b.hosts()[0]?.repos).toEqual([repo]);
    expect(configFile()).toEqual({ port: host.port, repos: [repo], hosts: [{ name: 'box', ssh: 'box', repos: [remoteRepo, second] }] });
  });

  it('answers adding to a host that is not connected as routing does', async () => {
    ssh.failHost('box', 'ssh: Could not resolve hostname box');
    configure([{ name: 'box', ssh: 'box' }]);
    const client = await host.session();
    await client.waitHost(1, (h) => h.status === 'reconnecting' || h.status === 'down');
    expect(await client.hubRequest({ t: 'addRepo', host: 1, repo: '/srv/x' })).toMatchObject({
      m: { t: 'error', host: 1, code: 'host-unavailable' },
    });
  });
});

describe('removing repos', () => {
  it('removes a repo listed by a ~/ form, answers done, then drops it from hosts', async () => {
    const app = makeRepo(join(host.home, 'app'));
    host.writeConfig({ port: host.port, repos: [repo, '~/app'] });
    const client = await host.session();
    await connected(client);
    expect(client.hosts()[0]?.repos).toEqual([repo, app]);
    const from = client.mark();
    expect((await client.hubRequest({ t: 'removeRepo', host: 0, repo: app })).m).toEqual({ t: 'done', req: 1 });
    expect((await client.waitHost(0, (h) => !h.repos.includes(app), { from })).repos).toEqual([repo]);
    expect(configFile()).toEqual({ port: host.port, repos: [repo] });
  });

  it('refuses a repo with a running terminal with busy, leaving config.json unchanged', async () => {
    const client = await watching();
    await client.create(0, wt, { command: 'exec sleep 60' });
    const before = readFileSync(host.configPath, 'utf8');
    expect(await client.hubRequest({ t: 'removeRepo', host: 0, repo })).toMatchObject({
      from: 'hub',
      m: { t: 'error', req: 2, host: 0, code: 'busy' },
    });
    expect(readFileSync(host.configPath, 'utf8')).toBe(before);
  });

  it('refuses a repo with an exited terminal not yet closed, and removes it once closed', async () => {
    const client = await watching();
    const term = await client.create(0, repo, { command: 'exit 0' });
    await client.waitEvent(0, 'termExited', (m) => m.termId === term.termId, { timeout: 10_000 });
    expect((await client.hubRequest({ t: 'removeRepo', host: 0, repo })).m).toMatchObject({ t: 'error', code: 'busy' });
    await client.ok(0, { t: 'closeTerm', termId: term.termId });
    expect((await client.hubRequest({ t: 'removeRepo', host: 0, repo })).m).toMatchObject({ t: 'done' });
    expect(configFile()).toEqual({ port: host.port, repos: [] });
  });

  it('removes a listed repo whose directory no longer exists', async () => {
    const gone = makeRepo(join(host.dir, 'gone'));
    host.writeRepos([repo, gone]);
    rmSync(gone, { recursive: true, force: true });
    const client = await host.session();
    await connected(client);
    expect((await client.hubRequest({ t: 'removeRepo', host: 0, repo: gone })).m).toEqual({ t: 'done', req: 1 });
    expect(configFile()).toEqual({ port: host.port, repos: [repo] });
  });

  it('answers done without an edit for a repo it does not list', async () => {
    const before = readFileSync(host.configPath, 'utf8');
    const client = await host.session();
    await connected(client);
    expect((await client.hubRequest({ t: 'removeRepo', host: 0, repo: join(host.dir, 'never') })).m).toEqual({ t: 'done', req: 1 });
    expect(readFileSync(host.configPath, 'utf8')).toBe(before);
  });
});

describe('configuration edits', () => {
  it('refuses to edit an invalid config.json, naming the problem and leaving it unchanged', async () => {
    const added = makeRepo(join(host.dir, 'added'));
    const client = await host.session();
    await connected(client);
    writeFileSync(host.configPath, JSON.stringify({ port: host.port, theme: 'dark' }));
    const reply = await client.hubRequest({ t: 'addRepo', host: 0, repo: added });
    expect(reply).toMatchObject({ from: 'hub', m: { t: 'error', req: 1, code: 'internal' } });
    expect(reply.m.t === 'error' ? reply.m.message : '').toContain('theme');
    expect(configFile()).toEqual({ port: host.port, theme: 'dark' });
  });

  it('refuses to edit a host the file no longer lists, leaving it unchanged', async () => {
    const { remote } = await installedBox();
    const other = makeRepo(join(remote.home, 'src', 'other'));
    const client = await host.session();
    await connectedHost(client, 1);
    host.writeConfig({ port: host.port, repos: [repo] });
    const before = readFileSync(host.configPath, 'utf8');
    expect((await client.hubRequest({ t: 'addRepo', host: 1, repo: other })).m).toMatchObject({ t: 'error', code: 'internal' });
    expect(readFileSync(host.configPath, 'utf8')).toBe(before);
  });

  it('creates config.json owner-only to record a repo when there was none', async () => {
    rmSync(host.configPath);
    const added = makeRepo(join(host.dir, 'added'));
    const client = await host.session();
    await connected(client);
    expect((await client.hubRequest({ t: 'addRepo', host: 0, repo: added })).m).toEqual({ t: 'done', req: 1 });
    expect(configFile()).toEqual({ repos: [added] });
  });

  it('changes nothing else in an open session’s snapshot', async () => {
    const added = makeRepo(join(host.dir, 'added'));
    const client = await host.session();
    await connected(client);
    host.presets = [CLAUDE, SHELL];
    host.writeRepos([repo]);
    const from = client.mark();
    expect((await client.hubRequest({ t: 'addRepo', host: 0, repo: added })).m).toEqual({ t: 'done', req: 1 });
    await client.waitHost(0, (h) => h.repos.includes(added), { from });
    expect(presetsOf(client)).toEqual([[SHELL]]);
  });
});
