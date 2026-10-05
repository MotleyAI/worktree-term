import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hostPaths, type HostPaths } from '../files/index.js';
import { dial } from './index.js';

/** Stand-in daemon: logs to stdout and stderr, records its pid, serves its pid to every connection. */
const FAKE_DAEMON = `
const fs = require('node:fs');
const net = require('node:net');
const [socket, pids] = process.argv.slice(1);
fs.appendFileSync(pids, process.pid + '\\n');
const stat = fs.readFileSync('/proc/self/stat', 'utf8');
const session = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[3];
console.log('out pid=' + process.pid + ' sid=' + session + ' stdin=' + fs.readlinkSync('/proc/self/fd/0'));
console.error('err pid=' + process.pid);
const server = net.createServer((c) => c.end(String(process.pid)));
server.on('error', () => process.exit(1));
server.listen(socket);
setTimeout(() => process.exit(0), 30000);
`;

let dir: string;
let paths: HostPaths;
let pidsFile: string;
const sockets: Socket[] = [];
const servers: Server[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wtd-dial-'));
  paths = hostPaths({ env: { XDG_STATE_HOME: dir }, home: '/nonexistent', host: 'box' });
  pidsFile = join(dir, 'pids');
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  for (const pid of spawnedPids()) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

const spawnedPids = (): number[] =>
  existsSync(pidsFile)
    ? readFileSync(pidsFile, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map(Number)
    : [];

const fakeDaemon = (): string[] => [process.execPath, '-e', FAKE_DAEMON, paths.socket, pidsFile];

const track = (socket: Socket): Socket => {
  sockets.push(socket);
  return socket;
};

const readAll = (socket: Socket): Promise<string> =>
  new Promise((resolve, reject) => {
    let text = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => (text += chunk));
    socket.on('end', () => {
      resolve(text);
    });
    socket.on('error', reject);
  });

const sessionOf = (pid: number): number => {
  const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
  return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[3]);
};

describe('dial', () => {
  it('connects to a running daemon without starting one', async () => {
    mkdirSync(paths.runDir, { recursive: true, mode: 0o700 });
    const server = createServer((c) => c.end('existing'));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(paths.socket, resolve));
    const socket = track(await dial(paths, fakeDaemon()));
    expect(await readAll(socket)).toBe('existing');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(spawnedPids()).toEqual([]);
  });

  it('starts an absent daemon detached, logging its output, and connects', async () => {
    const socket = track(await dial(paths, fakeDaemon()));
    const [pid] = spawnedPids();
    if (pid === undefined) throw new Error('no daemon was started');
    expect(await readAll(socket)).toBe(String(pid));
    expect(sessionOf(pid)).toBe(pid);
    expect(sessionOf(pid)).not.toBe(sessionOf(process.pid));
    const log = readFileSync(paths.log, 'utf8');
    expect(log).toContain(`out pid=${String(pid)} sid=${String(pid)} stdin=/dev/null`);
    expect(log).toContain(`err pid=${String(pid)}`);
    expect(statSync(paths.log).mode & 0o777).toBe(0o600);
  });

  it('rotates a log over 1 MiB before starting the daemon', async () => {
    mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(paths.log, 'o'.repeat(1024 * 1024 + 1));
    track(await dial(paths, fakeDaemon()));
    expect(statSync(`${paths.log}.1`).size).toBe(1024 * 1024 + 1);
    expect(readFileSync(paths.log, 'utf8')).toMatch(/^out pid=/);
  });

  it('lets concurrent dials share one daemon', async () => {
    const [a, b] = await Promise.all([dial(paths, fakeDaemon()), dial(paths, fakeDaemon())]);
    const [first, second] = await Promise.all([readAll(track(a)), readAll(track(b))]);
    expect(first).toBe(second);
  });

  it('fails after 5 s naming the log when the daemon never serves', async () => {
    const started = Date.now();
    await expect(dial(paths, [process.execPath, '-e', 'process.exit(1)'])).rejects.toThrow(`daemon did not start; see ${paths.log}`);
    expect(Date.now() - started).toBeGreaterThanOrEqual(4900);
  }, 15_000);
});
