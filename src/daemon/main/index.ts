import { randomBytes } from 'node:crypto';
import type { HostPaths } from '../../platform/files/index.js';
import {
  hostRoots,
  logWriter,
  memoryTight,
  processLookup,
  readMemory,
  sampleIntervalMs,
  selfMemory,
  startSampler,
  type MemorySampler,
} from '../../platform/memory/index.js';
import { bindSocket, Daemon } from '../server/index.js';
import { StateStore } from '../state/index.js';
import { TerminalProcess } from '../terminals/index.js';
import { discoverRepos, listWorktrees, removeWorktree, watchWorktrees, worktreeRisks } from '../worktrees/index.js';
import { daemonRecord } from './memory.js';

export { AlreadyRunningError } from '../server/index.js';

export interface DaemonRun {
  /** The package version announced in `hello`. */
  version: string;
  paths: HostPaths;
  /** Environment of terminal processes; read for `WTD_MEMORY_SAMPLE_MS`, the memory log's base interval. */
  env: Readonly<Record<string, string | undefined>>;
}

const STOP_SIGNALS = ['SIGTERM', 'SIGINT'] as const;

const ignore = (): void => undefined;

/** Samples the daemon's memory into `memory.log` until stopped. */
const sampleMemory = (
  daemon: Daemon,
  { version, paths, env }: DaemonRun,
  instance: string,
  report: (error: unknown) => void,
): MemorySampler => {
  const roots = hostRoots();
  const lookup = processLookup(roots);
  const intervalMs = sampleIntervalMs(env['WTD_MEMORY_SAMPLE_MS']);
  return startSampler({
    intervalMs,
    tight: () => memoryTight(roots, report),
    take: async () => {
      const ts = new Date().toISOString();
      const self = selfMemory();
      const view = daemon.memoryView();
      const reading = await readMemory(roots, report);
      const { record, gone } = await daemonRecord({ ts, pid: process.pid, instance, version, intervalMs, self, view, ...reading, lookup });
      daemon.forgetClosed(gone);
      return record;
    },
    write: logWriter(paths.memoryLog, report),
    report,
  });
};

/**
 * Runs this host's daemon until `shutdown`, SIGTERM or SIGINT; rejects with AlreadyRunningError
 * when another daemon serves the socket.
 */
export const runDaemon = async (run: DaemonRun): Promise<void> => {
  const { version, paths, env } = run;
  let stop = (): void => undefined;
  const stopped = new Promise<void>((resolve) => {
    stop = resolve;
  });
  const report = (error: unknown): void => {
    console.error(error);
  };
  // Installed before the socket accepts anyone, so a signal never finds the default handlers.
  process.on('SIGHUP', ignore);
  for (const signal of STOP_SIGNALS) process.on(signal, stop);
  try {
    const listener = await bindSocket(paths);
    try {
      const store = await StateStore.load(paths.state);
      const instance = randomBytes(12).toString('base64url');
      const daemon = new Daemon({
        services: {
          watchWorktrees,
          listWorktrees,
          discoverRepos,
          worktreeRisks,
          removeWorktree,
          spawnTerminal: (spec, events) => TerminalProcess.spawn(spec, events),
        },
        version,
        instance,
        store,
        env,
        shutdown: stop,
        report,
      });
      listener.serve((socket) => {
        daemon.accept(socket);
      });
      const sampler = sampleMemory(daemon, run, instance, report);
      await stopped;
      sampler.stop();
      await daemon.shutdown();
    } finally {
      await listener.close();
    }
  } finally {
    process.off('SIGHUP', ignore);
    for (const signal of STOP_SIGNALS) process.off(signal, stop);
  }
};
