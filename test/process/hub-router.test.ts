import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { connect, createServer, type Socket } from 'node:net';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  decodeRemoteFragment,
  FLOW_HIGH,
  FrameKind,
  DAEMON_PROTOCOL_VERSION,
  type RemoteFragment,
  type Terminal,
} from '../../src/protocol/index.js';
import { addWorktree, alive, DaemonHost, makeRepo, residentBytes, sleep, waitUntil, type WtdProcess } from '../support/daemon-host.js';
import { FakeDaemon, SocketProxy } from '../support/fake-daemon.js';
import { currentNodeDir, FakeSsh, installRemote, loginRun, type FakeRemote, type SshCall } from '../support/fake-ssh.js';
import { HubClient, type HostEntry, type HubMessage, type HubMessageOf, type Reply } from '../support/hub-client.js';
import { freePort, HubHost, rawHttp } from '../support/hub-host.js';
import { remoteHub } from '../support/remote-hub.js';
import { REPO_ROOT } from '../support/exec.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

const ANY_TEXT: unknown = expect.any(String);
const ANY_INSTANCE: unknown = expect.stringMatching(/^[A-Za-z0-9_-]{1,64}$/);

const KiB = 1024;
const MiB = 1024 * KiB;

const SHELL = { name: 'shell', command: null };
const CLAUDE = { name: 'claude', command: 'claude' };
/** The presets of a configuration without `presets`. */
const DEFAULT_PRESETS = [SHELL, CLAUDE, { name: 'codex', command: 'codex' }];

