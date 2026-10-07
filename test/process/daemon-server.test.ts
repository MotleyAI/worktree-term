import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeStreamData, PROTOCOL_VERSION } from '../../src/protocol/index.js';
import type { DaemonClient } from '../support/daemon-client.js';
import { REPO_ROOT } from '../support/exec.js';
import {
  addWorktree,
  alive,
  canConnect,
  DaemonHost,
  fakeWorktrees,
  makeRepo,
  residentBytes,
  sleep,
  waitUntil,
  type WtdProcess,
} from '../support/daemon-host.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

const ANY_TEXT: unknown = expect.any(String);

const MiB = 1024 * 1024;

let host: DaemonHost;

beforeEach(() => {
  host = DaemonHost.create();
});

afterEach(async () => {
  await host.cleanup();
});

const packageVersion = (): string => {
  const pkg: unknown = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  if (typeof pkg !== 'object' || pkg === null || !('version' in pkg) || typeof pkg.version !== 'string') throw new Error('no version');
  return pkg.version;
};

const inode = (path: string): number => statSync(path).ino;

/** Asserts one line on stderr, without a stack trace. */
const expectOneLine = (stderr: string): void => {
  expect(stderr.trimEnd()).not.toBe('');
  expect(stderr.trimEnd()).not.toContain('\n');
  expect(stderr).not.toMatch(/\n\s+at /);
};

/** Leaves a socket file behind with nothing listening on it. */
const staleSocket = (path: string): void => {
  const script = `require('node:net').createServer().listen(process.argv[1], () => process.kill(process.pid, 'SIGKILL'))`;
  spawnSync(process.execPath, ['-e', script, path]);
  if (!existsSync(path)) throw new Error('no stale socket was left behind');
};

describe('socket', () => {
  it('is owner-only inside owner-only directories', async () => {
    await host.start();
    expect(statSync(host.socket).isSocket()).toBe(true);
    expect(statSync(host.socket).mode & 0o777).toBe(0o600);
    expect(statSync(host.runDir).mode & 0o777).toBe(0o700);
    expect(statSync(host.stateDir).mode & 0o777).toBe(0o700);
  });

  it('is replaced when left behind by a killed daemon', async () => {
    const first = await host.start();
    const before = await (await host.client()).waitFor('hello');
    first.kill('SIGKILL');
    await first.exited;
    expect(existsSync(host.socket)).toBe(true);
    await host.start();
    const after = await (await host.client()).waitFor('hello');
    expect(after.instance).not.toBe(before.instance);
  });

  it('is replaced when stale before the first start', async () => {
    mkdirSync(host.runDir, { recursive: true, mode: 0o700 });
    staleSocket(host.socket);
    await host.start();
    expect((await host.client()).isClosed).toBe(false);
  });

  it('is not removed on exit when it is no longer the one the daemon bound', async () => {
    const daemon = await host.start();
    renameSync(host.socket, `${host.socket}.moved`);
    writeFileSync(host.socket, 'someone else');
    daemon.kill('SIGTERM');
    expect((await daemon.exited).code).toBe(0);
    expect(readFileSync(host.socket, 'utf8')).toBe('someone else');
  });
});

describe('single instance', () => {
  it('refuses a second daemon, leaving the first serving', async () => {
    await host.start();
    const before = await (await host.client()).waitFor('hello');
    const second = host.wtd(['daemon']);
    expect((await second.exited).code).toBe(1);
    expect(second.stderr).toBe('wtd daemon: already running\n');
    expect(await (await host.client()).waitFor('hello')).toEqual(before);
  });

  it('does not displace a suspended starter holding the start lock', async () => {
    mkdirSync(host.runDir, { recursive: true, mode: 0o700 });
    staleSocket(host.socket);
    const staleInode = inode(host.socket);
    const holder = spawn('sleep', ['60']);
    const holderPid = holder.pid;
    if (holderPid === undefined) throw new Error('no holder');
    try {
      process.kill(holderPid, 'SIGSTOP');
      const lock = JSON.stringify({ pid: holderPid, nonce: 'suspended' });
      writeFileSync(host.lock, lock, { mode: 0o600 });
      const second = host.wtd(['daemon']);
      await sleep(1000);
      expect(inode(host.socket)).toBe(staleInode);
      expect(await canConnect(host.socket)).toBe(false);
      expect(readFileSync(host.lock, 'utf8')).toBe(lock);
      const exit = await second.exited;
      expect(exit.code).toBe(1);
      expectOneLine(second.stderr);
      expect(inode(host.socket)).toBe(staleInode);
    } finally {
      holder.kill('SIGKILL');
    }
    await waitUntil(() => !alive(holderPid), 'the lock holder to die');
    await host.start();
    expect(await canConnect(host.socket)).toBe(true);
  });

  it('prints one line and exits 1 when the socket path is too long', async () => {
    const long = join(host.dir, 'x'.repeat(100));
    const daemon = host.wtd(['daemon'], { XDG_STATE_HOME: long });
    expect((await daemon.exited).code).toBe(1);
    expectOneLine(daemon.stderr);
    expect(daemon.stderr).toContain(join(long, 'worktree-term', 'run'));
  });
});

