import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { alive, sessionOf, sleep, waitUntil, WtdProcess, type Exit } from '../support/daemon-host.js';
import { REPO_ROOT } from '../support/exec.js';
import { HubHost } from '../support/hub-host.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

let host: HubHost;
const cleanups: (() => Promise<void> | void)[] = [];

beforeEach(async () => {
  host = await HubHost.createHub();
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await host.cleanup();
});

const packageVersion = (): string => {
  const pkg: unknown = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  if (typeof pkg !== 'object' || pkg === null || !('version' in pkg) || typeof pkg.version !== 'string') throw new Error('no version');
  return pkg.version;
};

/** Asserts one line on stderr, without a stack trace. */
const expectOneLine = (stderr: string): void => {
  expect(stderr.trimEnd()).not.toBe('');
  expect(stderr.trimEnd()).not.toContain('\n');
  expect(stderr).not.toMatch(/\n\s+at /);
};

const waitExit = async (process_: WtdProcess, timeout = 15_000): Promise<Exit> => {
  const exit = await Promise.race([process_.exited, sleep(timeout).then(() => null)]);
  if (exit === null) throw new Error(`process did not exit: ${process_.stderr}`);
  return exit;
};

/** Holds `port` on 127.0.0.1 with a plain TCP server until the test ends. */
const holdPort = async (port: number): Promise<Server> => {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  );
  return server;
};

/** A long-running process that is not a hub. */
const bystander = (): ChildProcess => {
  const child = spawn('sleep', ['60'], { stdio: 'ignore' });
  cleanups.push(() => {
    child.kill('SIGKILL');
  });
  return child;
};

const prepareStateDirs = (): void => {
  mkdirSync(host.runDir, { recursive: true, mode: 0o700 });
  chmodSync(host.stateDir, 0o700);
  chmodSync(host.runDir, 0o700);
};

const APP_URL = (port: number): RegExp => new RegExp(`^--app=http://127\\.0\\.0\\.1:${String(port)}/#code=[0-9a-f]{64}$`);

const codeOf = (arg: string): string => arg.slice(arg.indexOf('#code=') + '#code='.length);

