import { randomBytes } from 'node:crypto';
import type { HostPaths } from '../../platform/files/index.js';
import { AlreadyRunningError, bindSocket, Daemon } from '../server/index.js';
import { StateStore } from '../state/index.js';
import { TerminalProcess } from '../terminals/index.js';
import { discoverRepos, listWorktrees, watchWorktrees } from '../worktrees/index.js';

export { AlreadyRunningError };

export interface DaemonRun {
  /** The package version announced in `hello`. */
  version: string;
  paths: HostPaths;
  /** Environment of terminal processes. */
  env: Readonly<Record<string, string | undefined>>;
}

const STOP_SIGNALS = ['SIGTERM', 'SIGINT'] as const;

const ignore = (): void => undefined;

/**
 * Runs this host's daemon until `shutdown`, SIGTERM or SIGINT; rejects with AlreadyRunningError
 * when another daemon serves the socket.
 */
export const runDaemon = async ({ version, paths, env }: DaemonRun): Promise<void> => {
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
      const daemon = new Daemon({
        services: { watchWorktrees, listWorktrees, discoverRepos, spawnTerminal: (spec, events) => TerminalProcess.spawn(spec, events) },
        version,
        instance: randomBytes(12).toString('base64url'),
        store,
        env,
        shutdown: stop,
        report,
      });
      listener.serve((socket) => {
        daemon.accept(socket);
      });
      await stopped;
      await daemon.shutdown();
    } finally {
      await listener.close();
    }
  } finally {
    process.off('SIGHUP', ignore);
    for (const signal of STOP_SIGNALS) process.off(signal, stop);
  }
};
