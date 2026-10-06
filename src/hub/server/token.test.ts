import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  type BigIntStats,
  type PathLike,
  type Stats,
} from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadToken } from './token.js';

// Token files are reached through node:fs/promises; this hook makes one path look foreign-owned.
const hooks = vi.hoisted((): { foreignOwner: string | null } => ({ foreignOwner: null }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof FsPromises>();
  const foreign = <S extends Stats | BigIntStats>(path: string, stats: S): S => {
    if (path === hooks.foreignOwner) {
      Object.defineProperty(stats, 'uid', { value: typeof stats.uid === 'bigint' ? stats.uid + 1n : stats.uid + 1 });
    }
    return stats;
  };
  const wrap = (path: string, handle: FsPromises.FileHandle): FsPromises.FileHandle =>
    new Proxy(handle, {
      get(target, key, receiver): unknown {
        if (key === 'stat') return async (options?: { bigint?: boolean }) => foreign(path, await target.stat(options));
        const value: unknown = Reflect.get(target, key, receiver);
        return typeof value === 'function' ? (...args: unknown[]): unknown => Reflect.apply(value, target, args) : value;
      },
    });
  return {
    ...real,
    open: async (path: PathLike, flags?: string | number, mode?: number): Promise<FsPromises.FileHandle> =>
      wrap(String(path), await real.open(path, flags, mode)),
    stat: async (path: PathLike, options?: { bigint?: boolean }) => foreign(String(path), await real.stat(path, options)),
    lstat: async (path: PathLike, options?: { bigint?: boolean }) => foreign(String(path), await real.lstat(path, options)),
  };
});

const TOKEN = /^[0-9a-f]{64}$/;
const VALID = '0123456789abcdef'.repeat(4);

let dir: string;
let path: string;
let umask: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wtd-token-'));
  path = join(dir, 'hub-token');
  umask = process.umask(0);
  hooks.foreignOwner = null;
});

afterEach(() => {
  process.umask(umask);
  rmSync(dir, { recursive: true, force: true });
});

const modeOf = (file: string): number => statSync(file).mode & 0o777;
const stored = (): string => readFileSync(path, 'utf8').trim();

describe('loadToken', () => {
  it('creates an owner-only token of 64 lowercase hex digits', async () => {
    const token = await loadToken(path);
    expect(token).toMatch(TOKEN);
    expect(stored()).toBe(token);
    expect(modeOf(path)).toBe(0o600);
  });

  it('keeps an existing token', async () => {
    const first = await loadToken(path);
    expect(await loadToken(path)).toBe(first);
  });

  it('creates a different token for each new file', async () => {
    const first = await loadToken(path);
    rmSync(path);
    expect(await loadToken(path)).not.toBe(first);
  });

  it('tightens a loose token file to 0600 and keeps the token', async () => {
    writeFileSync(path, VALID, { mode: 0o644 });
    expect(await loadToken(path)).toBe(VALID);
    expect(modeOf(path)).toBe(0o600);
  });

  it.each([
    ['empty', ''],
    ['short', VALID.slice(1)],
    ['uppercase', VALID.toUpperCase()],
    ['not hex', 'z'.repeat(64)],
    ['two tokens', `${VALID}\n${VALID}`],
  ])('replaces a %s token atomically with a new one', async (_name, content) => {
    writeFileSync(path, content, { mode: 0o600 });
    const token = await loadToken(path);
    expect(token).toMatch(TOKEN);
    expect(token).not.toBe(VALID);
    expect(stored()).toBe(token);
    expect(modeOf(path)).toBe(0o600);
    expect(readdirSync(dir)).toEqual(['hub-token']);
  });

  it('refuses a symbolic link, naming the path, and leaves its target alone', async () => {
    const target = join(dir, 'target');
    writeFileSync(target, VALID, { mode: 0o600 });
    symlinkSync(target, path);
    await expect(loadToken(path)).rejects.toThrow(path);
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe(VALID);
  });

  it('refuses a dangling symbolic link, naming the path', async () => {
    symlinkSync(join(dir, 'nowhere'), path);
    await expect(loadToken(path)).rejects.toThrow(path);
  });

  it('refuses a directory, naming the path', async () => {
    mkdirSync(path);
    await expect(loadToken(path)).rejects.toThrow(path);
  });

  it('refuses a token file owned by another user, naming the path', async () => {
    writeFileSync(path, VALID, { mode: 0o600 });
    hooks.foreignOwner = path;
    await expect(loadToken(path)).rejects.toThrow(path);
    expect(readFileSync(path, 'utf8')).toBe(VALID);
  });
});
