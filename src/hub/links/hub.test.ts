import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hostPaths } from '../../platform/files/index.js';
import { forwardToHub, HubOpener, PRINT_CODE_COMMAND, type HubOpenResult } from './index.js';

const CODE = '0123456789abcdef'.repeat(4);
const LINE = `{"port":7417,"code":"${CODE}"}`;
const LOGIN = 'https://login.tailscale.com/a/abc123';
const BANNER = `# To authenticate, visit: ${LOGIN}`;

let dir: string;
let paths: ReturnType<typeof hostPaths>;
let servers: Server[];
let sockets: Socket[];

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'wtd-hub-link-')));
  paths = hostPaths({ env: { XDG_STATE_HOME: join(dir, 's') }, home: '/nonexistent', host: 'local' });
  servers = [];
  sockets = [];
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const socket of sockets) socket.destroy();
  for (const server of servers) server.close();
  for (const pid of pids()) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Installs `body` as the SSH program; `$D` is the test directory, `$@` the SSH arguments. */
const fakeSsh = (body: string): void => {
  const program = join(dir, 'ssh');
  writeFileSync(program, `#!/bin/sh\nD='${dir}'\nfor a in "$@"; do printf '%s\\0' "$a"; done > "$D/args"\necho $$ >> "$D/pids"\n${body}\n`);
  chmodSync(program, 0o755);
  vi.stubEnv('WTD_SSH', program);
};

const fileText = (name: string): string => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : '');

const args = (): string[] => fileText('args').split('\0').slice(0, -1);

const pids = (): number[] => fileText('pids').split('\n').filter(Boolean).map(Number);

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitFor = async (probe: () => boolean, what: string, timeout = 5000): Promise<void> => {
  const deadline = Date.now() + timeout;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
};

const SSH_OPTIONS = (): string[] => [
  '-o',
  'BatchMode=yes',
  '-o',
  'ConnectTimeout=10',
  '-o',
  'ControlMaster=auto',
  '-o',
  'ControlPersist=10m',
  '-o',
  `ControlPath=${paths.runDir}/ssh-%C`,
  '-o',
  'ServerAliveInterval=15',
];

interface Opening {
  logins: string[];
  results: HubOpenResult[];
  done: Promise<HubOpenResult>;
  cancel: () => void;
}

const open = (options?: { timeoutMs?: number }, alias = 'box'): Opening => {
  const logins: string[] = [];
  const results: HubOpenResult[] = [];
  let resolveDone: (result: HubOpenResult) => void = () => undefined;
  const done = new Promise<HubOpenResult>((resolve) => {
    resolveDone = resolve;
  });
  const opening = new HubOpener(paths, alias, options).open({
    login: (url) => logins.push(url),
    done: (result) => {
      results.push(result);
      resolveDone(result);
    },
  });
  return { logins, results, done, cancel: opening.cancel };
};

