import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
  type BigIntStats,
  type PathLike,
  type Stats,
} from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import { homedir, hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  acquireStartLock,
  currentHostPaths,
  fileIdentity,
  hostPaths,
  makeOwnerOnly,
  openLog,
  preparePrivateDirs,
  readFileIfExists,
  removeFile,
  renameFile,
  writeFileAtomic,
} from './index.js';

// platform.files does its I/O through node:fs/promises; these hooks inject failures into it.
interface Hooks {
  /** Writes to paths under this prefix fail with ENOSPC after half the data. */
  failWriteOf: string | null;
  /** stat and lstat report this path as owned by another user. */
  foreignOwner: string | null;
  /** Unlinking paths under this prefix fails with EACCES. */
  failUnlinkOf: string | null;
  /** Syncing this path fails with EIO. */
  failSyncOf: string | null;
  /** The first unlink or rename away of this path waits 100 ms. */
  delayRemovalOf: string | null;
  calls: string[];
}

const hooks = vi.hoisted((): Hooks => ({
  failWriteOf: null,
  foreignOwner: null,
  failUnlinkOf: null,
  failSyncOf: null,
  delayRemovalOf: null,
  calls: [],
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof FsPromises>();
  const failing = (path: string): boolean => hooks.failWriteOf !== null && path.startsWith(hooks.failWriteOf);
  const enospc = (): Error => Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
  const half = (data: string | Uint8Array): Uint8Array => {
    const bytes = typeof data === 'string' ? Buffer.from(data) : data;
    return bytes.subarray(0, Math.floor(bytes.length / 2));
  };
  const wrap = (path: string, handle: FsPromises.FileHandle): FsPromises.FileHandle =>
    new Proxy(handle, {
      get(target, key, receiver): unknown {
        if (key === 'sync') {
          return async (): Promise<void> => {
            hooks.calls.push(`sync ${path}`);
            if (path === hooks.failSyncOf) throw Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' });
            await target.sync();
          };
        }
        if ((key === 'write' || key === 'writeFile') && failing(path)) {
          return async (data: string | Uint8Array): Promise<never> => {
            await target.write(half(data));
            throw enospc();
          };
        }
        const value: unknown = Reflect.get(target, key, receiver);
        return typeof value === 'function' ? (...args: unknown[]): unknown => Reflect.apply(value, target, args) : value;
      },
    });
  const delayedRemoval = async (path: PathLike): Promise<void> => {
    if (String(path) !== hooks.delayRemovalOf) return;
    hooks.delayRemovalOf = null;
    await new Promise((resolve) => setTimeout(resolve, 100));
  };
  const foreign = async <S extends Stats | BigIntStats>(path: PathLike, stat: () => Promise<S>): Promise<S> => {
    const stats = await stat();
    if (String(path) === hooks.foreignOwner)
      Object.defineProperty(stats, 'uid', { value: typeof stats.uid === 'bigint' ? stats.uid + 1n : stats.uid + 1 });
    return stats;
  };
  return {
    ...real,
    open: async (path: PathLike, flags?: string | number, mode?: number): Promise<FsPromises.FileHandle> =>
      wrap(String(path), await real.open(path, flags, mode)),
    writeFile: async (path: PathLike | FsPromises.FileHandle, data: string | Uint8Array, options?: object) => {
      if (typeof path !== 'object' || path instanceof URL || Buffer.isBuffer(path)) {
        if (failing(String(path))) {
          await real.writeFile(path, half(data), options);
          throw enospc();
        }
      }
      return real.writeFile(path, data, options);
    },
    rename: async (from: PathLike, to: PathLike): Promise<void> => {
      hooks.calls.push(`rename ${String(from)} ${String(to)}`);
      await delayedRemoval(from);
      await real.rename(from, to);
    },
    unlink: async (path: PathLike): Promise<void> => {
      if (hooks.failUnlinkOf !== null && String(path).startsWith(hooks.failUnlinkOf)) {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      }
      await delayedRemoval(path);
      await real.unlink(path);
    },
    stat: (path: PathLike) => foreign(path, () => real.stat(path)),
    lstat: (path: PathLike, options?: { bigint?: boolean }) =>
      options?.bigint === true ? foreign(path, () => real.lstat(path, { bigint: true })) : foreign(path, () => real.lstat(path)),
  };
});

const MiB = 1024 * 1024;

let dir: string;
let umask: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wtd-files-'));
  umask = process.umask(0);
  hooks.failWriteOf = null;
  hooks.foreignOwner = null;
  hooks.failUnlinkOf = null;
  hooks.failSyncOf = null;
  hooks.delayRemovalOf = null;
  hooks.calls.length = 0;
});