/** Hub budgets for opening a remote hub, probing its forward and installing, shortened for every hub started here. */
const OPEN_MS = 10_000;
const PROBE_MS = 3000;
const INSTALL_MS = 30_000;
const HUB_ENV = { WTD_HUB_OPEN_MS: String(OPEN_MS), WTD_HUB_PROBE_MS: String(PROBE_MS), WTD_HUB_INSTALL_MS: String(INSTALL_MS) };

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
  hub = await host.startHub(HUB_ENV);
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
    expect(presetsOf(open)).toEqual([DEFAULT_PRESETS]);
    const other = makeRepo(join(host.dir, 'other'));
    host.presets = [SHELL, CLAUDE];
    host.writeRepos([repo, other]);
    const fresh = await host.session();
    expect(fresh.hosts()[0]?.repos).toEqual([repo, other]);
    expect(presetsOf(fresh)).toEqual([[SHELL, CLAUDE]]);
    await open.expectNone('hosts', (m) => m.hosts.some((h) => h.repos.includes(other)), 1000);
    expect(open.hosts()[0]?.repos).toEqual([repo]);
    expect(presetsOf(open)).toEqual([DEFAULT_PRESETS]);
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
      login: null,
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
    const fake = await FakeDaemon.listen(host.socket, { protocol: DAEMON_PROTOCOL_VERSION, accept: 'close' });
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
    await FakeDaemon.listen(host.socket, { protocol: DAEMON_PROTOCOL_VERSION, accept: 'close' });
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
    expect((await direct.handshake()).protocol).toBe(DAEMON_PROTOCOL_VERSION);
  });

  it('restarts a newer daemon whose messages after hello are not valid for the hub’s protocol', async () => {
    const fake = await FakeDaemon.listen(host.socket, {
      protocol: DAEMON_PROTOCOL_VERSION + 1,
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
    const fake = await FakeDaemon.listen(host.socket, { protocol: DAEMON_PROTOCOL_VERSION, accept: 'close' });
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
/** The hub's install budget plus a margin. */
const INSTALL_TIMEOUT = INSTALL_MS + 15_000;

interface RemoteHostConfig {
  name: string;
  ssh: string;
  port?: number;
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
      login: null,
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

  it('ends an SSH process that writes over 1 MiB to standard error instead of leaving its link stalled', async () => {
    await installedBox();
    ssh.noisyHost('box', 2 * MiB);
    const client = await host.session();
    const entry = await client.waitHost(1, (h) => h.status === 'reconnecting' || h.status === 'down', { timeout: REMOTE_TIMEOUT });
    expect(entry.reason).toMatch(/^x{1,1024}$/);
  });

  it('answers requests to a down remote host with host-unavailable', async () => {
    ssh.failHost('box', 'ssh: Could not resolve hostname box');
    configure([{ name: 'box', ssh: 'box' }]);
    const client = await host.session();
    await client.waitHost(1, (h) => h.status === 'reconnecting' || h.status === 'down');
    const reply = await client.request(1, { t: 'watchRepo', repo: '/srv/app' });
    expect(reply).toMatchObject({ from: 'hub', m: { t: 'error', req: 1, host: 1, code: 'host-unavailable' } });
  });

  it('kills SSH processes of a closed session that ignore SIGTERM', async () => {
    ssh.addHost('box');
    ssh.hangHost('box');
    configure([{ name: 'box', ssh: 'box' }]);
    const client = await host.session();
    const pids = await waitUntil(() => {
      const live = ssh.livePids('box');
      return live.length > 0 && live;
    }, 'an SSH process for box');
    client.close();
    await waitUntil(() => pids.every((pid) => !alive(pid)), 'the session’s SSH processes to be killed', 5000);
    expect(pids.filter(alive)).toEqual([]);
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

const LOGIN_URL: unknown = expect.stringMatching(/^https:\/\/login\.tailscale\.com\/a\/wtd\d+$/);

/** Host `idx`'s entries in every `hosts` message from `from` on. */
const entriesOf = (client: HubClient, idx: number, from = 0): HostEntry[] =>
  client.messages.slice(from).flatMap((m) => (m.t === 'hosts' ? m.hosts.filter((h) => h.idx === idx) : []));

/** Host `idx`'s statuses from `from` on, without consecutive repeats. */
const statusesOf = (client: HubClient, idx: number, from = 0): string[] =>
  entriesOf(client, idx, from)
    .map((h) => h.status)
    .filter((status, i, all) => i === 0 || all[i - 1] !== status);

/** The SSH runs of `box` that ran the connect command. */
const connectRuns = (): number[] =>
  ssh
    .calls()
    .filter((call) => call.alias === 'box' && call.command.includes('connect'))
    .map((call) => call.pid);

/** Host 1's entry once it needs login, and the login URL. */
const needsLogin = async (client: HubClient, from = 0): Promise<{ entry: HostEntry; url: string }> => {
  const entry = await client.waitHost(1, (h) => h.status === 'needs-login', { from, timeout: REMOTE_TIMEOUT });
  if (entry.login === null) throw new Error('needs-login without a login URL');
  return { entry, url: entry.login };
};

describe('Tailscale SSH check login', () => {
  it('reports needs-login with the URL within 1 s of the banner, then connects over the same SSH process once approved', async () => {
    await installedBox();
    ssh.loginHost('box');
    const before = connectRuns().length;
    const client = await host.session();
    await waitUntil(() => connectRuns().length > before, 'the hub’s SSH process for box');
    const entry = await client.waitHost(1, (h) => h.status === 'needs-login', { timeout: 5000 });
    const receivedAt = Date.now();
    expect(entry).toMatchObject({ status: 'needs-login', login: LOGIN_URL, reason: null, daemonVersion: null, instance: null });
    const url = entry.login ?? '';
    expect(receivedAt - ssh.loginWrittenAt(url)).toBeLessThanOrEqual(1000);
    expect(connectRuns()).toHaveLength(before + 1);
    ssh.approveLogin(url);
    expect(await connectedHost(client, 1)).toMatchObject({ login: null, reason: null });
    expect(connectRuns()).toHaveLength(before + 1);
    expect(alive(loginRun(url))).toBe(true);
    expect(statusesOf(client, 1)).toEqual(['connecting', 'needs-login', 'connected']);
  });

  it('reports reconnecting with SSH’s reason and a null login when the check expires, then the next run’s URL', async () => {
    await installedBox();
    ssh.loginHost('box');
    const client = await host.session();
    const { url: first } = await needsLogin(client);
    const from = client.mark();
    ssh.expireLogin(first, 'Tailscale SSH check timed out');
    expect(await client.waitHost(1, (h) => h.status === 'reconnecting', { from })).toMatchObject({
      reason: 'Tailscale SSH check timed out',
      login: null,
    });
    const { url: second } = await needsLogin(client, from);
    expect(second).not.toBe(first);
  });

  it('answers a request to a needs-login host with host-unavailable', async () => {
    await installedBox();
    ssh.loginHost('box');
    const client = await host.session();
    await needsLogin(client);
    const reply = await client.request(1, { t: 'watchRepo', repo: '/srv/app' });
    expect(reply).toMatchObject({ from: 'hub', m: { t: 'error', req: 1, host: 1, code: 'host-unavailable' } });
  });

  it('redials every other needs-login session once one session’s link greets, leaving connected sessions alone', async () => {
    await installedBox();
    const c = await host.session();
    const cEntry = await connectedHost(c, 1);
    ssh.loginHost('box');
    const a = await host.session();
    const { url: aUrl } = await needsLogin(a);
    const b = await host.session();
    const { url: bUrl } = await needsLogin(b);
    const bRun = loginRun(bUrl);
    expect(bRun).not.toBe(loginRun(aUrl));
    const runsBefore = connectRuns().length;
    const fromB = b.mark();
    const fromC = c.mark();
    ssh.skipLogin('box');
    ssh.approveLogin(aUrl);
    await connectedHost(a, 1);
    expect(await connectedHost(b, 1, fromB)).toMatchObject({ login: null });
    expect(statusesOf(b, 1, fromB)).toEqual(['connecting', 'connected']);
    expect(entriesOf(b, 1, fromB)[0]).toMatchObject({ status: 'connecting', login: null });
    await waitUntil(() => !alive(bRun), 'B’s original SSH process to end', 5000);
    expect(connectRuns().length).toBeGreaterThan(runsBefore);
    for (const entry of entriesOf(c, 1, fromC)) expect(entry).toEqual(cEntry);
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
      m: { t: 'error', req: 3, host: 0, code: 'busy' },
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

describe('editing presets', () => {
  const HTOP = { name: 'htop', command: 'htop' };

  it('adds a preset to config.json, answers done, then sends the presets to every open session', async () => {
    host.presets = [SHELL];
    host.writeRepos([repo]);
    const a = await host.session();
    const b = await host.session();
    const [fromA, fromB] = [a.mark(), b.mark()];
    expect(await a.hubRequest({ t: 'addPreset', preset: HTOP })).toEqual({ from: 'hub', m: { t: 'done', req: 1 } });
    for (const [client, from] of [
      [a, fromA],
      [b, fromB],
    ] as const) {
      expect((await client.waitFor('presets', () => true, { from })).presets).toEqual([SHELL, HTOP]);
    }
    const doneAt = a.messages.findIndex((m, i) => i >= fromA && m.t === 'done');
    const presetsAt = a.messages.findIndex((m, i) => i >= fromA && m.t === 'presets');
    expect(doneAt).toBeLessThan(presetsAt);
    expect(configFile()).toEqual({ port: host.port, repos: [repo], presets: [SHELL, HTOP] });
  });

  it('removes a preset, writing the defaults without it when config.json had none', async () => {
    host.writeConfig({ port: host.port, repos: [repo] });
    const client = await host.session();
    const from = client.mark();
    expect((await client.hubRequest({ t: 'removePreset', name: 'claude' })).m).toEqual({ t: 'done', req: 1 });
    const expected = [SHELL, { name: 'codex', command: 'codex' }];
    expect((await client.waitFor('presets', () => true, { from })).presets).toEqual(expected);
    expect(configFile()).toEqual({ port: host.port, repos: [repo], presets: expected });
  });

  it('moves a preset in config.json, answers done, then sends the new order to every open session', async () => {
    host.presets = [SHELL, CLAUDE, HTOP];
    host.writeRepos([repo]);
    const a = await host.session();
    const b = await host.session();
    const fromB = b.mark();
    expect((await a.hubRequest({ t: 'movePreset', name: 'htop', to: 0 })).m).toEqual({ t: 'done', req: 1 });
    expect((await b.waitFor('presets', () => true, { from: fromB })).presets).toEqual([HTOP, SHELL, CLAUDE]);
    expect(configFile()).toEqual({ port: host.port, repos: [repo], presets: [HTOP, SHELL, CLAUDE] });
  });

  it('answers done without sending presets for a name it does not list', async () => {
    host.presets = [SHELL];
    host.writeRepos([repo]);
    const before = readFileSync(host.configPath, 'utf8');
    const client = await host.session();
    expect((await client.hubRequest({ t: 'removePreset', name: 'nope' })).m).toEqual({ t: 'done', req: 1 });
    await client.expectNone('presets', () => true, 300);
    expect(readFileSync(host.configPath, 'utf8')).toBe(before);
  });

  it.each([
    ['adding a taken name', { t: 'addPreset', preset: { name: 'shell', command: 'zsh' } }, 'a preset named shell exists'],
    ['removing the last preset', { t: 'removePreset', name: 'shell' }, 'the last preset cannot be removed'],
  ] as const)('refuses %s with internal, leaving config.json unchanged', async (_name, body, text) => {
    host.presets = [SHELL];
    host.writeRepos([repo]);
    const before = readFileSync(host.configPath, 'utf8');
    const client = await host.session();
    const reply = await client.hubRequest(body);
    expect(reply).toMatchObject({ from: 'hub', m: { t: 'error', req: 1, host: null, code: 'internal' } });
    expect(reply.m.t === 'error' ? reply.m.message : '').toContain(text);
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
    expect(presetsOf(client)).toEqual([DEFAULT_PRESETS]);
  });
});

const PRINT_CODE = '"$HOME/.local/bin/wtd" ui --print-code';
const HEX64: unknown = expect.stringMatching(/^[0-9a-f]{64}$/);

/** Restarts the hub with `env` over the usual budgets, e.g. a shorter `WTD_HUB_OPEN_MS`. */
const restartHub = async (env: Record<string, string>): Promise<void> => {
  hub.kill('SIGTERM');
  await hub.exited;
  hub = await host.startHub({ ...HUB_ENV, ...env });
};

/** The SSH runs of `alias` that ran `wtd ui --print-code`. */
const printCodeRuns = (alias = 'box'): SshCall[] => ssh.calls().filter((call) => call.alias === alias && call.command === PRINT_CODE);

/** The forward (`-W`) runs of `alias`. */
const forwardRuns = (alias = 'box'): SshCall[] => ssh.calls().filter((call) => call.alias === alias && call.forward !== null);

/** The live print-code run of `alias`, once one runs. */
const livePrintCode = (alias = 'box'): Promise<number> =>
  waitUntil(() => printCodeRuns(alias).find((call) => alive(call.pid))?.pid ?? false, `wtd ui --print-code on ${alias}`, REMOTE_TIMEOUT);

/** The port and decoded fragment of a `hubOpened` reply. */
const opened = (reply: Reply): { port: number; fragment: RemoteFragment } => {
  if (reply.m.t !== 'hubOpened') throw new Error(`not hubOpened: ${JSON.stringify(reply.m)}`);
  const url = new URL(reply.m.url);
  expect(`${url.protocol}//${url.hostname}${url.pathname}`).toBe('http://127.0.0.1/');
  return { port: Number(url.port), fragment: decodeRemoteFragment(url.hash.slice(1)) };
};

const openHub = (client: HubClient, idx: number, timeout = REMOTE_TIMEOUT): Promise<Reply> =>
  client.hubRequest({ t: 'openHub', host: idx }, timeout);

/** Whether a TCP connection to 127.0.0.1:`port` is refused. */
const refused = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => {
      resolve(true);
    });
  });

/** A raw TCP connection to 127.0.0.1:`port`. */
const tcp = (port: number): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.off('error', reject);
      resolve(socket);
    });
  });

/** Connects to 127.0.0.1:`port` and resolves once the other side closes the connection, failing after 3 s. */
const closedSoon = async (port: number): Promise<void> => {
  const socket = await tcp(port);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('the connection was not closed'));
    }, 3000);
    socket.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.on('error', () => undefined);
  });
};