describe('HubOpener', () => {
  it('runs the print-code command over SSH with the remote link options', async () => {
    fakeSsh(`printf '%s\\n' '${LINE}'`);
    await open().done;
    expect(args()).toEqual([...SSH_OPTIONS(), '--', 'box', PRINT_CODE_COMMAND]);
    expect(PRINT_CODE_COMMAND).toBe('"$HOME/.local/bin/wtd" ui --print-code');
  });

  it('opens with the printed port and code', async () => {
    fakeSsh(`printf '%s\\n' '${LINE}'`);
    expect(await open().done).toEqual({ kind: 'opened', port: 7417, code: CODE });
  });

  it('reports each login URL once, without a time limit after the first', async () => {
    fakeSsh(
      `printf '%s\\n' '${BANNER}' '${BANNER}' >&2; sleep 0.6; printf '%s\\n' '# To authenticate, visit: https://login.tailscale.com/a/other' >&2; printf '%s\\n' '${LINE}'`,
    );
    const opening = open({ timeoutMs: 300 });
    expect(await opening.done).toEqual({ kind: 'opened', port: 7417, code: CODE });
    expect(opening.logins).toEqual([LOGIN, 'https://login.tailscale.com/a/other']);
  });

  it('reports the login URL while SSH still waits', async () => {
    fakeSsh(`printf '%s\\n' '${BANNER}' >&2; exec sleep 600`);
    const opening = open();
    await waitFor(() => opening.logins.length === 1, 'the login URL');
    expect(opening.results).toEqual([]);
    opening.cancel();
  });

  it('fails a silent run after its time limit, killing it', async () => {
    fakeSsh('exec sleep 600');
    const started = Date.now();
    const result = await open({ timeoutMs: 300 }).done;
    expect(result.kind).toBe('failed');
    expect(result.kind === 'failed' ? result.message : '').toMatch(/did not answer within/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    await waitFor(() => pids().every((pid) => !alive(pid)), 'the SSH process to be killed');
  });

  it('kills a silent run that ignores SIGTERM', async () => {
    fakeSsh("trap '' TERM; exec sleep 600");
    const result = await open({ timeoutMs: 300 }).done;
    expect(result.kind).toBe('failed');
    await waitFor(() => pids().every((pid) => !alive(pid)), 'the SSH process to be killed', 10_000);
  });

  it('fails and kills a run writing more than 4096 bytes to standard output', async () => {
    fakeSsh('head -c 5000 /dev/zero | tr "\\000" x; exec sleep 600');
    const result = await open().done;
    expect(result.kind).toBe('failed');
    expect(result.kind === 'failed' ? result.message : '').toMatch(/4096 bytes/);
    await waitFor(() => pids().every((pid) => !alive(pid)), 'the SSH process to be killed');
  });

  it.each([
    ['exits with status 2', "echo 'wtd: unknown option --print-code' >&2; exit 2"],
    ['exits with status 127', "echo 'sh: 1: /home/u/.local/bin/wtd: not found' >&2; exit 127"],
    ['prints something else than a print-code line', "echo 'Usage: wtd <command>'"],
    ['prints a second line', `printf '%s\\n' '${LINE}' '${LINE}'`],
    ['prints nothing', 'exit 0'],
  ])('reports wtd missing or outdated when it %s', async (_name, body) => {
    fakeSsh(body);
    const result = await open().done;
    expect(result.kind).toBe('outdated');
    expect(result.kind === 'outdated' ? result.message : '').toMatch(/missing or too old/);
  });

  it('fails with SSH’s last standard error line', async () => {
    fakeSsh("echo 'debug noise' >&2; echo 'ssh: Could not resolve hostname box: Name or service not known' >&2; exit 255");
    expect(await open().done).toEqual({ kind: 'failed', message: 'ssh: Could not resolve hostname box: Name or service not known' });
  });

  it('fails naming the exit status without standard error', async () => {
    fakeSsh('exit 1');
    const result = await open().done;
    expect(result.kind).toBe('failed');
    expect(result.kind === 'failed' ? result.message : '').toMatch(/status 1/);
  });

  it('kills the run on cancel and reports nothing afterwards', async () => {
    fakeSsh(`sleep 0.3; printf '%s\\n' '${BANNER}' >&2; printf '%s\\n' '${LINE}'; exec sleep 600`);
    const opening = open();
    await waitFor(() => pids().length === 1, 'the SSH process to start');
    opening.cancel();
    await waitFor(() => pids().every((pid) => !alive(pid)), 'the SSH process to be killed');
    await sleep(600);
    expect(opening.logins).toEqual([]);
    expect(opening.results).toEqual([]);
  });
});

/** A connected socket pair over a local TCP server: the hub's side and the browser's side. */
const socketPair = async (): Promise<{ hub: Socket; browser: Socket }> => {
  let accepted: (socket: Socket) => void = () => undefined;
  const hubSide = new Promise<Socket>((resolve) => {
    accepted = resolve;
  });
  const server = createServer((socket) => {
    accepted(socket);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  const browser = connect(address.port, '127.0.0.1');
  const hub = await hubSide;
  sockets.push(hub, browser);
  return { hub, browser };
};

const received = (socket: Socket): (() => string) => {
  let text = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    text += chunk;
  });
  return () => text;
};

const closed = (socket: Socket): Promise<void> =>
  new Promise((resolve) => {
    if (socket.destroyed) resolve();
    else
      socket.once('close', () => {
        resolve();
      });
  });

describe('forwardToHub', () => {
  it('runs ssh -W to the remote hub port over the shared master', async () => {
    fakeSsh('exec cat');
    const { hub } = await socketPair();
    forwardToHub(paths, 'box', 7420, hub);
    await waitFor(() => fileText('args') !== '', 'the SSH program to run');
    expect(args()).toEqual([...SSH_OPTIONS(), '-W', '127.0.0.1:7420', '--', 'box']);
  });

  it('relays bytes both ways', async () => {
    fakeSsh('exec cat');
    const { hub, browser } = await socketPair();
    const text = received(browser);
    forwardToHub(paths, 'box', 7420, hub);
    browser.write('GET / HTTP/1.1\r\n\r\n');
    await waitFor(() => text() === 'GET / HTTP/1.1\r\n\r\n', 'the echoed request');
    expect(text()).toBe('GET / HTTP/1.1\r\n\r\n');
  });

  it('ends the SSH process when the browser side ends', async () => {
    fakeSsh("trap 'exit 0' TERM; cat; exit 0");
    const { hub, browser } = await socketPair();
    const forward = forwardToHub(paths, 'box', 7420, hub);
    await waitFor(() => pids().length === 1, 'the SSH process to start');
    browser.end();
    await waitFor(() => pids().every((pid) => !alive(pid)), 'the SSH process to exit');
    await expect(forward.ended).resolves.toBeNull();
  });

  it('kills an SSH process that ignores the end of its input', async () => {
    fakeSsh("trap '' TERM; exec sleep 600 < /dev/null");
    const { hub, browser } = await socketPair();
    const forward = forwardToHub(paths, 'box', 7420, hub);
    await waitFor(() => pids().length === 1, 'the SSH process to start');
    browser.destroy();
    await waitFor(() => pids().every((pid) => !alive(pid)), 'the SSH process to be killed', 10_000);
    await expect(forward.ended).resolves.toBeNull();
  });

  it('ends the browser side when SSH exits, with its last standard error line', async () => {
    fakeSsh("echo 'channel 0: open failed: administratively prohibited' >&2; exit 255");
    const { hub, browser } = await socketPair();
    const forward = forwardToHub(paths, 'box', 7420, hub);
    await expect(forward.ended).resolves.toBe('channel 0: open failed: administratively prohibited');
    await closed(browser);
    expect(browser.destroyed || browser.readableEnded).toBe(true);
  });
});