afterEach(() => {
  process.umask(umask);
  rmSync(dir, { recursive: true, force: true });
});

const modeOf = (path: string): number => statSync(path).mode & 0o777;

/** The pid of a process that has exited and been reaped. */
const deadPid = (): number => spawnSync('true').pid;

describe('host paths', () => {
  it('honours an absolute XDG_STATE_HOME', () => {
    expect(hostPaths({ env: { XDG_STATE_HOME: '/tmp/x' }, home: '/home/u', host: 'box' })).toEqual({
      stateDir: '/tmp/x/worktree-term',
      runDir: '/tmp/x/worktree-term/run',
      socket: '/tmp/x/worktree-term/run/box.sock',
      lock: '/tmp/x/worktree-term/run/box.lock',
      state: '/tmp/x/worktree-term/state.json',
      log: '/tmp/x/worktree-term/daemon.log',
      configDir: '/home/u/.config/worktree-term',
      config: '/home/u/.config/worktree-term/config.json',
      hubToken: '/tmp/x/worktree-term/hub-token',
      hubLog: '/tmp/x/worktree-term/hub.log',
      hubLock: '/tmp/x/worktree-term/run/hub.lock',
      hubRecord: '/tmp/x/worktree-term/run/hub.json',
    });
  });

  it('honours an absolute XDG_CONFIG_HOME', () => {
    const paths = hostPaths({ env: { XDG_CONFIG_HOME: '/tmp/c' }, home: '/home/u', host: 'box' });
    expect(paths.configDir).toBe('/tmp/c/worktree-term');
    expect(paths.config).toBe('/tmp/c/worktree-term/config.json');
  });

  it.each([
    ['relative', { XDG_CONFIG_HOME: 'rel/dir' }],
    ['empty', { XDG_CONFIG_HOME: '' }],
    ['unset', {}],
  ])('falls back to ~/.config when XDG_CONFIG_HOME is %s', (_name, env) => {
    expect(hostPaths({ env, home: '/home/u', host: 'box' }).config).toBe('/home/u/.config/worktree-term/config.json');
  });

  it('keeps hub files under the state directory whatever the configuration directory', () => {
    const paths = hostPaths({ env: { XDG_STATE_HOME: '/s', XDG_CONFIG_HOME: '/c' }, home: '/home/u', host: 'box' });
    expect([paths.hubToken, paths.hubLog, paths.hubLock, paths.hubRecord]).toEqual([
      '/s/worktree-term/hub-token',
      '/s/worktree-term/hub.log',
      '/s/worktree-term/run/hub.lock',
      '/s/worktree-term/run/hub.json',
    ]);
  });

  it.each([
    ['relative', { XDG_STATE_HOME: 'rel/dir' }],
    ['empty', { XDG_STATE_HOME: '' }],
    ['unset', {}],
  ])('falls back to ~/.local/state when XDG_STATE_HOME is %s', (_name, env) => {
    expect(hostPaths({ env, home: '/home/u', host: 'box' }).stateDir).toBe('/home/u/.local/state/worktree-term');
  });

  it.each([
    ['my box/1', 'my_box_1'],
    ['a.b-c_D9', 'a.b-c_D9'],
    ['bøx:2', 'b_x_2'],
  ])('sanitises host name %j to %j', (host, name) => {
    const paths = hostPaths({ env: { XDG_STATE_HOME: '/s' }, home: '/home/u', host });
    expect(paths.socket).toBe(`/s/worktree-term/run/${name}.sock`);
    expect(paths.lock).toBe(`/s/worktree-term/run/${name}.lock`);
  });

  it('accepts a socket path of 107 bytes', () => {
    const paths = hostPaths({ env: { XDG_STATE_HOME: '/' + 'a'.repeat(79) }, home: '/home/u', host: 'box' });
    expect(Buffer.byteLength(paths.socket)).toBe(107);
  });

  it.each([
    ['ASCII', '/' + 'a'.repeat(80)],
    ['multi-byte', '/' + 'é'.repeat(40)],
  ])('refuses an %s socket path of 108 bytes, naming it', (_name, xdg) => {
    const socket = `${xdg}/worktree-term/run/box.sock`;
    expect(Buffer.byteLength(socket)).toBe(108);
    expect(() => hostPaths({ env: { XDG_STATE_HOME: xdg }, home: '/home/u', host: 'box' })).toThrow(socket);
  });
});