/** Holds `port` on 127.0.0.1 until the returned function is called. */
const holdPort = async (port: number): Promise<() => void> => {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return () => server.close();
};

/** A session of the remote hub through the tunnel on `port`, with the code `wtd ui --print-code` gave. */
const tunneled = async (
  port: number,
  code: string,
): Promise<{ client: HubClient; hello: HubMessageOf<'hello'>; hosts: HubMessageOf<'hosts'> }> => {
  const origin = `http://127.0.0.1:${String(port)}`;
  const client = await HubClient.open(`ws://127.0.0.1:${String(port)}/ws`, { protocols: ['wtd', `wtd.code.${code}`], origin });
  return { client, ...(await client.handshake()) };
};

/** The hub record of the remote's own hub. */
const remoteRecord = (remote: FakeRemote): { instance: string } => {
  const value: unknown = JSON.parse(readFileSync(join(remote.runDir, 'hub.json'), 'utf8'));
  if (typeof value !== 'object' || value === null || !('instance' in value) || typeof value.instance !== 'string')
    throw new Error('bad record');
  return { instance: value.instance };
};

/** The configured `port` of host `name` in config.json, if any. */
const configuredPort = (name: string): number | undefined => {
  const config = z.object({ hosts: z.array(z.object({ name: z.string(), port: z.number().optional() })) }).parse(configFile());
  return config.hosts.find((h) => h.name === name)?.port;
};

