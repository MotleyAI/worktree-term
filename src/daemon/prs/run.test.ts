import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { alive, waitUntil } from '../../../test/support/daemon-host.js';
import { runBounded } from './run.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wtd-run-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Shell code that records its pid in `pid` and then sleeps for a minute in that same process. */
const recordPidAndSleep = (pidFile: string): string => `echo $$ > '${pidFile}'; exec sleep 60`;

const pidIn = async (pidFile: string): Promise<number> =>
  waitUntil(() => {
    try {
      const pid = Number(readFileSync(pidFile, 'utf8'));
      return pid > 0 ? pid : undefined;
    } catch {
      return undefined;
    }
  }, 'the child to record its pid');

describe('runBounded', () => {
  it('yields the exit code, stdout and stderr', async () => {
    expect(await runBounded('sh', ['-c', 'echo out; echo err >&2; exit 3'], { cwd: dir, timeoutMs: 5000 })).toEqual({
      kind: 'exit',
      code: 3,
      stdout: 'out\n',
      stderr: 'err\n',
    });
  });

  it('runs in cwd and passes input on stdin', async () => {
    expect(await runBounded('sh', ['-c', 'pwd; cat'], { cwd: dir, timeoutMs: 5000, input: '{"query":"q"}' })).toMatchObject({
      kind: 'exit',
      code: 0,
      stdout: `${dir}\n{"query":"q"}`,
    });
  });

  it('yields missing for a command that is not on PATH', async () => {
    expect(await runBounded('wtd-no-such-command', [], { cwd: dir, timeoutMs: 5000 })).toEqual({ kind: 'missing' });
  });

  it('kills a child that overruns its timeout', async () => {
    const pidFile = join(dir, 'pid');
    const started = Date.now();
    const outcome = runBounded('sh', ['-c', recordPidAndSleep(pidFile)], { cwd: dir, timeoutMs: 300 });
    const pid = await pidIn(pidFile);
    expect(await outcome).toEqual({ kind: 'timeout' });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(alive(pid)).toBe(false);
  });

  it('kills a child when aborted and settles only after it ended', async () => {
    const pidFile = join(dir, 'pid');
    const abort = new AbortController();
    const outcome = runBounded('sh', ['-c', recordPidAndSleep(pidFile)], { cwd: dir, timeoutMs: 60_000, signal: abort.signal });
    const pid = await pidIn(pidFile);
    abort.abort();
    expect(await outcome).toEqual({ kind: 'aborted' });
    expect(alive(pid)).toBe(false);
  });

  it.each([
    ['is killed', `echo $$ > '{pid}'; sleep 60 & echo $! > '{grand}'; wait`],
    ['exited', `echo $$ > '{pid}'; sleep 60 & echo $! > '{grand}'; exit 0`],
  ])('settles on timeout while a descendant holds its output open after the child %s', async (_name, script) => {
    const [pidFile, grandFile] = [join(dir, 'pid'), join(dir, 'grand')];
    const started = Date.now();
    const outcome = runBounded('sh', ['-c', script.replace('{pid}', pidFile).replace('{grand}', grandFile)], { cwd: dir, timeoutMs: 300 });
    const pid = await pidIn(pidFile);
    const grandchild = await pidIn(grandFile);
    try {
      expect(await outcome).toEqual({ kind: 'timeout' });
      expect(Date.now() - started).toBeLessThan(5000);
      expect(alive(pid)).toBe(false);
    } finally {
      process.kill(grandchild, 'SIGKILL');
    }
  });

  it('kills a child whose output exceeds the cap', async () => {
    expect(await runBounded('yes', [], { cwd: dir, timeoutMs: 30_000 })).toEqual({ kind: 'overflow' });
  });
});