describe('current host paths', () => {
  it('derives the paths from the environment, home and host name', () => {
    const paths = currentHostPaths();
    expect(paths).toEqual(hostPaths({ env: process.env, home: homedir(), host: hostname() }));
  });
});

describe('private directories', () => {
  const paths = () => hostPaths({ env: { XDG_STATE_HOME: join(dir, 'state') }, home: '/nonexistent', host: 'box' });

  it('creates the state directory and run/ owner-only', async () => {
    await preparePrivateDirs(paths());
    expect(modeOf(paths().stateDir)).toBe(0o700);
    expect(modeOf(paths().runDir)).toBe(0o700);
  });

  it('tightens loose existing directories to 0700', async () => {
    mkdirSync(paths().runDir, { recursive: true, mode: 0o755 });
    mkdirSync(paths().stateDir, { recursive: true, mode: 0o755 });
    await preparePrivateDirs(paths());
    expect(modeOf(paths().stateDir)).toBe(0o700);
    expect(modeOf(paths().runDir)).toBe(0o700);
  });

  it('refuses a state directory owned by another user, naming it', async () => {
    mkdirSync(paths().stateDir, { recursive: true, mode: 0o700 });
    const target = paths();
    hooks.foreignOwner = target.stateDir;
    const preparing = preparePrivateDirs(target);
    await expect(preparing).rejects.toThrow(target.stateDir);
  });

  it('refuses a run/ directory owned by another user, naming it', async () => {
    mkdirSync(paths().runDir, { recursive: true, mode: 0o700 });
    const target = paths();
    hooks.foreignOwner = target.runDir;
    const preparing = preparePrivateDirs(target);
    await expect(preparing).rejects.toThrow(target.runDir);
  });
});

