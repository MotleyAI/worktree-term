import { randomBytes } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, rename, stat, unlink, chmod, type FileHandle } from 'node:fs/promises';
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
}

export interface HostIdentity {
  env: Readonly<Record<string, string | undefined>>;
  home: string;
  host: string;
}

/** Longest unix socket path, in bytes, that fits `sockaddr_un`. */
const MAX_SOCKET_PATH = 107;
const LOG_ROTATE_BYTES = 1024 * 1024;
const LOCK_RETRY_MS = 50;
const LOCK_WAIT_MS = 5000;

const hasCode = (error: unknown, code: string): boolean => error instanceof Error && 'code' in error && error.code === code;

/** Paths for `identity`; throws if the socket path does not fit a unix socket address. */
export const hostPaths = ({ env, home, host }: HostIdentity): HostPaths => {
  const xdg = env['XDG_STATE_HOME'];
  const base = xdg !== undefined && isAbsolute(xdg) ? xdg : join(home, '.local', 'state');
  const stateDir = join(base, 'worktree-term');
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
  };
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

/** Creates the state directory and `run/` owner-only, tightening looser modes. */
export const preparePrivateDirs = async (paths: HostPaths): Promise<void> => {
  await mkdir(dirname(paths.stateDir), { recursive: true });
  await privateDir(paths.stateDir);
  await privateDir(paths.runDir);
};

const temporaryOf = (path: string): string => `${path}.tmp-${randomBytes(6).toString('hex')}`;

const syncDir = async (dir: string): Promise<void> => {
  const handle = await open(dir, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

/** Writes a new owner-only file at `path`, complete and synced; returns its path. */
const writeTemporary = async (path: string, data: string): Promise<string> => {
  const temporary = temporaryOf(path);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(temporary);
    throw error;
  }
  await handle.close();
  return temporary;
};

/** Replaces `path` with `data` entirely or not at all, durably, as an owner-only file. */
export const writeFileAtomic = async (path: string, data: string): Promise<void> => {
  const temporary = await writeTemporary(path, data);
  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary);
    throw error;
  }
  await syncDir(dirname(path));
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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Takes the start lock at `path`, replacing one whose holder is not alive and waiting up to
 * 5 s for a live holder.
 */
export const acquireStartLock = async (path: string): Promise<StartLock> => {
  const holder: Holder = { pid: process.pid, nonce: randomBytes(16).toString('hex') };
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    if (await tryCreate(path, holder)) {
      return { release: () => removeIfUnchanged(path, JSON.stringify(holder)) };
    }
    const text = await readFileIfExists(path);
    const current = text === null ? null : parseHolder(text);
    if (text !== null && current !== null && !isAlive(current.pid)) {
      await removeIfUnchanged(path, text);
      continue;
    }
    if (Date.now() >= deadline) {
      const by = current === null ? '' : ` by process ${String(current.pid)}`;
      throw new Error(`start lock ${path} is held${by}`);
    }
    await sleep(LOCK_RETRY_MS);
  }
};