describe('wtd hub', () => {
  it('serves in the foreground until SIGTERM, then removes its record and exits 0', async () => {
    const hub = await host.startHub();
    expect(host.record()?.pid).toBe(hub.pid);
    hub.kill('SIGTERM');
    expect(await waitExit(hub)).toEqual({ code: 0, signal: null });
    expect(host.record()).toBeNull();
  });

  it('stops on SIGINT and exits 0', async () => {
    const hub = await host.startHub();
    hub.kill('SIGINT');
    expect(await waitExit(hub)).toEqual({ code: 0, signal: null });
  });

  it('refuses to start while another hub runs, leaving it unaffected', async () => {
    const first = await host.startHub();
    const before = await host.identity();
    const second = host.wtd(['hub']);
    expect(await waitExit(second)).toEqual({ code: 1, signal: null });
    expect(second.stderr).toBe('wtd hub: already running\n');
    expect(alive(first.pid)).toBe(true);
    expect(await host.identity()).toEqual(before);
    expect(host.record()?.pid).toBe(first.pid);
  });

  it('leaves the running hub’s token in the file when two hubs start at once without one', async () => {
    for (let round = 0; round < 3; round++) {
      rmSync(host.tokenPath, { force: true });
      const [a, b] = [host.wtd(['hub']), host.wtd(['hub'])];
      const first = await Promise.race([a, b].map(async (hub) => ({ hub, exit: await hub.exited }))); // NOSONAR(S9382) — rounds must not overlap
      expect(first.exit.code).toBe(1);
      const winner = first.hub === a ? b : a;
      await waitUntil(() => host.serving(), 'the remaining hub to accept the token in the file'); // NOSONAR(S9382) — rounds must not overlap
      winner.kill('SIGTERM');
      await waitExit(winner); // NOSONAR(S9382) — rounds must not overlap
    }
  });

  it('reports a port held by another process', async () => {
    await holdPort(host.port);
    const hub = host.wtd(['hub']);
    expect(await waitExit(hub)).toEqual({ code: 1, signal: null });
    expect(hub.stderr).toBe(`wtd hub: port ${String(host.port)} is in use\n`);
    expect(host.record()).toBeNull();
  });

  it.each([
    ['an unknown key', { theme: 'dark' }, 'theme'],
    ['an empty presets list', { presets: [] }, 'presets'],
    [
      'two presets named a',
      {
        presets: [
          { name: 'a', command: null },
          { name: 'a', command: 'x' },
        ],
      },
      'presets',
    ],
    ['a preset whose command is empty', { presets: [{ name: 'a', command: '' }] }, 'presets'],
  ])('reports a configuration with %s in one line naming the file and the key', async (_name, config, key) => {
    host.writeConfig({ port: host.port, ...config });
    const hub = host.wtd(['hub']);
    expect(await waitExit(hub)).toEqual({ code: 1, signal: null });
    expectOneLine(hub.stderr);
    expect(hub.stderr).toContain(host.configPath);
    expect(hub.stderr).toContain(key);
  });

  it('starts with valid presets', async () => {
    host.writeConfig({
      port: host.port,
      presets: [
        { name: 'claude', command: 'claude' },
        { name: 'shell', command: null },
      ],
    });
    const hub = await host.startHub();
    expect(host.record()?.pid).toBe(hub.pid);
  });

  it('reports a configuration that is not JSON', async () => {
    mkdirSync(host.configDir, { recursive: true });
    writeFileSync(host.configPath, '{"port":');
    const hub = host.wtd(['hub']);
    expect(await waitExit(hub)).toEqual({ code: 1, signal: null });
    expectOneLine(hub.stderr);
    expect(hub.stderr).toContain(host.configPath);
  });

  it('reports a missing web bundle', async () => {
    mkdirSync(join(REPO_ROOT, 'build'), { recursive: true });
    const dir = mkdtempSync(join(REPO_ROOT, 'build', 'no-bundle-'));
    cleanups.push(() => {
      rmSync(dir, { recursive: true, force: true });
    });
    copyFileSync(join(REPO_ROOT, 'dist', 'wtd.mjs'), join(dir, 'wtd.mjs'));
    const hub = new WtdProcess(spawn(process.execPath, [join(dir, 'wtd.mjs'), 'hub'], { env: host.env(), stdio: 'pipe' }));
    cleanups.push(() => {
      hub.kill('SIGKILL');
    });
    expect(await waitExit(hub)).toEqual({ code: 1, signal: null });
    expectOneLine(hub.stderr);
    expect(hub.stderr).toMatch(/web|bundle/i);
    expect(host.record()).toBeNull();
  });

  it('reports an unusable token file in one line naming it', async () => {
    prepareStateDirs();
    symlinkSync('/dev/null', host.tokenPath);
    const hub = host.wtd(['hub']);
    expect(await waitExit(hub)).toEqual({ code: 1, signal: null });
    expectOneLine(hub.stderr);
    expect(hub.stderr).toContain(host.tokenPath);
  });

  it('rejects an argument', async () => {
    const hub = host.wtd(['hub', 'extra']);
    expect((await waitExit(hub)).code).toBe(2);
  });
});