describe('atomic writes', () => {
  it('creates the file owner-only', async () => {
    const file = join(dir, 'f.json');
    await writeFileAtomic(file, '{"a":1}');
    expect(readFileSync(file, 'utf8')).toBe('{"a":1}');
    expect(modeOf(file)).toBe(0o600);
  });

  it('replaces a looser existing file with an owner-only one', async () => {
    const file = join(dir, 'f.json');
    writeFileSync(file, 'old', { mode: 0o644 });
    await writeFileAtomic(file, 'new');
    expect(readFileSync(file, 'utf8')).toBe('new');
    expect(modeOf(file)).toBe(0o600);
  });

  it('keeps the old content and leaves no temporary file when a write fails midway', async () => {
    const file = join(dir, 'f.json');
    writeFileSync(file, 'previous content');
    hooks.failWriteOf = dir;
    const data = 'n'.repeat(100_000);
    const writing = writeFileAtomic(file, data);
    await expect(writing).rejects.toThrow(/ENOSPC/);
    expect(readFileSync(file, 'utf8')).toBe('previous content');
    expect(readdirSync(dir)).toEqual(['f.json']);
  });

  it('reports the write error when removing the temporary file also fails', async () => {
    hooks.failWriteOf = dir;
    hooks.failUnlinkOf = dir;
    const file = join(dir, 'f.json');
    const data = 'n'.repeat(100_000);
    await expect(writeFileAtomic(file, data)).rejects.toThrow(/ENOSPC/);
  });

  it('reports the rename error when removing the temporary file also fails', async () => {
    const target = join(dir, 'occupied');
    mkdirSync(join(target, 'child'), { recursive: true });
    hooks.failUnlinkOf = dir;
    await expect(writeFileAtomic(target, 'x')).rejects.toMatchObject({ code: 'EISDIR' });
  });

  it('completes a write whose directory cannot be synced once the file is replaced', async () => {
    const file = join(dir, 'f.json');
    writeFileSync(file, 'old');
    hooks.failSyncOf = dir;
    await writeFileAtomic(file, 'new');
    expect(readFileSync(file, 'utf8')).toBe('new');
  });

  it('syncs the new content before renaming it into place', async () => {
    const file = join(dir, 'f.json');
    await writeFileAtomic(file, 'x');
    const rename = hooks.calls.findIndex((call) => call.startsWith('rename ') && call.endsWith(` ${file}`));
    expect(rename).toBeGreaterThan(-1);
    const renamed = hooks.calls[rename]?.split(' ')[1];
    expect(hooks.calls.slice(0, rename)).toContain(`sync ${String(renamed)}`);
  });

  it('syncs the directory after renaming, so the rename itself is durable', async () => {
    const file = join(dir, 'f.json');
    await writeFileAtomic(file, 'x');
    const rename = hooks.calls.findIndex((call) => call.startsWith('rename ') && call.endsWith(` ${file}`));
    expect(rename).toBeGreaterThan(-1);
    expect(hooks.calls.slice(rename + 1)).toContain(`sync ${dir}`);
  });

  it('reads back written content', async () => {
    const file = join(dir, 'f.json');
    await writeFileAtomic(file, 'héllo');
    expect(await readFileIfExists(file)).toBe('héllo');
  });

  it('reads a missing file as no content', async () => {
    expect(await readFileIfExists(join(dir, 'missing.json'))).toBeNull();
  });
});

describe('file helpers', () => {
  it('renames a file', async () => {
    writeFileSync(join(dir, 'a'), 'content');
    await renameFile(join(dir, 'a'), join(dir, 'b'));
    expect(readdirSync(dir)).toEqual(['b']);
  });

  it('removes a file, and counts a missing one as removed', async () => {
    writeFileSync(join(dir, 'a'), 'content');
    await removeFile(join(dir, 'a'));
    await removeFile(join(dir, 'a'));
    expect(readdirSync(dir)).toEqual([]);
  });

  it('makes a file owner-only', async () => {
    writeFileSync(join(dir, 'a'), 'content', { mode: 0o644 });
    await makeOwnerOnly(join(dir, 'a'));
    expect(modeOf(join(dir, 'a'))).toBe(0o600);
  });

  it('identifies a file stably, a recreated file differently, and a missing one as null', async () => {
    const file = join(dir, 'a');
    writeFileSync(file, 'one');
    const first = await fileIdentity(file);
    expect(first).not.toBeNull();
    expect(await fileIdentity(file)).toBe(first);
    rmSync(file);
    writeFileSync(file, 'two');
    expect(await fileIdentity(file)).not.toBe(first);
    rmSync(file);
    expect(await fileIdentity(file)).toBeNull();
  });
});

describe('daemon log', () => {
  it('opens the log owner-only for appending', async () => {
    const log = join(dir, 'daemon.log');
    writeFileSync(log, 'before\n', { mode: 0o600 });
    const handle = await openLog(log);
    writeSync(handle.fd, 'after\n');
    await handle.close();
    expect(readFileSync(log, 'utf8')).toBe('before\nafter\n');
    expect(modeOf(log)).toBe(0o600);
  });

  it('creates a missing log owner-only', async () => {
    const log = join(dir, 'daemon.log');
    const handle = await openLog(log);
    await handle.close();
    expect(modeOf(log)).toBe(0o600);
  });

  it('moves a log over 1 MiB to daemon.log.1 first', async () => {
    const log = join(dir, 'daemon.log');
    writeFileSync(`${log}.1`, 'oldest');
    writeFileSync(log, 'x'.repeat(MiB + 1));
    const handle = await openLog(log);
    writeSync(handle.fd, 'fresh\n');
    await handle.close();
    expect(readFileSync(log, 'utf8')).toBe('fresh\n');
    expect(statSync(`${log}.1`).size).toBe(MiB + 1);
  });

  it('keeps appending to a log of exactly 1 MiB', async () => {
    const log = join(dir, 'daemon.log');
    writeFileSync(log, 'x'.repeat(MiB));
    const handle = await openLog(log);
    await handle.close();
    expect(statSync(log).size).toBe(MiB);
    expect(readdirSync(dir)).toEqual(['daemon.log']);
  });
});