describe('handshake', () => {
  it('greets every connection with hello for protocol 4, the package version and one instance id', async () => {
    await host.start();
    const a = await host.rawClient();
    const b = await host.rawClient();
    const helloA = await a.waitFor('hello');
    const helloB = await b.waitFor('hello');
    expect(a.received[0]).toEqual({ kind: 'message', message: helloA });
    expect(helloA.protocol).toBe(PROTOCOL_VERSION);
    expect(helloA.protocol).toBe(4);
    expect(helloA.version).toBe(packageVersion());
    expect(helloA.instance).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(helloB.instance).toBe(helloA.instance);
  });

  it('answers a request before hello with bad-message and closes', async () => {
    await host.start();
    const client = await host.rawClient();
    await client.waitFor('hello');
    client.sendJson({ t: 'watchRepo', req: 1, repo: host.dir });
    expect(await client.waitFor('error')).toEqual({ t: 'error', req: null, code: 'bad-message', message: ANY_TEXT });
    await client.waitClosed();
  });

  it('answers a broken stream before hello with bad-message and closes', async () => {
    await host.start();
    const client = await host.rawClient();
    await client.waitFor('hello');
    client.sendRaw(new Uint8Array([0, 0, 0, 1, 9, 0]));
    expect((await client.waitFor('error')).code).toBe('bad-message');
    await client.waitClosed();
  });

  it('lets a mismatched client do nothing but shut the daemon down', async () => {
    const daemon = await host.start();
    const client = await host.rawClient();
    await client.handshake(1);
    client.sendJson({ t: 'watchRepo', req: 1, repo: host.dir });
    expect(await client.waitFor('error')).toEqual({ t: 'error', req: null, code: 'version-mismatch', message: ANY_TEXT });
    const from = client.mark();
    client.sendJson({ t: 'frobnicate' });
    expect((await client.waitFor('error', () => true, { from })).code).toBe('version-mismatch');
    expect(client.isClosed).toBe(false);
    client.send({ t: 'shutdown' });
    expect((await daemon.exited).code).toBe(0);
    expect(existsSync(host.socket)).toBe(false);
  });
});

describe('malformed traffic', () => {
  const output = encodeStreamData({ kind: 'output', termId: 1, offset: 0, data: new Uint8Array([120]) });
  const snapshot = encodeStreamData({ kind: 'snapshot', termId: 1, offset: 0, data: new Uint8Array([120]) });
  const hello = { t: 'hello', protocol: PROTOCOL_VERSION, version: '1', instance: 'again' };

  it.each([
    [
      'a control message with an extra field',
      (c: DaemonClient) => {
        c.sendJson({ t: 'attach', req: 1, termId: 1, x: 1 });
      },
    ],
    [
      'a second hello',
      (c: DaemonClient) => {
        c.sendJson(hello);
      },
    ],
    [
      'an output frame',
      (c: DaemonClient) => {
        c.sendRaw(output);
      },
    ],
    [
      'a snapshot frame',
      (c: DaemonClient) => {
        c.sendRaw(snapshot);
      },
    ],
    [
      'a frame of unknown kind',
      (c: DaemonClient) => {
        c.sendRaw(new Uint8Array([0, 0, 0, 0, 7]));
      },
    ],
  ])('closes only the connection that sent %s', async (_name, misbehave) => {
    const repo = makeRepo(join(host.dir, 'repo'));
    await host.start();
    const good = await host.client();
    await good.watch(repo);
    const term = await good.create(repo, { command: 'sleep 60' });
    const bad = await host.client();
    misbehave(bad);
    expect(await bad.waitFor('error')).toEqual({ t: 'error', req: null, code: 'bad-message', message: ANY_TEXT });
    await bad.waitClosed();
    await good.attach(term.termId);
    const state = await good.watch(repo);
    expect(state.terminals.find((t) => t.termId === term.termId)?.exit).toBeNull();
  });
});

describe('multiple clients', () => {
  it('serves concurrent clients independently', async () => {
    const repo = makeRepo(join(host.dir, 'repo'));
    await host.start();
    const clients = await Promise.all([host.client(), host.client(), host.client()]);
    const states = await Promise.all(clients.map((c) => c.watch(repo)));
    for (const state of states) expect(state.worktrees.map((w) => w.path)).toEqual([repo]);
    const [a, b] = clients;
    const from = b.mark();
    expect((await a.request({ t: 'detach', termId: 1 })).t).toBe('error');
    await sleep(200);
    expect(b.messages.slice(from)).toEqual([]);
  });
});

