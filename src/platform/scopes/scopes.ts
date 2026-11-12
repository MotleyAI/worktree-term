import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { access, readFile, writeFile } from 'node:fs/promises';
import { totalmem, userInfo } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

/** The slice every scope lives in. */
export const SCOPE_SLICE = 'app-wtd.slice';

/** The slice within `SCOPE_SLICE` that terminal scopes live in, capped as a whole. */
export const TERMINAL_SLICE = 'app-wtd-terminals.slice';

/** The share of physical memory all terminals together may use. */
const TERMINALS_SHARE = 2 / 3;

const PROBE_TIMEOUT_MS = 2000;
const OUTCOME_TIMEOUT_MS = 2000;
const START_TIMEOUT_MS = 2000;
const POLL_MS = 50;

/** Where the lasting-user-manager finding reads from. */
export interface ScopeRoots {
  /** This process's `/proc/<pid>/cgroup`. */
  cgroupFile: string;
  lingerDir: string;
  uid: number;
  user: string;
}

/** `noExpand`: systemd-run takes `--expand-environment=no`, without which newer ones expand `$` in a scope's command. */
export type UserManager = { lasting: true; noExpand: boolean } | { lasting: false; reason: string };

/** Memory limits of a scope, in systemd size syntax. */
export interface ScopeLimits {
  high?: string | undefined;
  max?: string | undefined;
  swapMax?: string | undefined;
}

export type Report = (error: unknown) => void;

/** The real roots of this process. */
export const hostScopeRoots = (): ScopeRoots => ({
  cgroupFile: '/proc/self/cgroup',
  lingerDir: '/var/lib/systemd/linger',
  uid: process.getuid?.() ?? -1,
  user: userInfo().username,
});

const nonEmpty = (value: string | undefined): string | undefined => (value === undefined || value === '' ? undefined : value);

const systemdRunProgram = (): string => nonEmpty(process.env['WTD_SYSTEMD_RUN']) ?? 'systemd-run';
const busctlProgram = (): string => nonEmpty(process.env['WTD_BUSCTL']) ?? 'busctl';
const systemctlProgram = (): string => nonEmpty(process.env['WTD_SYSTEMCTL']) ?? 'systemctl';

interface Ran {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Runs `file`, killing it with `SIGKILL` after `timeoutMs`; resolves once it is reaped, rejects naming a program that cannot start. */
const run = (file: string, args: readonly string[], timeoutMs: number | null = null): Promise<Ran> =>
  new Promise((resolve, reject) => {
    // The C locale keeps the messages read from it, such as getopt's `unrecognized option`, untranslated.
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LC_ALL: 'C' } });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    // A descendant may hold the pipes open, which would keep `close` from ever coming.
    const release = (): void => {
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const exited = (): boolean => child.exitCode !== null || child.signalCode !== null;
    const timer =
      timeoutMs === null
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            if (exited()) release();
            else child.kill('SIGKILL');
          }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`cannot start ${file}: ${error.message}`, { cause: error }));
    });
    child.once('exit', () => {
      if (timedOut) release();
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });

const oneLine = (text: string): string =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join(' ');

/** Why `ran` failed, in one line; null when it exited 0. */
const failure = (file: string, ran: Ran, timeoutMs = PROBE_TIMEOUT_MS): string | null => {
  if (ran.timedOut) return `${file} timed out after ${String(timeoutMs)} ms`;
  if (ran.code === 0) return null;
  const status = ran.code === null ? `was killed by ${String(ran.signal)}` : `exited ${String(ran.code)}`;
  const said = oneLine(ran.stderr);
  return said === '' ? `${file} ${status}` : `${file} ${status}: ${said}`;
};

interface Probed {
  /** Why the probe failed; null when it succeeded. */
  failure: string | null;
  timedOut: boolean;
}

/** Runs the scope probe with `extra` options after `--collect`. */
const probe = async (extra: readonly string[] = []): Promise<Probed> => {
  const file = systemdRunProgram();
  try {
    const ran = await run(
      file,
      ['--user', '--scope', '--quiet', '--collect', ...extra, `--slice=${SCOPE_SLICE}`, '--', 'true'],
      PROBE_TIMEOUT_MS,
    );
    return { failure: failure(file, ran), timedOut: ran.timedOut };
  } catch (error) {
    return { failure: oneLine(error instanceof Error ? error.message : String(error)), timedOut: false };
  }
};