describe('start lock', () => {
  const lockFile = (): string => join(dir, 'box.lock');
  const holderSchema = z.strictObject({ pid: z.int(), nonce: z.string() });
  const holder = (): z.infer<typeof holderSchema> => holderSchema.parse(JSON.parse(readFileSync(lockFile(), 'utf8')));

  it('records the holder pid and a nonce in an owner-only file', async () => {
    const lock = await acquireStartLock(lockFile());
    expect(holder().pid).toBe(process.pid);
    expect(holder().nonce).toMatch(/\S/);
    expect(modeOf(lockFile())).toBe(0o600);
    await lock.release();
  });

  it('removes the lock on release', async () => {
    const lock = await acquireStartLock(lockFile());
    await lock.release();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('uses a fresh nonce for every acquisition', async () => {
    const first = await acquireStartLock(lockFile());
    const { nonce } = holder();
    await first.release();
    const second = await acquireStartLock(lockFile());
    expect(holder().nonce).not.toBe(nonce);
    await second.release();
  });

  it('reclaims a lock whose process is not alive', async () => {
    writeFileSync(lockFile(), JSON.stringify({ pid: deadPid(), nonce: 'dead' }), { mode: 0o600 });
    const started = Date.now();
    const lock = await acquireStartLock(lockFile());
    expect(Date.now() - started).toBeLessThan(1000);
    expect(holder().pid).toBe(process.pid);
    expect(holder().nonce).not.toBe('dead');
    await lock.release();
  });

  it('lets only one of two starters reclaim the same stale lock, however their steps interleave', async () => {
    writeFileSync(lockFile(), JSON.stringify({ pid: deadPid(), nonce: 'dead' }), { mode: 0o600 });
    // The first reclaimer is slow to remove the stale lock; the second reclaims and takes it meanwhile.
    hooks.delayRemovalOf = lockFile();
    const outcomes = await Promise.allSettled([acquireStartLock(lockFile()), acquireStartLock(lockFile())]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
  }, 15_000);

  it('waits for a live holder and fails after 5 s without taking the lock', async () => {
    const first = await acquireStartLock(lockFile());
    const before = readFileSync(lockFile(), 'utf8');
    const path = lockFile();
    const started = Date.now();
    const acquiring = acquireStartLock(path);
    await expect(acquiring).rejects.toThrow();
    const waited = Date.now() - started;
    expect(waited).toBeGreaterThanOrEqual(4900);
    expect(waited).toBeLessThan(7000);
    expect(readFileSync(lockFile(), 'utf8')).toBe(before);
    await first.release();
  }, 15_000);

  it('takes the lock soon after a live holder releases it', async () => {
    const first = await acquireStartLock(lockFile());
    const second = acquireStartLock(lockFile());
    await new Promise((resolve) => setTimeout(resolve, 300));
    const released = Date.now();
    await first.release();
    const lock = await second;
    expect(Date.now() - released).toBeLessThan(250);
    await lock.release();
  });

  it('does not release a lock that now holds another nonce', async () => {
    const lock = await acquireStartLock(lockFile());
    const other = JSON.stringify({ pid: process.pid, nonce: 'someone-else' });
    writeFileSync(lockFile(), other);
    await lock.release();
    expect(readFileSync(lockFile(), 'utf8')).toBe(other);
  });
});
