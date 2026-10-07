import { randomBytes } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { link, lstat, mkdir, open, readdir, readFile, rename, stat, unlink, chmod, type FileHandle } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

/** Where worktree-term keeps this host's files. */
export interface HostPaths {
  stateDir: string;
  runDir: string;
  socket: string;
  lock: string;
  state: string;
  log: string;
  configDir: string;
  config: string;
  hubToken: string;
  hubLog: string;
  hubLock: string;
  hubRecord: string;
  unitFile: string;
}

export interface HostIdentity {
  env: Readonly<Record<string, string | undefined>>;
  home: string;
  host: string;
}

/** The daemon's systemd user unit. */
export const UNIT_NAME = 'worktree-term-daemon.service';

/** Longest unix socket path, in bytes, that fits `sockaddr_un`. */
const MAX_SOCKET_PATH = 107;
const LOG_ROTATE_BYTES = 1024 * 1024;
const LOCK_RETRY_MS = 50;
const LOCK_WAIT_MS = 5000;

const hasCode = (error: unknown, code: string): boolean => error instanceof Error && 'code' in error && error.code === code;

const xdgBase = (value: string | undefined, fallback: string): string => (value !== undefined && isAbsolute(value) ? value : fallback);

/** Paths for `identity`; throws if the socket path does not fit a unix socket address. */
export const hostPaths = ({ env, home, host }: HostIdentity): HostPaths => {
  const stateDir = join(xdgBase(env['XDG_STATE_HOME'], join(home, '.local', 'state')), 'worktree-term');
  const configHome = xdgBase(env['XDG_CONFIG_HOME'], join(home, '.config'));
  const configDir = join(configHome, 'worktree-term');
  const runDir = join(stateDir, 'run');
  const name = host.replace(/[^A-Za-z0-9._-]/g, '_');
  const socket = join(runDir, `${name}.sock`);
  if (Buffer.byteLength(socket) > MAX_SOCKET_PATH) {
    throw new Error(`socket path ${socket} exceeds ${String(MAX_SOCKET_PATH)} bytes`);
  }
  return {
    stateDir,
    runDir,
    socket,
    lock: join(runDir, `${name}.lock`),
    state: join(stateDir, 'state.json'),
    log: join(stateDir, 'daemon.log'),
    configDir,
    config: join(configDir, 'config.json'),
    hubToken: join(stateDir, 'hub-token'),
    hubLog: join(stateDir, 'hub.log'),
    hubLock: join(runDir, 'hub.lock'),
    hubRecord: join(runDir, 'hub.json'),
    unitFile: join(configHome, 'systemd', 'user', UNIT_NAME),
  };
};

/** The SSH control path in `run/`; throws naming it if, with `%C` substituted, it does not fit a unix socket address. */
export const sshControlPath = (paths: Pick<HostPaths, 'runDir'>): string => {
  const path = join(paths.runDir, 'ssh-%C');
  if (Buffer.byteLength(path.replace('%C', '0'.repeat(40))) > MAX_SOCKET_PATH) {
    throw new Error(`SSH control path ${path} exceeds ${String(MAX_SOCKET_PATH)} bytes`);
  }
  return path;
};

/** Paths of the current process's user and host. */
export const currentHostPaths = (): HostPaths => hostPaths({ env: process.env, home: homedir(), host: hostname() });

const privateDir = async (path: string): Promise<void> => {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!hasCode(error, 'EEXIST')) throw error;
  }
  const stats = await lstat(path);
  if (!stats.isDirectory()) throw new Error(`${path} is not a directory`);
  if (stats.uid !== process.getuid?.()) throw new Error(`${path} is owned by another user`);
  if ((stats.mode & 0o777) !== 0o700) await chmod(path, 0o700);
};

export type EntryKind = 'directory' | 'file' | 'symlink';

const isKind = (stats: Stats, kind: EntryKind): boolean => {
  if (kind === 'directory') return stats.isDirectory();
  return kind === 'file' ? stats.isFile() : stats.isSymbolicLink();
};

