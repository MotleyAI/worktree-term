import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hostPaths } from '../../platform/files/index.js';
import { encodeFrame, FrameKind, type Frame } from '../../protocol/index.js';
import { RemoteDaemon, type Link } from './index.js';

let dir: string;
let paths: ReturnType<typeof hostPaths>;
let pidFiles: string[];

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'wtd-remote-')));
  paths = hostPaths({ env: { XDG_STATE_HOME: join(dir, 's') }, home: '/nonexistent', host: 'local' });
  pidFiles = [];
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const file of pidFiles) {
    if (!existsSync(file)) continue;
    for (const pid of readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
      try {
        process.kill(Number(pid), 'SIGKILL');
      } catch {
        // Already gone.
      }
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
  pidFiles.push(join(dir, 'pids'), join(dir, 'children'));
  vi.stubEnv('WTD_SSH', program);
};

const fileText = (name: string): string => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : '');

interface Opened {
  link: Link;
  frames: Frame[];
  ended: Promise<Error | null>;
  endedAt: () => number | null;
}

const open = (alias = 'box'): Opened => {
  const frames: Frame[] = [];
  let at: number | null = null;
  let resolveEnded: (error: Error | null) => void = () => undefined;
  const ended = new Promise<Error | null>((resolve) => {
    resolveEnded = resolve;
  });
  const link = new RemoteDaemon(paths, alias).open({
    frame: (frame) => frames.push(frame),
    ended: (error) => {
      at = Date.now();
      resolveEnded(error);
    },
  });
  return { link, frames, ended, endedAt: () => at };
};

const controlFrame = (text: string): Uint8Array => encodeFrame({ kind: FrameKind.control, payload: new TextEncoder().encode(text) });

const waitFor = async (probe: () => boolean, what: string, timeout = 5000): Promise<void> => {
  const deadline = Date.now() + timeout;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
};

describe('RemoteDaemon', () => {
  it('runs the SSH command for the alias with the connect command', async () => {
    fakeSsh('exec cat');
    const { link } = open('box');
    await waitFor(() => fileText('args') !== '', 'the SSH program to run');
    expect(fileText('args').split('\0').slice(0, -1)).toEqual([
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
      '--',
      'box',
      '"$HOME/.local/bin/wtd" connect',
    ]);
    link.close();
  });

  it('exchanges stream frames over the process’s standard input and output', async () => {
    fakeSsh('exec cat');
    const { link, frames } = open();
    link.send(controlFrame('{"t":"shutdown"}'));
    link.send(controlFrame('{"t":"ack","termId":1,"offset":0}'));
    await waitFor(() => frames.length === 2, 'two frames back');
    expect(frames.map((f) => new TextDecoder().decode(f.payload))).toEqual(['{"t":"shutdown"}', '{"t":"ack","termId":1,"offset":0}']);
    link.close();
  });

  it('ends with the last standard error line as the cause when SSH fails', async () => {
    fakeSsh(`echo 'Warning: something' >&2; echo 'ssh: Could not resolve hostname box: Name or service not known' >&2; exit 255`);
    const error = await open().ended;
    expect(error?.message).toBe('ssh: Could not resolve hostname box: Name or service not known');
  });

  it('ends with the exit status as the cause when SSH wrote nothing to standard error', async () => {
    fakeSsh('exit 3');
    const error = await open().ended;
    expect(error?.message).toMatch(/\b3\b/);
  });

  it('ends with a cause of at most 1024 characters after 8 MiB of standard error without a newline', async () => {
    fakeSsh(`head -c 8388608 /dev/zero | tr '\\000' x >&2; exit 255`);
    const error = await open().ended;
    expect(error?.message).toMatch(/^x+$/);
    expect(error?.message.length).toBeLessThanOrEqual(1024);
  });

  it('ends when the process exits although a child keeps its standard error open', async () => {
    fakeSsh(`sleep 30 </dev/null >/dev/null & echo $! >> "$D/children"\nsleep 0.2; exit 255`);
    const { ended } = open();
    const started = Date.now();
    await ended;
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('ends when the process closes its standard output, even while it keeps running', async () => {
    fakeSsh('exec >&-; exec sleep 30');
    const { ended } = open();
    const started = Date.now();
    await ended;
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('ends with an error on a malformed stream', async () => {
    fakeSsh(`printf '\\377\\377\\377\\377\\377\\377\\377\\377'; exec sleep 30`);
    const error = await open().ended;
    expect(error).toBeInstanceOf(Error);
  });

  it('closes by ending standard input, without signalling a process that then exits', async () => {
    fakeSsh(`trap 'echo term >> "$D/signals"; exit 0' TERM\ncat >/dev/null\necho eof >> "$D/signals"`);
    const { link, endedAt } = open();
    await waitFor(() => fileText('pids') !== '', 'the SSH program to run');
    link.close();
    await waitFor(() => fileText('signals').includes('eof'), 'standard input to end');
    await sleep(1500);
    expect(fileText('signals')).toBe('eof\n');
    expect(endedAt()).toBeNull();
  });

  it('terminates a process that has not exited 1 s after its standard input ended', async () => {
    fakeSsh(`trap 'echo term >> "$D/signals"; exit 0' TERM\nwhile :; do sleep 0.05; done`);
    const { link } = open();
    await waitFor(() => fileText('pids') !== '', 'the SSH program to run');
    const closedAt = Date.now();
    link.close();
    await sleep(700);
    expect(fileText('signals')).toBe('');
    await waitFor(() => fileText('signals').includes('term'), 'SIGTERM', 3000);
    expect(Date.now() - closedAt).toBeGreaterThanOrEqual(900);
  });

  it('signals no other process when closing', async () => {
    fakeSsh(`sleep 30 </dev/null >/dev/null 2>&1 & echo $! >> "$D/children"\ntrap 'exit 0' TERM\nwhile :; do sleep 0.05; done`);
    const { link } = open();
    await waitFor(() => fileText('children') !== '', 'the child to start');
    const ssh = Number(fileText('pids').trim());
    const child = Number(fileText('children').trim());
    link.close();
    await waitFor(
      () => {
        try {
          process.kill(ssh, 0);
          return false;
        } catch {
          return true;
        }
      },
      'the SSH process to exit',
      3000,
    );
    expect(() => process.kill(child, 0)).not.toThrow();
  });

  it('does not report the end of a link it closed', async () => {
    fakeSsh('exec cat');
    const { link, endedAt } = open();
    await waitFor(() => fileText('pids') !== '', 'the SSH program to run');
    link.close();
    await sleep(1500);
    expect(endedAt()).toBeNull();
  });
});
