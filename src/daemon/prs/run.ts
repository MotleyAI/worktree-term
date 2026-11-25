import { spawn } from 'node:child_process';

/** Most bytes of stdout plus stderr a child may print. */
const MAX_OUTPUT = 32 * 1024 * 1024;

export interface RunOptions {
  cwd: string;
  timeoutMs: number;
  /** Written to the child's stdin, which is then closed. */
  input?: string;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

export type RunOutcome =
  | { kind: 'exit'; code: number; stdout: string; stderr: string }
  /** The command is not on PATH. */
  | { kind: 'missing' }
  /** The command could not be started for another reason. */
  | { kind: 'error'; message: string }
  | { kind: 'timeout' }
  | { kind: 'aborted' }
  | { kind: 'overflow' };

export type Runner = (command: string, args: readonly string[], options: RunOptions) => Promise<RunOutcome>;

/**
 * Runs `command`, killing it on timeout, abort or too much output; settles only once the child ended.
 * A killed child settles on its exit, not on its pipes closing, which a descendant may hold open.
 */
export const runBounded: Runner = (command, args, { cwd, timeoutMs, input, signal, env }) =>
  new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve({ kind: 'aborted' });
      return;
    }
    const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let exited = false;
    let killedFor: 'timeout' | 'aborted' | 'overflow' | null = null;
    const release = (reason: NonNullable<typeof killedFor>): void => {
      child.stdout.destroy();
      child.stderr.destroy();
      settle({ kind: reason });
    };
    const kill = (reason: NonNullable<typeof killedFor>): void => {
      if (killedFor !== null) return;
      killedFor = reason;
      if (exited) release(reason);
      else child.kill('SIGKILL');
    };
    const collect =
      (into: Buffer[]) =>
      (chunk: Buffer): void => {
        size += chunk.length;
        if (size > MAX_OUTPUT) kill('overflow');
        else into.push(chunk);
      };
    const onAbort = (): void => {
      kill('aborted');
    };
    const timer = setTimeout(() => {
      kill('timeout');
    }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    const settle = (outcome: RunOutcome): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(outcome);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    // A child exiting before it read its input breaks the pipe; its exit says what happened.
    child.stdin.on('error', () => undefined);
    child.stdin.end(input ?? '');
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (child.pid !== undefined) return;
      settle(error.code === 'ENOENT' ? { kind: 'missing' } : { kind: 'error', message: error.message });
    });
    child.on('exit', () => {
      exited = true;
      if (killedFor !== null) release(killedFor);
    });
    child.on('close', (code) => {
      if (child.pid === undefined || killedFor !== null) return;
      settle({
          kind: 'exit',
          code: code ?? -1,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        });
    });
  });
