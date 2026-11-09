import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';

/** The slice every scope lives in. */
export const SLICE = 'app-wtd.slice';

export const SKIP_REASON = 'skipped: no lasting systemd user manager';

/** Bash that allocates 300 MiB in the shell itself. */
export const HOG = String.raw`s=$(head -c 314572800 /dev/zero | tr '\0' x); echo SURVIVED`;

/** Limits whose terminal the hog drives out of memory, without swapping. */
export const SMALL = { max: '64M', swapMax: '0' } as const;

/** The variables that reach this user's systemd user manager, as a desktop session has them. */
export const userManagerEnv = (): Record<string, string | undefined> => ({
  XDG_RUNTIME_DIR: process.env['XDG_RUNTIME_DIR'],
  DBUS_SESSION_BUS_ADDRESS: process.env['DBUS_SESSION_BUS_ADDRESS'],
});

/** The `0::` cgroup path of `pid`. */
export const cgroupOf = (pid: number | 'self'): string => {
  const path = /^0::(\/.*)$/m.exec(readFileSync(`/proc/${String(pid)}/cgroup`, 'utf8'))?.[1];
  if (path === undefined) throw new Error(`no cgroup v2 line for ${String(pid)}`);
  return path;
};

const uid = (): number => process.getuid?.() ?? -1;

/** Why this process finds no lasting user manager, or null when it does. */
const missingUserManager = (): string | null => {
  // prettier-ignore
  const probe = spawnSync('systemd-run', ['--user', '--scope', '--quiet', '--collect', `--slice=${SLICE}`, '--', 'true'], { // NOSONAR(S4036) — the host's own systemd-run, as the product uses
    encoding: 'utf8',
    timeout: 2000,
  });
  if (probe.error !== undefined) return `systemd-run: ${probe.error.message}`;
  if (probe.status !== 0) return `systemd-run exited ${String(probe.status)}: ${probe.stderr.trim()}`;
  const managed = `/user.slice/user-${String(uid())}.slice/user@${String(uid())}.service/`;
  if (existsSync('/proc/self/cgroup') && cgroupOf('self').startsWith(managed)) return null;
  return existsSync(join('/var/lib/systemd/linger', userInfo().username)) ? null : 'not under the user manager and not lingering';
};

/** Why scope tests cannot run here; null when a lasting user manager is reachable. */
export const NO_USER_MANAGER: string | null = missingUserManager();

/** `name`, saying why it is skipped when no lasting user manager is reachable. */
export const withUserManager = (name: string): string => {
  if (NO_USER_MANAGER === null) return name;
  console.warn(`${name}: ${SKIP_REASON} (${NO_USER_MANAGER})`);
  return `${name} (${SKIP_REASON})`;
};

/** The 8 hex digits unit names of the state directory `stateDir` carry. */
export const stateHash = (stateDir: string): string => createHash('sha256').update(stateDir).digest('hex').slice(0, 8);

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

/** The cgroup path of a scope of `kind` under the slice, for the state directory `stateDir`. */
export const scopePath = (stateDir: string, kind: 'daemon' | 'hub'): RegExp =>
  new RegExp(String.raw`/${escape(SLICE)}/wtd-${stateHash(stateDir)}-${kind}-[0-9a-f]{8}\.scope$`);

/** The unit name of terminal `termId` of daemon instance `instance`. */
export const terminalUnit = (stateDir: string, instance: string, termId: number): string =>
  `wtd-${stateHash(stateDir)}-term-${instance}-${String(termId)}.scope`;

/** A file of the cgroup at `path`, trimmed. */
export const cgroupFile = (path: string, name: string): string => readFileSync(`/sys/fs/cgroup${path}/${name}`, 'utf8').trim();

/** The `ActiveState`, `Result` and `LoadState` of a user unit. */
export const unitState = (unit: string): Record<string, string> => {
  // prettier-ignore
  const shown = spawnSync('systemctl', ['--user', 'show', unit, '-p', 'ActiveState', '-p', 'Result', '-p', 'LoadState'], { // NOSONAR(S4036) — the host's own systemctl, as the product uses
    encoding: 'utf8',
  });
  return Object.fromEntries(
    shown.stdout
      .split('\n')
      .filter((line) => line.includes('='))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );
};

export const isFailed = (unit: string): boolean => unitState(unit)['ActiveState'] === 'failed';

export const resetFailed = (unit: string): void => {
  spawnSync('systemctl', ['--user', 'reset-failed', unit], { stdio: 'ignore' }); // NOSONAR(S4036) — the host's own systemctl, as the product uses
};

/** Leaves `unit` failed, its process killed for lack of memory. */
export const failUnit = (unit: string): void => {
  spawnSync(
    'systemd-run', // NOSONAR(S4036) — the host's own systemd-run, as the product uses
    [
      '--user',
      '--scope',
      '--quiet',
      `--unit=${unit}`,
      `--slice=${SLICE}`,
      '-p',
      'OOMPolicy=kill',
      '-p',
      'MemoryMax=32M',
      '-p',
      'MemorySwapMax=0',
      '--',
      'bash',
      '-c',
      HOG,
    ],
    { stdio: 'ignore' },
  );
  if (!isFailed(unit)) throw new Error(`${unit} did not fail: ${JSON.stringify(unitState(unit))}`);
};

/** A stand-in program at `path` that appends its arguments, one call per line, to `<path>.calls`, then runs `body`. */
export const fakeProgram = (path: string, body: string): { program: string; calls: () => string[][] } => {
  const log = `${path}.calls`;
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\0' "$@" >> '${log}'\nprintf '\\n' >> '${log}'\n${body}\n`);
  chmodSync(path, 0o755);
  return {
    program: path,
    calls: () =>
      existsSync(log)
        ? readFileSync(log, 'utf8')
            .split('\n')
            .filter((line) => line !== '')
            .map((line) => line.split('\0').slice(0, -1))
        : [],
  };
};

/** A systemd-run that always fails, recording its calls. */
export const failingSystemdRun = (dir: string): { program: string; calls: () => string[][] } =>
  fakeProgram(join(dir, 'failing-systemd-run'), "echo 'Failed to connect to bus: No medium found' >&2\nexit 1");

/** The `oom_score_adj` of `pid`. */
export const oomScoreAdj = (pid: number): number => Number(readFileSync(`/proc/${String(pid)}/oom_score_adj`, 'utf8').trim());

/** Whether `pid`'s `oom_score_adj` is the lowest the kernel permits it: -1000, or one less is refused. */
export const atOomFloor = (pid: number): boolean => {
  const adj = oomScoreAdj(pid);
  if (adj === -1000) return true;
  try {
    writeFileSync(`/proc/${String(pid)}/oom_score_adj`, String(adj - 1));
    return false;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EACCES') return true;
    throw error;
  }
};