/** This process's cgroup v2 path; null without one. */
export const cgroupPath = async (roots: ScopeRoots): Promise<string | null> => {
  let text: string;
  try {
    text = await readFile(roots.cgroupFile, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
  return /^0::(\/.*)$/m.exec(text)?.[1] ?? null;
};

const underUserManager = async (roots: ScopeRoots): Promise<boolean> => {
  const uid = String(roots.uid);
  return (await cgroupPath(roots))?.startsWith(`/user.slice/user-${uid}.slice/user@${uid}.service/`) ?? false;
};

const lingers = (roots: ScopeRoots): Promise<boolean> =>
  access(join(roots.lingerDir, roots.user)).then(
    () => true,
    () => false,
  );

/** Whether this process has a user manager that outlives its login session, and if not, why. */
export const findUserManager = async (roots: ScopeRoots): Promise<UserManager> => {
  const scope = await probe();
  if (scope.failure !== null) return { lasting: false, reason: scope.failure };
  if (!((await underUserManager(roots)) || (await lingers(roots))))
    return { lasting: false, reason: 'not under the user manager and not lingering' };
  // Only systemd-run rejecting the option shows it unsupported; any other failure is inconclusive, and
  // without the option arguments may be expanded.
  const option = await probe(['--expand-environment=no']);
  if (option.failure === null) return { lasting: true, noExpand: true };
  if (!option.timedOut && option.failure.includes('unrecognized option')) return { lasting: true, noExpand: false };
  return { lasting: false, reason: option.failure };
};

const OOM_SCORE_ADJ_MIN = -1000;

const errorCode = (error: unknown): unknown => (error instanceof Error && 'code' in error ? error.code : undefined);

/** Writes `value` to `file`; false when the kernel refuses it as below this process's floor. */
const permitted = async (file: string, value: number): Promise<boolean> => {
  try {
    await writeFile(file, String(value));
    return true;
  } catch (error) {
    if (errorCode(error) === 'EACCES') return false;
    throw error;
  }
};

/** Lowers this process's `oom_score_adj` in `file` to the lowest value the kernel permits it; without the file, does nothing. */
export const lowerOomScoreAdj = async (file = '/proc/self/oom_score_adj'): Promise<void> => {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    throw error;
  }
  // `high` is always permitted; the floor lies in (low, high].
  let high = Number(text.trim());
  let low = OOM_SCORE_ADJ_MIN - 1;
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    const accepted = await permitted(file, mid); // NOSONAR(S9382) — each write narrows the search
    if (accepted) high = mid;
    else low = mid;
  }
};

/** The prefix of every unit name of the state directory `stateDir`. */
export const unitPrefix = (stateDir: string): string => `wtd-${createHash('sha256').update(stateDir).digest('hex').slice(0, 8)}-`;

const randomSuffix = (): string => randomBytes(4).toString('hex');

export const daemonUnit = (stateDir: string): string => `${unitPrefix(stateDir)}daemon-${randomSuffix()}.scope`;
export const hubUnit = (stateDir: string): string => `${unitPrefix(stateDir)}hub-${randomSuffix()}.scope`;
export const terminalUnit = (stateDir: string, instance: string, termId: number): string =>
  `${unitPrefix(stateDir)}term-${instance}-${String(termId)}.scope`;

const PROPERTIES: readonly (readonly [keyof ScopeLimits, string])[] = [
  ['high', 'MemoryHigh'],
  ['max', 'MemoryMax'],
  ['swapMax', 'MemorySwapMax'],
];

/** `command` started through systemd-run in the scope `unit`, keeping its pid, environment and, with `noExpand`, arguments. */
export const scopeCommand = (unit: string, limits: ScopeLimits, command: readonly string[], noExpand: boolean): string[] => [
  systemdRunProgram(),
  '--user',
  '--scope',
  '--quiet',
  `--unit=${unit}`,
  `--slice=${TERMINAL_SLICE}`,
  '-p',
  'OOMPolicy=kill',
  ...(noExpand ? ['--expand-environment=no'] : []),
  ...PROPERTIES.flatMap(([key, property]) => {
    const value = limits[key];
    return value === undefined ? [] : ['-p', `${property}=${value}`];
  }),
  '--',
  ...command,
];

