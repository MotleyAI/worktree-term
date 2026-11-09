import { randomBytes } from 'node:crypto';
import { UNIT_NAME, type HostPaths } from '../../platform/files/index.js';
import {
  hostRoots,
  logWriter,
  memoryTight,
  processLookup,
  readMemory,
  readProcessCgroup,
  sampleIntervalMs,
  selfMemory,
  startSampler,
  type MemorySampler,
} from '../../platform/memory/index.js';
import {
  cgroupPath,
  daemonUnit,
  enterScope,
  findUserManager,
  hostScopeRoots,
  outOfMemory,
  resetFailedScopes,
  scopeCommand,
  terminalUnit,
  unitPrefix,
  type UserManager,
} from '../../platform/scopes/index.js';
import { bindSocket, Daemon } from '../server/index.js';
import { StateStore } from '../state/index.js';
import { TerminalProcess, type TerminalLauncher } from '../terminals/index.js';
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

type Report = (error: unknown) => void;

/** Terminal `termId`'s scope unit; null without terminal scopes. */
type UnitOf = ((termId: number) => string) | null;

/**
 * Moves the daemon into a scope of its own unless it runs as its systemd unit; whether terminals get
 * scopes of their own, said on standard error.
 */
const placeDaemon = async (paths: HostPaths, report: Report): Promise<UserManager> => {
  const roots = hostScopeRoots();
  const found = await findUserManager(roots);
  if (found.lasting) {
    if (!((await cgroupPath(roots))?.endsWith(`/${UNIT_NAME}`) ?? false)) {
      await enterScope(daemonUnit(paths.stateDir), process.pid).catch(report);
    }
    await resetFailedScopes(`${unitPrefix(paths.stateDir)}term-`, report);
  }
  console.error(found.lasting ? 'terminal scopes: on' : `terminal scopes: off (${found.reason})`);
  return found;
};

/** Starts terminals in their scopes when `unitOf` is given, else as they are, saying once that limits are ignored. */
const terminalLauncher = (
  unitOf: UnitOf,
  systemdRunVersion: number | null,
  oomKilled: (termId: number, unit: string) => void,
  report: Report,
): TerminalLauncher => {
  if (unitOf === null) {
    let warned = false;
    return {
      command: (_termId, memory, shell, args) => {
        if (!warned && Object.values(memory).some((v) => v !== undefined)) {
          warned = true;
          console.error('memory limits ignored: terminal scopes are off');
        }
        return [shell, ...args];
      },
      outOfMemory: () => Promise.resolve(false),
    };
  }
  return {
    command: (termId, memory, shell, args) => scopeCommand(unitOf(termId), memory, [shell, ...args], systemdRunVersion),
    outOfMemory: async (termId) => {
      const unit = unitOf(termId);
      const oom = await outOfMemory(unit, report);
      if (oom) oomKilled(termId, unit);
      return oom;
    },
  };
};

/** Samples the daemon's memory into `memory.log` until stopped. */
const sampleMemory = (
  daemon: Daemon,
  { version, paths, env }: DaemonRun,
  instance: string,
  unitOf: UnitOf,
  report: Report,
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
      const { record, gone } = await daemonRecord({
        ts,
        pid: process.pid,
        instance,
        version,
        intervalMs,
        self,
        view,
        ...reading,
        lookup,
        terminalUnit: unitOf,
        processCgroup: (pid) => readProcessCgroup(roots, pid, report),
      });
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
    const placed: { manager: UserManager } = { manager: { lasting: false, reason: 'not placed' } };
    const listener = await bindSocket(paths, async () => {
      placed.manager = await placeDaemon(paths, report);
    });
    try {
      const store = await StateStore.load(paths.state);
      const instance = randomBytes(12).toString('base64url');
      const { manager } = placed;
      const unitOf: UnitOf = manager.lasting ? (termId) => terminalUnit(paths.stateDir, instance, termId) : null;
      const writeMemoryLog = logWriter(paths.memoryLog, report);
      const oomKilled = (termId: number, unit: string): void => {
        const term = daemon.memoryView().terminals.find((t) => t.termId === termId);
        if (term === undefined) return;
        const { repo, worktree, preset } = term;
        const line = {
          ts: new Date().toISOString(),
          source: 'daemon',
          event: 'oom-kill',
          pid: process.pid,
          instance,
          termId,
          repo,
          worktree,
          preset,
          unit,
        };
        writeMemoryLog(JSON.stringify(line)).catch(report);
      };
      const launcher = terminalLauncher(unitOf, manager.lasting ? manager.version : null, oomKilled, report);
      const daemon = new Daemon({
        services: {
          watchWorktrees,
          listWorktrees,
          discoverRepos,
          worktreeRisks,
          removeWorktree,
          spawnTerminal: (spec, events) => TerminalProcess.spawn(spec, events, launcher),
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
      const sampler = sampleMemory(daemon, run, instance, unitOf, report);
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