/**
 * Whether `path` exists, without following a final symbolic link; throws naming it when it is not
 * of `kind` or is owned by another user.
 */
export const ownedEntry = async (path: string, kind: EntryKind): Promise<boolean> => {
  let stats: Stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return false;
    throw error;
  }
  if (!isKind(stats, kind)) throw new Error(`${path} is not a ${kind === 'symlink' ? 'symbolic link' : kind}`);
  if (stats.uid !== process.getuid?.()) throw new Error(`${path} is owned by another user`);
  return true;
};

/** Whether anything exists at `path`, following symbolic links. */
export const pathExists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (hasCode(error, 'ENOENT') || hasCode(error, 'ENOTDIR')) return false;
    throw error;
  }
};

/** Creates `path` and any missing parents owner-only, leaving existing directories as they are. */
export const makePrivateDirs = async (path: string): Promise<void> => {
  await mkdir(path, { recursive: true, mode: 0o700 });
};

/** Creates the state directory and `run/` owner-only, tightening looser modes. */
export const preparePrivateDirs = async (paths: Pick<HostPaths, 'stateDir' | 'runDir'>): Promise<void> => {
  await mkdir(dirname(paths.stateDir), { recursive: true });
  await privateDir(paths.stateDir);
  await privateDir(paths.runDir);
};

const ignore = (): void => undefined;

const temporaryOf = (path: string): string => `${path}.tmp-${randomBytes(6).toString('hex')}`;

const syncDir = async (dir: string): Promise<void> => {
  const handle = await open(dir, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

/** Writes a new file at `path` with `mode`, complete and synced; returns its path. */
const writeTemporary = async (path: string, data: string, mode = 0o600): Promise<string> => {
  const temporary = temporaryOf(path);
  const handle = await open(temporary, 'wx', mode);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } catch (error) {
    // Best effort: the write's error is the one to report.
    await handle.close().catch(ignore);
    await unlink(temporary).catch(ignore);
    throw error;
  }
  await handle.close();
  return temporary;
};

/**
 * Replaces `path` with `data` entirely or not at all, durably, as an owner-only file (0600, or `mode`).
 * Once the file is replaced the write has happened, so a failure to sync the directory does not fail it.
 */
export const writeFileAtomic = async (path: string, data: string, mode = 0o600): Promise<void> => {
  const temporary = await writeTemporary(path, data, mode & 0o700);
  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(ignore);
    throw error;
  }
  await syncDir(dirname(path)).catch(ignore);
};

/** The UTF-8 content of `path`, or null when it does not exist. */
export const readFileIfExists = async (path: string): Promise<string | null> => {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return null;
    throw error;
  }
};

/** Renames `from` to `to`. */
export const renameFile = (from: string, to: string): Promise<void> => rename(from, to);

/** Removes `path`; a missing file counts as removed. */
export const removeFile = async (path: string): Promise<void> => {
  try {
    await unlink(path);
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error;
  }
};

/**
 * Identifies the file at `path` (not following a final symbolic link) by device, inode and birth
 * time, so a file recreated in a reused inode differs; null when it does not exist.
 */
export const fileIdentity = async (path: string): Promise<string | null> => {
  try {
    const stats = await lstat(path, { bigint: true });
    return `${String(stats.dev)}:${String(stats.ino)}:${String(stats.birthtimeNs)}`;
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return null;
    throw error;
  }
};

/**
 * The content of the regular file at `path`, owned by this user, tightened to 0600 if looser;
 * null when it does not exist. Refuses symbolic links, other file types and other owners.
 */
export const readPrivateFile = async (path: string): Promise<string | null> => {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return null;
    if (hasCode(error, 'ELOOP')) throw new Error(`${path} is a symbolic link`, { cause: error });
    throw error;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error(`${path} is not a regular file`);
    if (stats.uid !== process.getuid?.()) throw new Error(`${path} is owned by another user`);
    if ((stats.mode & 0o077) !== 0) await handle.chmod(0o600);
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
};