/** Runs systemctl with `args`, rejecting when it cannot start, exits non-zero or outlasts 2 s. */
const systemctl = async (args: readonly string[]): Promise<string> => {
  const file = systemctlProgram();
  const ran = await run(file, ['--user', ...args], OUTCOME_TIMEOUT_MS);
  const failed = failure(file, ran, OUTCOME_TIMEOUT_MS);
  if (failed !== null) throw new Error(failed);
  return ran.stdout;
};

/** The `key=value` properties systemctl `show` printed. */
const properties = (text: string): Map<string, string> =>
  new Map(
    text
      .split('\n')
      .filter((line) => line.includes('='))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)] as const),
  );

interface UnitState {
  active: string;
  result: string;
}

const unitState = async (unit: string): Promise<UnitState> => {
  const shown = properties(await systemctl(['show', unit, '-p', 'ActiveState', '-p', 'Result']));
  const active = shown.get('ActiveState');
  const result = shown.get('Result');
  if (active === undefined || result === undefined) throw new Error(`systemctl show ${unit}: no ActiveState and Result`);
  return { active, result };
};

/** Moves the running process `pid` into the new scope `unit`, resolving once the scope is active. */
export const enterScope = async (unit: string, pid: number): Promise<void> => {
  const file = busctlProgram();
  const args = [
    '--user',
    'call',
    'org.freedesktop.systemd1',
    '/org/freedesktop/systemd1',
    'org.freedesktop.systemd1.Manager',
    'StartTransientUnit',
    'ssa(sv)a(sa(sv))',
    unit,
    'fail',
    '2',
    'PIDs',
    'au',
    '1',
    String(pid),
    'Slice',
    's',
    SCOPE_SLICE,
    '0',
  ];
  const failed = failure(file, await run(file, args, START_TIMEOUT_MS), START_TIMEOUT_MS);
  if (failed !== null) throw new Error(failed);
  const deadline = Date.now() + START_TIMEOUT_MS;
  for (;;) {
    const { active } = await unitState(unit);
    if (active === 'active') return;
    if (active === 'failed' || Date.now() >= deadline) throw new Error(`${unit} did not start: ${active}`);
    await sleep(POLL_MS); // NOSONAR(S9382) — sequential polling
  }
};

/** Whether the scope `unit`, once ended, was killed for lack of memory; resets it when failed. */
export const outOfMemory = async (unit: string, report: Report): Promise<boolean> => {
  const deadline = Date.now() + OUTCOME_TIMEOUT_MS;
  for (;;) {
    let state: UnitState;
    try {
      state = await unitState(unit);
    } catch (error) {
      report(error);
      return false;
    }
    if (state.active === 'inactive' || state.active === 'failed') {
      if (state.active === 'failed') await systemctl(['reset-failed', unit]).catch(report);
      return state.result === 'oom-kill';
    }
    if (Date.now() >= deadline) return false;
    await sleep(POLL_MS); // NOSONAR(S9382) — sequential polling
  }
};

const MiB = 1024 * 1024;

/** The `MemoryMax` of the terminal slice for `total` bytes of physical memory, in whole MiB as the kernel keeps whole pages. */
export const terminalSliceMax = (total = totalmem()): number => Math.floor((total * TERMINALS_SHARE) / MiB) * MiB;

/** Caps the terminal slice at `max` bytes until the user manager stops, so terminals cannot starve the rest of the session. */
export const capTerminalSlice = async (max: number): Promise<void> => {
  await systemctl(['set-property', '--runtime', TERMINAL_SLICE, `MemoryMax=${String(max)}`]);
};

/** Resets every failed unit whose name begins with `prefix`. */
export const resetFailedScopes = async (prefix: string, report: Report): Promise<void> => {
  await systemctl(['reset-failed', `${prefix}*`]).catch(report);
};