describe('bounded connection queue', () => {
  it('keeps memory bounded and the PTY running for others when a client stops reading', async () => {
    const repo = makeRepo(join(host.dir, 'repo'));
    const daemon = await host.start();
    const reader = await host.client();
    await reader.watch(repo);
    const term = await reader.create(repo, { command: 'yes 0123456789abcdefghijklmnopqrstuvwxyz' });
    const stalled = await host.client();
    await stalled.watch(repo);
    stalled.autoAck = false;
    await stalled.attach(term.termId);
    stalled.pauseReading();
    const view = await reader.attach(term.termId);
    const baseline = residentBytes(daemon.pid);
    let peak = baseline;
    const start = view.position;
    for (let i = 0; i < 20; i++) {
      await sleep(250);
      peak = Math.max(peak, residentBytes(daemon.pid));
    }
    expect(peak - baseline).toBeLessThan(128 * MiB);
    expect(view.position - start).toBeGreaterThan(8 * MiB);
    expect(view.gaps).toEqual([]);
    stalled.resumeReading();
    expect(await stalled.waitFor('detached')).toEqual({ t: 'detached', termId: term.termId, reason: 'lagging' });
  });

  it('closes a connection whose unread replies exceed 64 MiB', async () => {
    const repo = makeRepo(join(host.dir, 'repo'));
    fakeWorktrees(repo, 1000, 200);
    const daemon = await host.start();
    const flooder = await host.client();
    const first = await flooder.watch(repo);
    expect(first.worktrees).toHaveLength(1001);
    const replySize = JSON.stringify(first).length;
    flooder.pauseReading();
    const baseline = residentBytes(daemon.pid);
    const requests = Math.ceil((160 * MiB) / replySize);
    for (let req = 100; req < 100 + requests; req++) flooder.sendJson({ t: 'watchRepo', req, repo });
    let peak = baseline;
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      peak = Math.max(peak, residentBytes(daemon.pid));
    }
    flooder.resumeReading();
    await flooder.waitClosed(30_000);
    expect(flooder.messages.filter((m) => m.t === 'repoState').length).toBeLessThan(requests);
    expect(peak - baseline).toBeLessThan(160 * MiB);
    const other = await host.client();
    expect((await other.watch(repo)).worktrees).toHaveLength(1001);
  });
});

describe('shutdown', () => {
  const stopBy: readonly [string, (daemon: WtdProcess, client: DaemonClient) => void][] = [
    [
      'shutdown',
      (_daemon, client) => {
        client.send({ t: 'shutdown' });
      },
    ],
    [
      'SIGTERM',
      (daemon) => {
        daemon.kill('SIGTERM');
      },
    ],
    [
      'SIGINT',
      (daemon) => {
        daemon.kill('SIGINT');
      },
    ],
  ];

  it.each(stopBy)('%s ends every terminal, removes the socket and exits 0', async (_name, stop) => {
    const repo = makeRepo(join(host.dir, 'repo'));
    const daemon = await host.start();
    const client = await host.client();
    await client.watch(repo);
    for (const name of ['a', 'b']) {
      await client.create(repo, { command: `echo $$ > ${name}.pid; exec sleep 600` });
    }
    const pids = await waitUntil(() => {
      const files = ['a', 'b'].map((name) => join(repo, `${name}.pid`));
      return (
        files.every((f) => existsSync(f) && readFileSync(f, 'utf8').endsWith('\n')) && files.map((f) => Number(readFileSync(f, 'utf8')))
      );
    }, 'terminal pids');
    stop(daemon, client);
    expect(await daemon.exited).toEqual({ code: 0, signal: null });
    expect(existsSync(host.socket)).toBe(false);
    await waitUntil(() => pids.every((pid) => !alive(pid)), 'terminal processes to end', 8000);
  });

  it('completes a state write requested just before shutdown', async () => {
    const repo = makeRepo(join(host.dir, 'repo'));
    const wt = addWorktree(repo, join(host.dir, 'wt'), 'wt');
    const daemon = await host.start();
    const client = await host.client();
    await client.watch(repo);
    client.sendJson({ t: 'setChecked', req: 50, worktree: wt, checked: true });
    client.send({ t: 'shutdown' });
    expect((await daemon.exited).code).toBe(0);
    await host.start();
    expect((await (await host.client()).watch(repo)).checked).toEqual([wt]);
  });

  it('ignores SIGHUP', async () => {
    const daemon = await host.start();
    daemon.kill('SIGHUP');
    await sleep(300);
    expect(alive(daemon.pid)).toBe(true);
    expect(await canConnect(host.socket)).toBe(true);
  });
});