/** A file read by `readTree`, its path relative to the tree's root with `/` separators. */
export interface TreeFile {
  path: string;
  data: Uint8Array;
}

/** Every regular file under `dir`, read whole; symbolic links are not followed. */
export const readTree = async (dir: string): Promise<TreeFile[]> => {
  const walk = async (relative: string): Promise<TreeFile[]> => {
    const entries = await readdir(join(dir, relative), { withFileTypes: true });
    const nested = await Promise.all(
      entries.map(async (entry): Promise<TreeFile[]> => {
        const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
        if (entry.isDirectory()) return walk(path);
        return entry.isFile() ? [{ path, data: await readFile(join(dir, path)) }] : [];
      }),
    );
    return nested.flat();
  };
  return walk('');
};

/** Restricts `path` to its owner. */
export const makeOwnerOnly = (path: string): Promise<void> => chmod(path, 0o600);

/** Opens the log owner-only for appending, first moving a log over 1 MiB to `<path>.1`. */
export const openLog = async (path: string): Promise<FileHandle> => {
  try {
    if ((await stat(path)).size > LOG_ROTATE_BYTES) await rename(path, `${path}.1`);
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error;
  }
  const handle = await open(path, 'a', 0o600);
  await handle.chmod(0o600);
  return handle;
};

export interface StartLock {
  release: () => Promise<void>;
}

interface Holder {
  pid: number;
  nonce: string;
}

const parseHolder = (text: string): Holder | null => {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null || !('pid' in value) || !('nonce' in value)) return null;
    const { pid, nonce } = value;
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 && typeof nonce === 'string' ? { pid, nonce } : null;
  } catch {
    return null;
  }
};

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasCode(error, 'ESRCH');
  }
};

/** Creates the lock file with its complete content, failing with EEXIST if it exists. */
const tryCreate = async (path: string, holder: Holder): Promise<boolean> => {
  const temporary = await writeTemporary(path, JSON.stringify(holder));
  try {
    await link(temporary, path);
    return true;
  } catch (error) {
    if (hasCode(error, 'EEXIST')) return false;
    throw error;
  } finally {
    await unlink(temporary);
  }
};

/** Removes the lock at `path` if it still holds `text`; a missing lock counts as removed. */
const removeIfUnchanged = async (path: string, text: string | null): Promise<void> => {
  if ((await readFileIfExists(path)) !== text) return;
  try {
    await unlink(path);
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error;
  }
};

/**
 * Removes the stale lock at `path` that held `text`. Moving it aside is atomic, so of several
 * reclaimers only one moves it; one that moved a lock replaced since it was read puts it back.
 */
const reclaimStale = async (path: string, text: string): Promise<void> => {
  const aside = `${path}.stale-${randomBytes(6).toString('hex')}`;
  try {
    await rename(path, aside);
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return;
    throw error;
  }
  if ((await readFileIfExists(aside)) !== text) {
    try {
      await link(aside, path);
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error;
    }
  }
  await removeFile(aside);
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Takes the start lock at `path`, replacing one whose holder is not alive and waiting up to
 * 5 s for a live holder.
 */
export const acquireStartLock = async (path: string): Promise<StartLock> => {
  const holder: Holder = { pid: process.pid, nonce: randomBytes(16).toString('hex') };
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    const created = await tryCreate(path, holder); // NOSONAR(S9382) — retry loop
    if (created) return { release: () => removeIfUnchanged(path, JSON.stringify(holder)) };
    const text = await readFileIfExists(path); // NOSONAR(S9382) — retry loop
    const current = text === null ? null : parseHolder(text);
    if (text !== null && current !== null && !isAlive(current.pid)) {
      await reclaimStale(path, text); // NOSONAR(S9382) — retry loop
      continue;
    }
    if (Date.now() >= deadline) {
      const by = current === null ? '' : ` by process ${String(current.pid)}`;
      throw new Error(`start lock ${path} is held${by}`);
    }
    await sleep(LOCK_RETRY_MS); // NOSONAR(S9382) — retry loop
  }
};
