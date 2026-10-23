import { join } from 'node:path';
import { afterEach, beforeEach } from 'vitest';
import type { Terminal } from '../../src/protocol/index.js';
import type { DaemonClient } from './daemon-client.js';
import { addWorktree, DaemonHost, makeRepo, sleep, type WtdProcess } from './daemon-host.js';

/** Per-test values, refilled by the `beforeEach` that `useDaemonTerminalsHost` registers. */
class DaemonTerminalsFixture {
  host!: DaemonHost;
  daemon!: WtdProcess;
  repo!: string;
  wt!: string;
  a!: DaemonClient;
  b!: DaemonClient;
}

export const fx = new DaemonTerminalsFixture();

/** Registers the per-test setup and cleanup. */
export const useDaemonTerminalsHost = (): void => {
  beforeEach(async () => {
    fx.host = DaemonHost.create();
    fx.repo = makeRepo(join(fx.host.dir, 'repo'));
    fx.wt = addWorktree(fx.repo, join(fx.host.dir, 'wt'), 'wt');
    fx.daemon = await fx.host.start();
    fx.a = await fx.host.client();
    fx.b = await fx.host.client();
    await fx.a.watch(fx.repo);
    await fx.b.watch(fx.repo);
  });

  afterEach(async () => {
    await fx.host.cleanup();
  });
};

export const KiB = 1024;
export const MiB = 1024 * KiB;

/**
 * Creates a terminal in `worktree` and attaches `client` to it. A command runs only once attached,
 * so all its output follows the snapshot; an interactive shell is waited for until it has run a
 * command and printed its prompt, so login start-up output is over.
 */
export const started = async (
  client: DaemonClient,
  command: string | null,
  { worktree = fx.wt, cols = 80, rows = 24 }: { worktree?: string; cols?: number; rows?: number } = {},
): Promise<Terminal> => {
  const term = await client.create(worktree, { command: command === null ? null : `read -r _; ${command}`, cols, rows });
  await client.attach(term.termId);
  if (command === null) {
    client.sendInput(term.termId, 'echo READY-$((6*7))\r');
    await client.waitOutput(term.termId, 'READY-42\r\n', 10_000);
    await sleep(300);
  } else {
    client.sendInput(term.termId, '\r');
  }
  return term;
};

/** Restarts the daemon with extra environment, re-watching from fresh clients. */
export const restart = async (env: Record<string, string | undefined> = {}): Promise<void> => {
  fx.a.send({ t: 'shutdown' });
  await fx.daemon.exited;
  fx.daemon = await fx.host.start(env);
  fx.a = await fx.host.client();
  fx.b = await fx.host.client();
  await fx.a.watch(fx.repo);
  await fx.b.watch(fx.repo);
};
