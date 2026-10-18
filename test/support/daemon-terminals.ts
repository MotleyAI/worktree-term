import { join } from 'node:path';
import { afterEach, beforeEach } from 'vitest';
import type { Terminal } from '../../src/protocol/index.js';
import type { DaemonClient } from './daemon-client.js';
import { addWorktree, DaemonHost, makeRepo, sleep, type WtdProcess } from './daemon-host.js';

export let host: DaemonHost;
export let daemon: WtdProcess;
export let repo: string;
export let wt: string;
export let a: DaemonClient;
export let b: DaemonClient;

/** Registers the per-test setup and cleanup. */
export const useDaemonTerminalsHost = (): void => {
  beforeEach(async () => {
    host = DaemonHost.create();
    repo = makeRepo(join(host.dir, 'repo'));
    wt = addWorktree(repo, join(host.dir, 'wt'), 'wt');
    daemon = await host.start();
    a = await host.client();
    b = await host.client();
    await a.watch(repo);
    await b.watch(repo);
  });

  afterEach(async () => {
    await host.cleanup();
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
  { worktree = wt, cols = 80, rows = 24 }: { worktree?: string; cols?: number; rows?: number } = {},
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
  a.send({ t: 'shutdown' });
  await daemon.exited;
  daemon = await host.start(env);
  a = await host.client();
  b = await host.client();
  await a.watch(repo);
  await b.watch(repo);
};