/** Hub-level replies and notices for `req` received so far. */
const answersTo = (client: HubClient, req: number): HubMessage[] =>
  client.messages.filter((m) => (m.t === 'error' || m.t === 'hubLogin' || m.t === 'hubOpened' || m.t === 'done') && m.req === req);

/** A planted `wtd` printing a print-code line for `port`. */
const printsPort = (port: number): string => `echo '{"port":${String(port)},"code":"${'0'.repeat(64)}"}'`;

interface HeldHttp {
  port: number;
  /** Connections accepted so far. */
  accepted: () => number;
  /** Answers every held and later connection with `status`, e.g. `200 OK`. */
  answer: (status: string) => void;
  close: () => void;
}

/** An HTTP server on a free port that holds each connection until `answer` is called. */
const heldHttp = async (): Promise<HeldHttp> => {
  const sockets: Socket[] = [];
  let status: string | null = null;
  let count = 0;
  const reply = (socket: Socket, line: string): void => {
    socket.end(`HTTP/1.1 ${line}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
  };
  const server = createServer((socket) => {
    count++;
    socket.on('error', () => undefined);
    if (status === null) sockets.push(socket);
    else reply(socket, status);
  });
  const port = await freePort();
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    port,
    accepted: () => count,
    answer: (line) => {
      status = line;
      for (const socket of sockets.splice(0)) reply(socket, line);
    },
    close: () => {
      for (const socket of sockets.splice(0)) socket.destroy();
      server.close();
    },
  };
};

describe('opening a remote hub', () => {
  it(
    'assigns the first port above the hub’s, runs wtd ui --print-code there and forwards that port to the remote hub',
    async () => {
      const { remote, repo: remoteRepo, port: remotePort } = await remoteHub(host, ssh, 'box', [host.port + 1]);
      ssh.failHost('gpu', 'ssh: Could not resolve hostname gpu');
      configure([
        { name: 'box', ssh: 'box' },
        { name: 'gpu', ssh: 'gpu' },
      ]);
      const client = await host.session();
      const reply = await openHub(client, 1);
      const { port, fragment } = opened(reply);
      expect(reply.m).toMatchObject({ t: 'hubOpened', req: 1 });
      expect(port).toBe(host.port + 1);
      expect(fragment).toEqual({ code: HEX64, host: 'box', home: host.port, hubs: ['box', 'gpu'] });
      expect(configFile()).toEqual({
        port: host.port,
        repos: [repo],
        hosts: [
          { name: 'box', ssh: 'box', port: host.port + 1 },
          { name: 'gpu', ssh: 'gpu' },
        ],
      });

      const [run] = printCodeRuns();
      expect(run?.args.slice(0, 12)).toEqual([
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

      const page = await rawHttp(port, 'GET', '/');
      expect(page.status).toBe(200);
      const { client: remoteClient, hello, hosts } = await tunneled(port, fragment.code);
      expect(hello.instance).toBe(remoteRecord(remote).instance);
      expect(hello.instance).not.toBe((await host.identity()).instance);
      expect(hosts.hosts[0]?.repos).toEqual([remoteRepo]);
      expect(forwardRuns().map((call) => call.forward)).toContain(`127.0.0.1:${String(remotePort)}`);
      expect(forwardRuns()[0]?.args.slice(0, 12)).toEqual(run?.args.slice(0, 12));
      remoteClient.close();
    },
    INSTALL_TIMEOUT,
  );

  it(
    'forwards a hand-written port, leaving config.json unchanged',
    async () => {
      const port = await freePort();
      await remoteHub(host, ssh, 'box', [port]);
      configure([{ name: 'box', ssh: 'box', port }]);
      const before = readFileSync(host.configPath, 'utf8');
      const client = await host.session();
      expect(opened(await openHub(client, 1)).port).toBe(port);
      expect(readFileSync(host.configPath, 'utf8')).toBe(before);
      expect((await rawHttp(port, 'GET', '/')).status).toBe(200);
    },
    INSTALL_TIMEOUT,
  );

  it(
    'sends the login link of the print-code run once and then opens, with no time limit after the link',
    async () => {
      await remoteHub(host, ssh, 'box', [host.port + 1]);
      configure([{ name: 'box', ssh: 'box' }]);
      await restartHub({ WTD_HUB_OPEN_MS: '1000' });
      ssh.loginHost('box');
      const client = await host.session();
      const pending = openHub(client, 1, REMOTE_TIMEOUT);
      const login = await client.waitFor('hubLogin', (m) => m.req === 1, { timeout: REMOTE_TIMEOUT });
      expect(login.login).toEqual(LOGIN_URL);
      const run = loginRun(login.login);
      expect(printCodeRuns().map((call) => call.pid)).toContain(run);
      await sleep(2500);
      expect(alive(run)).toBe(true);
      ssh.skipLogin('box');
      ssh.approveLogin(login.login);
      opened(await pending);
      expect(answersTo(client, 1).map((m) => m.t)).toEqual(['hubLogin', 'hubOpened']);
    },
    INSTALL_TIMEOUT,
  );

  it.each([
    ['exits 2, too old to know --print-code', 'echo "wtd: unknown option --print-code" >&2; exit 2'],
    ['exits 0 without a print-code line', 'echo "wtd 0.0.1"'],
    ['has no wtd, so the shell exits 127', null],
  ])('answers hub-outdated with the host’s index when wtd on the host %s, binding no listener', async (_name, script) => {
    const remote = ssh.addHost('box');
    if (script !== null) remote.plantWtd(script);
    configure([{ name: 'box', ssh: 'box' }]);
    const client = await host.session();
    const reply = await openHub(client, 1);
    expect(reply.m).toMatchObject({ t: 'error', req: 1, host: 1, code: 'hub-outdated' });
    expect(reply.m.t === 'error' ? reply.m.message : '').toMatch(/missing or too old/);
    expect(await refused(configuredPort('box') ?? host.port + 1)).toBe(true);
    expect(forwardRuns()).toEqual([]);
  });

  it('answers hub-failed with SSH’s last line when the host cannot be reached', async () => {
    const line = 'ssh: Could not resolve hostname box: Name or service not known';
    ssh.failHost('box', line);
    configure([{ name: 'box', ssh: 'box' }]);
    const client = await host.session();
    expect((await openHub(client, 1)).m).toEqual({ t: 'error', req: 1, host: 1, code: 'hub-failed', message: line });
  });

  it('kills a print-code run that stays silent past the budget and answers hub-failed', async () => {
    ssh.addHost('box').plantWtd('exec sleep 600');
    configure([{ name: 'box', ssh: 'box' }]);
    await restartHub({ WTD_HUB_OPEN_MS: '1000' });
    const client = await host.session();
    const pending = openHub(client, 1);
    const run = await livePrintCode();
    const reply = await pending;
    expect(reply.m).toMatchObject({ t: 'error', req: 1, host: 1, code: 'hub-failed' });
    expect(reply.m.t === 'error' ? reply.m.message : '').toMatch(/did not answer within/);
    await waitUntil(() => !alive(run), 'the silent print-code run to be killed', 5000);
  });

  it('kills a silent print-code run that ignores SIGTERM', async () => {
    ssh.addHost('box');
    ssh.hangHost('box');
    configure([{ name: 'box', ssh: 'box' }]);
    await restartHub({ WTD_HUB_OPEN_MS: '1000' });
    const client = await host.session();
    const pending = openHub(client, 1);
    const run = await livePrintCode();
    expect((await pending).m).toMatchObject({ t: 'error', host: 1, code: 'hub-failed' });
    await waitUntil(() => !alive(run), 'the hung print-code run to be killed', 5000);
  });

  it('kills a print-code run writing over 4096 bytes and answers hub-failed', async () => {
    ssh.addHost('box').plantWtd(String.raw`head -c 5000 /dev/zero | tr '\000' x; exec sleep 600`);
    configure([{ name: 'box', ssh: 'box' }]);
    const client = await host.session();
    // The run is killed as soon as its output passes the limit, too soon to be seen alive reliably.
    const reply = await openHub(client, 1);
    expect(reply.m).toMatchObject({ t: 'error', req: 1, host: 1, code: 'hub-failed' });
    const [run] = printCodeRuns();
    expect(run).toBeDefined();
    await waitUntil(() => !alive(run?.pid ?? 0), 'the print-code run to be killed', 5000);
  });

  it('answers hub-failed once the probe through the forward outlasts WTD_HUB_PROBE_MS', async () => {
    const silent = createServer(() => undefined);
    const remotePort = await freePort();
    await new Promise<void>((resolve) => silent.listen(remotePort, '127.0.0.1', resolve));
    try {
      ssh.addHost('box').plantWtd(`echo '{"port":${String(remotePort)},"code":"${'0'.repeat(64)}"}'`);
      configure([{ name: 'box', ssh: 'box' }]);
      await restartHub({ WTD_HUB_PROBE_MS: '1000' });
      const client = await host.session();
      const start = Date.now();
      expect((await openHub(client, 1)).m).toMatchObject({ t: 'error', req: 1, host: 1, code: 'hub-failed' });
      expect(Date.now() - start).toBeLessThan(8000);
    } finally {
      silent.close();
    }
  });

  it(
    'answers hub-failed naming the port when another process holds it',
    async () => {
      const port = await freePort();
      await remoteHub(host, ssh, 'box', [port]);
      configure([{ name: 'box', ssh: 'box', port }]);
      const release = await holdPort(port);
      try {
        const client = await host.session();
        const reply = await openHub(client, 1);
        expect(reply.m).toMatchObject({ t: 'error', req: 1, host: 1, code: 'hub-failed' });
        expect(reply.m.t === 'error' ? reply.m.message : '').toContain(String(port));
      } finally {
        release();
      }
    },
    INSTALL_TIMEOUT,
  );

  it(
    'answers hub-failed with the forward’s refusal when the host forbids forwarding',
    async () => {
      await remoteHub(host, ssh, 'box', [host.port + 1]);
      ssh.refuseForwards('box');
      configure([{ name: 'box', ssh: 'box' }]);
      const client = await host.session();
      expect((await openHub(client, 1)).m).toEqual({
        t: 'error',
        req: 1,
        host: 1,
        code: 'hub-failed',
        message: 'channel 0: open failed: administratively prohibited',
      });
    },
    INSTALL_TIMEOUT,
  );

  it.each([
    ['the local host', 0],
    ['an index beyond the hosts', 5],
  ])('answers unknown-host for %s, running nothing', async (_name, idx) => {
    ssh.addHost('box');
    configure([{ name: 'box', ssh: 'box' }]);
    const client = await host.session();
    expect((await openHub(client, idx)).m).toMatchObject({ t: 'error', req: 1, host: idx, code: 'unknown-host' });
    expect(printCodeRuns()).toEqual([]);
  });

  it('answers unknown-host for a host removed from config.json since the session started', async () => {
    ssh.addHost('box');
    configure([{ name: 'box', ssh: 'box' }]);
    const client = await host.session();
    configure([]);
    expect((await openHub(client, 1)).m).toMatchObject({ t: 'error', req: 1, host: 1, code: 'unknown-host' });
    expect(printCodeRuns()).toEqual([]);
  });

  it(
    'ends an opening when the session sends a newer one, which alone is answered',
    async () => {
      ssh.addHost('slow').plantWtd('exec sleep 600');
      await remoteHub(host, ssh, 'box', [host.port + 1, host.port + 2]);
      configure([
        { name: 'slow', ssh: 'slow' },
        { name: 'box', ssh: 'box' },
      ]);
      const client = await host.session();
      client.sendJson({ t: 'openHub', req: 50, host: 1 });
      const slow = await livePrintCode('slow');
      opened(await openHub(client, 2));
      await waitUntil(() => !alive(slow), 'the superseded print-code run to be killed', 5000);
      await sleep(1000);
      expect(answersTo(client, 50)).toEqual([]);
      const slowPort = configuredPort('slow');
      if (slowPort !== undefined) expect(await refused(slowPort)).toBe(true);
    },
    INSTALL_TIMEOUT,
  );

  it('kills the opening SSH process of a session that closes', async () => {
    ssh.addHost('box').plantWtd('exec sleep 600');
    configure([{ name: 'box', ssh: 'box' }]);
    const client = await host.session();
    client.sendJson({ t: 'openHub', req: 1, host: 1 });
    const run = await livePrintCode();
    client.close();
    await waitUntil(() => !alive(run), 'the opening’s SSH process to be killed', 5000);
    expect(alive(run)).toBe(false);
  });

  it('runs print-code over the alias config.json names now, not the one the session started with', async () => {
    ssh.addHost('box').plantWtd('exit 2');
    configure([{ name: 'box', ssh: 'old' }]);
    const client = await host.session();
    configure([{ name: 'box', ssh: 'box' }]);
    expect((await openHub(client, 1)).m).toMatchObject({ t: 'error', req: 1, host: 1, code: 'hub-outdated' });
    expect(printCodeRuns('box')).toHaveLength(1);
    expect(printCodeRuns('old')).toEqual([]);
  });

  it('resolves the host by its snapshot name after config.json reordered the hosts', async () => {
    ssh.addHost('a').plantWtd('exit 2');
    ssh.addHost('b').plantWtd('exit 2');
    configure([
      { name: 'a', ssh: 'a' },
      { name: 'b', ssh: 'b' },
    ]);
    const client = await host.session();
    configure([
      { name: 'b', ssh: 'b' },
      { name: 'a', ssh: 'a' },
    ]);
    expect((await openHub(client, 1)).m).toMatchObject({ t: 'error', req: 1, host: 1, code: 'hub-outdated' });
    expect(printCodeRuns('a')).toHaveLength(1);
    expect(printCodeRuns('b')).toEqual([]);
  });

  it('answers hub-failed without hubOpened when the probe through the forward is not answered 200', async () => {
    const server = await heldHttp();
    server.answer('404 Not Found');
    try {
      ssh.addHost('box').plantWtd(printsPort(server.port));
      configure([{ name: 'box', ssh: 'box' }]);
      const client = await host.session();
      expect((await openHub(client, 1)).m).toMatchObject({ t: 'error', req: 1, host: 1, code: 'hub-failed' });
      expect(server.accepted()).toBeGreaterThan(0);
      expect(answersTo(client, 1).map((m) => m.t)).toEqual(['error']);
    } finally {
      server.close();
    }
  });

  it('ends an opening superseded during its probe: the probe’s 200 opens nothing and only the newer request is answered', async () => {
    const server = await heldHttp();
    try {
      ssh.addHost('box').plantWtd(printsPort(server.port));
      ssh.failHost('gpu', 'ssh: Could not resolve hostname gpu');
      configure([
        { name: 'box', ssh: 'box' },
        { name: 'gpu', ssh: 'gpu' },
      ]);
      await restartHub({ WTD_HUB_PROBE_MS: '20000' });
      const client = await host.session();
      client.sendJson({ t: 'openHub', req: 50, host: 1 });
      await waitUntil(() => server.accepted() > 0, 'the probe to reach the remote', REMOTE_TIMEOUT);
      const forwards = ssh.forwardPids('box');
      expect((await openHub(client, 2)).m).toMatchObject({ t: 'error', host: 2, code: 'hub-failed' });
      server.answer('200 OK');
      await waitUntil(() => forwards.every((pid) => !alive(pid)), 'the probe’s forward to end', 5000);
      await sleep(1000);
      expect(answersTo(client, 50)).toEqual([]);
    } finally {
      server.close();
    }
  });

  it('ends the probe of a session that closes, opening nothing once the remote answers', async () => {
    const server = await heldHttp();
    try {
      ssh.addHost('box').plantWtd(printsPort(server.port));
      configure([{ name: 'box', ssh: 'box' }]);
      await restartHub({ WTD_HUB_PROBE_MS: '20000' });
      const client = await host.session();
      client.sendJson({ t: 'openHub', req: 1, host: 1 });
      await waitUntil(() => server.accepted() > 0, 'the probe to reach the remote', REMOTE_TIMEOUT);
      const forwards = ssh.forwardPids('box');
      client.close();
      await sleep(300);
      server.answer('200 OK');
      await waitUntil(() => forwards.every((pid) => !alive(pid)), 'the probe’s forward to end', 5000);
      expect(await host.serving()).toBe(true);
    } finally {
      server.close();
    }
  });
});

describe('hub tunnels', () => {
  it(
    'serves two sessions opening the same host through one listener, each with its own code',
    async () => {
      await remoteHub(host, ssh, 'box', [host.port + 1]);
      configure([{ name: 'box', ssh: 'box' }]);
      const a = await host.session();
      const b = await host.session();
      const [first, second] = await Promise.all([openHub(a, 1), openHub(b, 1)]).then((replies) => replies.map(opened));
      expect(printCodeRuns()).toHaveLength(2);
      expect(first?.port).toBe(host.port + 1);
      expect(second?.port).toBe(first?.port);
      expect(second?.fragment.code).not.toBe(first?.fragment.code);
      for (const tunnel of [first, second]) {
        const { client } = await tunneled(tunnel?.port ?? 0, tunnel?.fragment.code ?? '');
        client.close();
      }
    },
    INSTALL_TIMEOUT,
  );

  it(
    'ends the forward of a connection when the page closes it',
    async () => {
      await remoteHub(host, ssh, 'box', [host.port + 1]);
      configure([{ name: 'box', ssh: 'box' }]);
      const client = await host.session();
      const { port, fragment } = opened(await openHub(client, 1));
      await waitUntil(() => ssh.forwardPids('box').length === 0, 'the probe’s forward to end', 5000);
      const { client: page } = await tunneled(port, fragment.code);
      const pids = await waitUntil(() => ssh.forwardPids('box').length > 0 && ssh.forwardPids('box'), 'the page’s forward');
      page.close();
      await waitUntil(() => pids.every((pid) => !alive(pid)), 'the page’s forwards to end', 5000);
    },
    INSTALL_TIMEOUT,
  );

  it(
    'closes a connection to a host removed from config.json without starting SSH',
    async () => {
      await remoteHub(host, ssh, 'box', [host.port + 1]);
      configure([{ name: 'box', ssh: 'box' }]);
      const client = await host.session();
      const { port } = opened(await openHub(client, 1));
      configure([]);
      await host.session();
      const before = forwardRuns().length;
      await closedSoon(port);
      await sleep(300);
      expect(forwardRuns()).toHaveLength(before);
    },
    INSTALL_TIMEOUT,
  );

  it(
    'rebinds a host whose port changed, closing its old listener',
    async () => {
      const [oldPort, newPort] = [await freePort(), await freePort()];
      await remoteHub(host, ssh, 'box', [oldPort, newPort]);
      configure([{ name: 'box', ssh: 'box', port: oldPort }]);
      const client = await host.session();
      expect(opened(await openHub(client, 1)).port).toBe(oldPort);
      configure([{ name: 'box', ssh: 'box', port: newPort }]);
      const { port, fragment } = opened(await openHub(client, 1));
      expect(port).toBe(newPort);
      const { client: page } = await tunneled(newPort, fragment.code);
      page.close();
      await waitUntil(() => refused(oldPort), 'the old listener to close', 5000);
    },
    INSTALL_TIMEOUT,
  );

  it(
    'repoints its listener when the remote hub now serves another port',
    async () => {
      const { remote, repo: remoteRepo } = await remoteHub(host, ssh, 'box', [host.port + 1]);
      configure([{ name: 'box', ssh: 'box' }]);
      const client = await host.session();
      const first = opened(await openHub(client, 1));
      for (const pid of remote.hubPids()) process.kill(pid, 'SIGKILL');
      await waitUntil(() => remote.hubPids().length === 0, 'the remote hub to exit');
      let remotePort = await freePort();
      while (remotePort === first.port) remotePort = await freePort(); // NOSONAR(S9382) — retries until a port other than the tunnel's is free
      remote.writeHubConfig({ port: remotePort, repos: [remoteRepo] });
      const second = opened(await openHub(client, 1));
      expect(second.port).toBe(first.port);
      const { client: page, hello } = await tunneled(second.port, second.fragment.code);
      expect(hello.instance).toBe(remoteRecord(remote).instance);
      expect(forwardRuns().map((call) => call.forward)).toContain(`127.0.0.1:${String(remotePort)}`);
      page.close();
    },
    INSTALL_TIMEOUT,
  );

  it(
    'ends the open forwards of a listener retired by a port change',
    async () => {
      const [oldPort, newPort] = [await freePort(), await freePort()];
      await remoteHub(host, ssh, 'box', [oldPort, newPort]);
      configure([{ name: 'box', ssh: 'box', port: oldPort }]);
      const client = await host.session();
      const { fragment } = opened(await openHub(client, 1));
      await waitUntil(() => ssh.forwardPids('box').length === 0, 'the probe’s forward to end', 5000);
      const { client: page } = await tunneled(oldPort, fragment.code);
      const pids = await waitUntil(() => ssh.forwardPids('box').length > 0 && ssh.forwardPids('box'), 'the page’s forward');
      configure([{ name: 'box', ssh: 'box', port: newPort }]);
      expect(opened(await openHub(client, 1)).port).toBe(newPort);
      await waitUntil(() => pids.every((pid) => !alive(pid)), 'the retired listener’s forwards to end', 5000);
      expect(await refused(oldPort)).toBe(true);
      page.close();
    },
    INSTALL_TIMEOUT,
  );

  it(
    'closes a connection without starting SSH once the host’s alias was remapped',
    async () => {
      const port = await freePort();
      await remoteHub(host, ssh, 'box', [port]);
      configure([{ name: 'box', ssh: 'box', port }]);
      const client = await host.session();
      opened(await openHub(client, 1));
      configure([{ name: 'box', ssh: 'elsewhere', port }]);
      await host.session();
      const before = ssh.calls().filter((call) => call.forward !== null).length;
      await closedSoon(port);
      await sleep(300);
      expect(ssh.calls().filter((call) => call.forward !== null)).toHaveLength(before);
    },
    INSTALL_TIMEOUT,
  );

  it(
    'closes its listeners and ends every forward on SIGTERM, exiting 0',
    async () => {
      await remoteHub(host, ssh, 'box', [host.port + 1]);
      configure([{ name: 'box', ssh: 'box' }]);
      const client = await host.session();
      const { port, fragment } = opened(await openHub(client, 1));
      const { client: page } = await tunneled(port, fragment.code);
      const pids = await waitUntil(() => ssh.forwardPids('box').length > 0 && ssh.forwardPids('box'), 'the page’s forward');
      hub.kill('SIGTERM');
      expect(await hub.exited).toEqual({ code: 0, signal: null });
      expect(await refused(port)).toBe(true);
      await waitUntil(() => pids.every((pid) => !alive(pid)), 'the forwards to end', 5000);
      page.close();
    },
    INSTALL_TIMEOUT,
  );
});

/** Pids of the SSH runs of `alias` that installed: neither connect, print-code nor a forward. */
const installRuns = (alias = 'box'): number[] =>
  ssh
    .calls()
    .filter((call) => call.alias === alias && call.forward === null && !call.command.includes('connect') && call.command !== PRINT_CODE)
    .map((call) => call.pid);

describe('installing for a hub', () => {
  it(
    'installs the hub’s bundle and answers done, leaving the remote daemon and its terminal running',
    async () => {
      const { remote, remoteRepo } = await installedBox();
      const client = await host.session();
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
      const client = await host.session();
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
      const a = await host.session();
      const b = await host.session();
      await a.waitHost(1, (h) => h.status === 'outdated', { timeout: REMOTE_TIMEOUT });
      const releases = remote.releases();
      const installs = installRuns().length;
      const release = ssh.holdHost('box');
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
      const a = await host.session();
      const b = await host.session();
      const old = await remoteInstance(a, 1);
      const connects = new Set(connectRuns());
      const laterConnects = (): number[] => connectRuns().filter((pid) => !connects.has(pid));
      const installs = new Set(installRuns());
      const release = ssh.holdHost('box');
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
    const client = await host.session();
    expect((await client.hubRequest({ t: 'installHub', host: 0 })).m).toMatchObject({ t: 'error', req: 1, host: 0, code: 'unknown-host' });
  });

  it('answers unknown-host for a host removed from config.json since the session started, installing nothing', async () => {
    ssh.addHost('box');
    configure([{ name: 'box', ssh: 'box' }]);
    const client = await host.session();
    configure([]);
    expect((await client.hubRequest({ t: 'installHub', host: 1 })).m).toMatchObject({ t: 'error', req: 1, host: 1, code: 'unknown-host' });
    expect(installRuns()).toEqual([]);
  });

  it('installs over the alias config.json names now, not the one the session started with', async () => {
    ssh.addHost('box');
    configure([{ name: 'box', ssh: 'old' }]);
    const client = await host.session();
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
    ssh.addHost('box');
    ssh.hangHost('box');
    configure([{ name: 'box', ssh: 'box' }]);
    await restartHub({ WTD_HUB_INSTALL_MS: '1000' });
    const client = await host.session();
    const start = Date.now();
    expect((await client.hubRequest({ t, host: 1 }, 15_000)).m).toMatchObject({ t: 'error', req: 1, host: 1, code: 'internal' });
    expect(Date.now() - start).toBeLessThan(10_000);
  });

  it(
    'answers internal naming the cause when the installation fails',
    async () => {
      ssh.addHost('box');
      configure([{ name: 'box', ssh: 'box' }]);
      const client = await host.session();
      const reply = await client.hubRequest({ t: 'installHub', host: 1 }, INSTALL_TIMEOUT);
      expect(reply.m).toMatchObject({ t: 'error', req: 1, host: 1, code: 'internal' });
      expect(reply.m.t === 'error' ? reply.m.message : '').toMatch(/node/i);
    },
    INSTALL_TIMEOUT + 30_000,
  );
});
