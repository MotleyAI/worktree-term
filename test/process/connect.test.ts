import { spawn } from 'node:child_process';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION } from '../../src/protocol/index.js';
import { DaemonClient } from '../support/daemon-client.js';
import { DaemonHost, makeRepo, sessionOf, waitUntil, type WtdProcess } from '../support/daemon-host.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

let host: DaemonHost;

beforeEach(() => {
  host = DaemonHost.create();
});

afterEach(async () => {
  await host.cleanup();
});

/** Runs `wtd connect` and speaks the protocol over its stdio. */
const bridge = (): { process: WtdProcess; client: DaemonClient } => {
  const process_ = host.wtd(['connect']);
  const { stdout, stdin } = process_.child;
  if (stdout === null || stdin === null) throw new Error('wtd connect has no stdio pipes');
  return { process: process_, client: DaemonClient.over(stdout, stdin) };
};

/** Asserts one line on stderr, without a stack trace. */
const expectOneLine = (stderr: string): void => {
  expect(stderr.trimEnd()).not.toBe('');
  expect(stderr.trimEnd()).not.toContain('\n');
  expect(stderr).not.toMatch(/\n\s+at /);
};

describe('wtd connect', () => {
  it('starts an absent daemon detached and relays its hello first', async () => {
    const { process: connect, client } = bridge();
    const hello = await client.waitFor('hello', () => true, { timeout: 10_000 });
    expect(client.received[0]).toEqual({ kind: 'message', message: hello });
    expect(hello.protocol).toBe(PROTOCOL_VERSION);
    expect(hello.protocol).toBe(4);
    const [daemon, ...others] = host.daemonPids();
    if (daemon === undefined) throw new Error('no daemon is running');
    expect(others).toEqual([]);
    expect(sessionOf(daemon)).toBe(daemon);
    expect(sessionOf(daemon)).not.toBe(sessionOf(connect.pid));
    expect(statSync(host.logPath).mode & 0o777).toBe(0o600);
  });

  it('reuses a running daemon', async () => {
    await host.start();
    const before = await (await host.client()).waitFor('hello');
    const { client } = bridge();
    expect(await client.waitFor('hello')).toEqual(before);
    expect(host.daemonPids()).toHaveLength(1);
  });

  it('relays requests and replies unchanged', async () => {
    const repo = makeRepo(join(host.dir, 'repo'));
    const { client } = bridge();
    await client.handshake();
    const state = await client.watch(repo);
    expect(state.worktrees.map((w) => w.path)).toEqual([repo]);
    const term = await client.create(repo, { command: 'echo through-the-bridge; exec sleep 60' });
    const view = await client.attach(term.termId);
    // The line may precede the attach, so it is looked for in the snapshot and the output alike.
    await waitUntil(async () => (await view.screen.text()).includes('through-the-bridge'), 'the echoed line on the screen');
    expect(client.decodeError).toBeNull();
  });

  it('exits 0 when the daemon shuts down, and the next connect starts a new daemon', async () => {
    const first = bridge();
    const hello = await first.client.handshake();
    first.client.send({ t: 'shutdown' });
    expect((await first.process.exited).code).toBe(0);
    await waitUntil(() => host.daemonPids().length === 0, 'the daemon to exit');
    const second = bridge();
    const next = await second.client.waitFor('hello', () => true, { timeout: 10_000 });
    expect(next.instance).not.toBe(hello.instance);
  });

  it('half-closes on end of input and exits 0 once the daemon closes, leaving the daemon running', async () => {
    const first = bridge();
    const hello = await first.client.handshake();
    first.process.child.stdin?.end();
    expect((await first.process.exited).code).toBe(0);
    const second = bridge();
    expect((await second.client.waitFor('hello', () => true, { timeout: 10_000 })).instance).toBe(hello.instance);
  });

  it('lets concurrent connects share one daemon', async () => {
    const bridges = [bridge(), bridge(), bridge()];
    const hellos = await Promise.all(bridges.map(({ client }) => client.waitFor('hello', () => true, { timeout: 10_000 })));
    expect(new Set(hellos.map((h) => h.instance)).size).toBe(1);
    await waitUntil(() => host.daemonPids().length === 1, 'a single daemon');
  });

  it('fails with one line naming the log when the daemon cannot start', async () => {
    mkdirSync(host.runDir, { recursive: true, mode: 0o700 });
    const holder = spawn('sleep', ['60']);
    try {
      writeFileSync(host.lock, JSON.stringify({ pid: holder.pid, nonce: 'held' }), { mode: 0o600 });
      const connect = host.wtd(['connect']);
      const started = Date.now();
      expect((await connect.exited).code).toBe(1);
      expect(Date.now() - started).toBeGreaterThanOrEqual(4900);
      expectOneLine(connect.stderr);
      expect(connect.stderr).toContain(`daemon did not start; see ${host.logPath}`);
    } finally {
      holder.kill('SIGKILL');
    }
  });

  it('fails with one line naming the path when the socket path is too long', async () => {
    const long = join(host.dir, 'x'.repeat(100));
    const connect = host.wtd(['connect'], { XDG_STATE_HOME: long });
    expect((await connect.exited).code).toBe(1);
    expectOneLine(connect.stderr);
    expect(connect.stderr).toContain(join(long, 'worktree-term', 'run'));
  });
});