describe('wtd ui', () => {
  /** Runs `wtd ui` to completion. */
  const ui = async (env: Record<string, string | undefined> = {}): Promise<{ exit: Exit; process: WtdProcess }> => {
    const process_ = host.wtd(['ui'], env).captureStdout();
    return { exit: await waitExit(process_, 20_000), process: process_ };
  };

  it('starts a detached hub and opens the browser with a one-time code, never the token', async () => {
    prepareStateDirs();
    writeFileSync(host.hubLogPath, 'earlier output\n', { mode: 0o600 });
    const { exit, process: run } = await ui();
    expect(exit).toEqual({ code: 0, signal: null });
    expect(run.stderr).toBe('');
    const record = host.record();
    if (record === null) throw new Error('no hub record');
    expect(record.port).toBe(host.port);
    expect(alive(record.pid)).toBe(true);
    expect(sessionOf(record.pid)).toBe(record.pid);
    expect(host.hubPids()).toEqual([record.pid]);
    expect(await host.identity()).toEqual({ version: packageVersion(), instance: record.instance });
    expect(readFileSync(host.hubLogPath, 'utf8').startsWith('earlier output\n')).toBe(true);

    await waitUntil(() => host.browserCalls().length === 1, 'the browser');
    const [call] = host.browserCalls();
    if (call === undefined) throw new Error('no browser call');
    expect(call.args).toHaveLength(1);
    expect(call.args[0]).toMatch(APP_URL(host.port));
    expect(call.args.join(' ')).not.toContain(host.token());
    expect(call.stdout).toBe('/dev/null');
    expect(call.sid).not.toBe(sessionOf(process.pid));

    const client = await host.open(['wtd', `wtd.code.${codeOf(call.args[0] ?? '')}`]);
    expect(await client.waitFor('token')).toEqual({ t: 'token', token: host.token() });
  });

  it('runs google-chrome from PATH when WTD_BROWSER is unset', async () => {
    host.writeStub('google-chrome');
    const { exit } = await ui({ WTD_BROWSER: undefined, PATH: `${host.stubDir}:${process.env['PATH'] ?? ''}` });
    expect(exit).toEqual({ code: 0, signal: null });
    await waitUntil(() => host.browserCalls().length === 1, 'the browser');
    expect(host.browserCalls()[0]?.args[0]).toMatch(APP_URL(host.port));
  });

  it('reuses a running hub of the same version', async () => {
    const hub = await host.startHub();
    const before = host.record();
    const { exit } = await ui();
    expect(exit).toEqual({ code: 0, signal: null });
    expect(host.record()).toEqual(before);
    expect(alive(hub.pid)).toBe(true);
    expect(host.hubPids()).toEqual([hub.pid]);
    await waitUntil(() => host.browserCalls().length === 1, 'the browser');
  });

  it('replaces a running hub of another version', async () => {
    prepareStateDirs();
    const token = 'c'.repeat(64);
    writeFileSync(host.tokenPath, token, { mode: 0o600 });
    const shutdowns: string[] = [];
    const fake: HttpServer = createHttpServer((req: IncomingMessage, res) => {
      const authorized = req.headers.authorization === `Bearer ${token}`;
      if (!authorized) {
        res.writeHead(401).end();
        return;
      }
      if (req.method === 'GET' && req.url === '/api/identity') {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ version: '0.0.0-old', instance: 'old_hub' }));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/shutdown') {
        shutdowns.push(req.headers.authorization ?? '');
        res.writeHead(200).end('{}', () => {
          fake.close();
          fake.closeAllConnections();
        });
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => fake.listen(host.port, '127.0.0.1', resolve));
    cleanups.push(() => {
      fake.closeAllConnections();
      fake.close();
    });
    const pidHolder = bystander();
    writeFileSync(host.recordPath, JSON.stringify({ pid: pidHolder.pid, port: host.port, instance: 'old_hub' }), { mode: 0o600 });

    const { exit } = await ui();
    expect(exit).toEqual({ code: 0, signal: null });
    expect(shutdowns).toEqual([`Bearer ${token}`]);
    expect(alive(pidHolder.pid ?? 0)).toBe(true);
    const identity = await host.identity();
    expect(identity.version).toBe(packageVersion());
    expect(identity.instance).not.toBe('old_hub');
    expect(host.record()?.instance).toBe(identity.instance);
    await waitUntil(() => host.browserCalls().length === 1, 'the browser');
  });

  it('never signals a live non-hub process named by a stale record', async () => {
    prepareStateDirs();
    const other = bystander();
    const pid = other.pid ?? 0;
    writeFileSync(host.recordPath, JSON.stringify({ pid, port: host.port, instance: 'gone_hub' }), { mode: 0o600 });
    const { exit } = await ui();
    expect(exit).toEqual({ code: 0, signal: null });
    await sleep(300);
    expect(alive(pid)).toBe(true);
    const record = host.record();
    expect(record?.pid).not.toBe(pid);
    expect(alive(record?.pid ?? 0)).toBe(true);
    expect(await host.serving()).toBe(true);
  });

  it('reports a missing browser command in one line naming it', async () => {
    const { exit, process: run } = await ui({ WTD_BROWSER: '/nonexistent/browser' });
    expect(exit).toEqual({ code: 1, signal: null });
    expectOneLine(run.stderr);
    expect(run.stderr).toContain('/nonexistent/browser');
    expect(host.browserCalls()).toEqual([]);
  });

  it('reports a hub that cannot start in one line', async () => {
    await holdPort(host.port);
    const { exit, process: run } = await ui();
    expect(exit).toEqual({ code: 1, signal: null });
    expectOneLine(run.stderr);
    expect(host.browserCalls()).toEqual([]);
    expect(existsSync(host.recordPath)).toBe(false);
  });
});
