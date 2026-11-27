import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, readdir, readFile, rmdir } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { sshCommand } from '../dialer/index.js';
import { preparePrivateDirs, privateDir, type HostPaths } from '../files/index.js';

const KEEP_ALIVE = 'reconnect,ServerAliveInterval=15,ServerAliveCountMax=3';
/** How long a finished program's error output may still arrive. */
const OUTPUT_WAIT_MS = 1000;
/** How long a mount program may run before it is stopped. */
const MOUNT_DEADLINE_MS = 60_000;

/** A remote directory to mount: the host's name, its SSH alias and the absolute path on it. */
export interface MountTarget {
  readonly host: string;
  readonly alias: string;
  readonly path: string;
}

/** Why a mount or unmount failed. */
export type MountFailure = 'missing-program' | 'failed';

/** A failed mount or unmount; `program` names the missing program. */
export class MountError extends Error {
  override readonly name = 'MountError';
  constructor(
    readonly failure: MountFailure,
    message: string,
    readonly program: string | null = null,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

const program = (variable: string, fallback: string): string => {
  const value = process.env[variable];
  return value === undefined || value === '' ? fallback : value;
};

/** The directory holding every mount point: `run/mounts` under the state directory. */
export const mountDir = (paths: Pick<HostPaths, 'runDir'>): string => join(paths.runDir, 'mounts');

/** The mount point of `target`, named by the SHA-256 of its host, alias and path. */
export const mountPoint = (paths: Pick<HostPaths, 'runDir'>, target: MountTarget): string =>
  join(mountDir(paths), createHash('sha256').update(`${target.host}\0${target.alias}\0${target.path}`).digest('hex').slice(0, 32));

/** The mount command line of `target`; throws naming a refused alias, or an SSH program or control path that sshfs would split. */
export const mountCommand = (paths: Pick<HostPaths, 'runDir'>, target: MountTarget): string[] => {
  const ssh = sshCommand(paths, target.alias, '').slice(0, -3);
  for (const part of ssh) {
    if (/[\s,\\]/.test(part)) {
      throw new Error(`cannot pass to sshfs, holding whitespace, a comma or a backslash: ${part.replace(/^ControlPath=/, '')}`);
    }
  }
  return [
    program('WTD_SSHFS', 'sshfs'),
    '-o',
    KEEP_ALIVE,
    '-o',
    `ssh_command=${ssh.join(' ')}`,
    `${target.alias}:${target.path}`,
    mountPoint(paths, target),
  ];
};

/** The unmount command line of the mount point `point`. */
export const unmountCommand = (point: string): string[] => [program('WTD_FUSERMOUNT', 'fusermount3'), '-u', '-z', point];

const lastLine = (text: string): string | null =>
  text
    .split('\n')
    .map((line) => line.trim())
    .findLast((line) => line !== '') ?? null;

/** Runs `command`, resolving to its exit status and error output; rejects with a MountError when it cannot start or, killed, outlives `deadlineMs`. */
const run = (command: readonly string[], deadlineMs: number | null = null): Promise<{ code: number | null; stderr: string }> =>
  new Promise((resolve, reject) => {
    const [file, ...args] = command;
    if (file === undefined) throw new Error('empty command');
    const child = spawn(file, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    let timedOut = false;
    const deadline =
      deadlineMs === null
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
          }, deadlineMs);
    child.once('error', (error) => {
      clearTimeout(deadline);
      const missing = 'code' in error && error.code === 'ENOENT';
      reject(
        missing
          ? new MountError('missing-program', `cannot find ${file}`, file, { cause: error })
          : new MountError('failed', `cannot start ${file}: ${error.message}`, null, { cause: error }),
      );
    });
    child.once('exit', (code) => {
      clearTimeout(deadline);
      if (timedOut) {
        child.stderr.destroy();
        reject(new MountError('failed', 'timed out'));
        return;
      }
      // A daemonizing program may leave its error output open; stop waiting for it after a while.
      const timer = setTimeout(() => child.stderr.destroy(), OUTPUT_WAIT_MS);
      child.once('close', () => {
        clearTimeout(timer);
        resolve({ code, stderr });
      });
    });
  });

const unescapeMountinfo = (field: string): string =>
  field.replaceAll(/\\([0-7]{3})/g, (_, octal: string) => String.fromCodePoint(Number.parseInt(octal, 8)));

/** Every mount point the process mount table lists. */
const mountedPoints = async (): Promise<Set<string>> => {
  const table = await readFile(program('WTD_MOUNTINFO', '/proc/self/mountinfo'), 'utf8');
  return new Set(
    table
      .split('\n')
      .map((line) => line.split(' ')[4])
      .filter((field) => field !== undefined)
      .map(unescapeMountinfo),
  );
};

/** Removes the empty directory `point`, if it exists; never anything inside it. */
const removePoint = async (point: string): Promise<void> => {
  try {
    await rmdir(point);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
};

/** Unmounts `point` when the mount table lists it, else removes it. */
const cleanUp = async (point: string): Promise<void> => {
  if ((await mountedPoints()).has(point)) await unmount(point);
  else await removePoint(point);
};

const executable = async (path: string): Promise<boolean> => {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** Rejects with a missing-program MountError unless `file` is an executable path or found on `PATH`. */
const requireProgram = async (file: string): Promise<void> => {
  const candidates = file.includes('/')
    ? [file]
    : (process.env['PATH'] ?? '')
        .split(delimiter)
        .filter((d) => d !== '')
        .map((d) => join(d, file));
  for (const candidate of candidates) if (await executable(candidate)) return; // NOSONAR(S9382) — first match wins
  throw new MountError('missing-program', `cannot find ${file}`, file);
};

/** Mounts `target`, once the unmount program is found, and resolves to its mount point once the mount table lists it; rejects with a MountError otherwise. */
export const mount = async (paths: HostPaths, target: MountTarget, deadlineMs = MOUNT_DEADLINE_MS): Promise<string> => {
  const command = mountCommand(paths, target);
  const point = mountPoint(paths, target);
  await requireProgram(unmountCommand(point)[0] ?? '');
  await preparePrivateDirs(paths);
  await privateDir(mountDir(paths));
  await privateDir(point);
  try {
    const { code, stderr } = await run(command, deadlineMs);
    if (code === 0 && (await mountedPoints()).has(point)) return point;
    throw new MountError('failed', lastLine(stderr) ?? 'not mounted');
  } catch (error) {
    await cleanUp(point).catch((error_: unknown) => {
      if (error instanceof MountError) throw new MountError(error.failure, error.message, error.program, { cause: error_ });
      const message = error instanceof Error ? error.message : 'mounting failed';
      throw new AggregateError([error, error_], message);
    });
    throw error;
  }
};

/** Unmounts the mount point `point` lazily, then removes it; rejects with a MountError when unmounting fails. */
export const unmount = async (point: string): Promise<void> => {
  const { code, stderr } = await run(unmountCommand(point));
  if (code !== 0) throw new MountError('failed', lastLine(stderr) ?? `cannot unmount ${point}`);
  await removePoint(point);
};

/** The mount points directly under the mount directory that the process mount table lists. */
export const listMounts = async (paths: Pick<HostPaths, 'runDir'>): Promise<string[]> => {
  const prefix = `${mountDir(paths)}/`;
  return [...(await mountedPoints())].filter((point) => point.startsWith(prefix) && !point.slice(prefix.length).includes('/'));
};

/** Removes every empty directory directly under the mount directory that the mount table does not list. */
export const removeLeftovers = async (paths: Pick<HostPaths, 'runDir'>): Promise<void> => {
  let names: string[];
  try {
    names = await readdir(mountDir(paths));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  const mounted = await mountedPoints();
  for (const name of names) {
    const point = join(mountDir(paths), name);
    if (!mounted.has(point)) await removePoint(point); // NOSONAR(S9382) — one at a time
  }
};
