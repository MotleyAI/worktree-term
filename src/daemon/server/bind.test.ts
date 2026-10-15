import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as files from '../../platform/files/index.js';
import { bindSocket } from './bind.js';

interface Hooks {
  failRename: boolean;
  replaceAfterRename: boolean;
  lockHeld: boolean;
  lockPath: string;
  /** Each removeFile call, and whether the start lock file existed at that moment. */
  removals: { path: string; locked: boolean }[];
}

const hooks = vi.hoisted(
  (): Hooks => ({ failRename: false, replaceAfterRename: false, lockHeld: false, lockPath: '', removals: [] }),
);

vi.mock('../../platform/files/index.js', async (importOriginal) => {
  const real = await importOriginal<typeof files>();
  return {
    ...real,
    renameFile: async (from: string, to: string): Promise<void> => {
      if (hooks.failRename) throw Object.assign(new Error('EXDEV: rename failed'), { code: 'EXDEV' });
      await real.renameFile(from, to);
      if (hooks.replaceAfterRename) {
        renameSync(to, `${to}.moved`);
        writeFileSync(to, 'someone else');
      }
    },
    acquireStartLock: async (path: string): Promise<files.StartLock> => {
      if (hooks.lockHeld) throw new real.StartLockHeldError(`start lock ${path} is held`);
      return real.acquireStartLock(path);
    },
    removeFile: async (path: string): Promise<void> => {
      hooks.removals.push({ path, locked: existsSync(hooks.lockPath) });
      await real.removeFile(path);
    },
  };
});

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wtd-bind-'));
  hooks.failRename = false;
  hooks.replaceAfterRename = false;
  hooks.lockHeld = false;
  hooks.lockPath = '';
  hooks.removals = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const listeningPipes = (): number => process.getActiveResourcesInfo().filter((r) => r === 'PipeServerWrap').length;

it('closes the listener and removes the temporary socket when setup fails after listening', async () => {
  const paths = files.hostPaths({ env: { XDG_STATE_HOME: dir }, home: dir, host: 'box' });
  const before = listeningPipes();
  hooks.failRename = true;
  await expect(bindSocket(paths)).rejects.toThrow(/EXDEV/);
  expect(readdirSync(paths.runDir)).toEqual([]);
  expect(listeningPipes()).toBe(before);
});

it('binds the socket when setup succeeds', async () => {
  const paths = files.hostPaths({ env: { XDG_STATE_HOME: dir }, home: dir, host: 'box' });
  const listener = await bindSocket(paths);
  expect(readdirSync(paths.runDir)).toEqual(['box.sock']);
  await listener.close();
});

it('keeps a socket replaced the moment it was renamed into place', async () => {
  const paths = files.hostPaths({ env: { XDG_STATE_HOME: dir }, home: dir, host: 'box' });
  hooks.replaceAfterRename = true;
  const listener = await bindSocket(paths);
  await listener.close();
  expect(readFileSync(paths.socket, 'utf8')).toBe('someone else');
});

it('removes its socket on close only while holding the start lock, then releases the lock', async () => {
  const paths = files.hostPaths({ env: { XDG_STATE_HOME: dir }, home: dir, host: 'box' });
  hooks.lockPath = paths.lock;
  const listener = await bindSocket(paths);
  await listener.close();
  expect(hooks.removals.filter((r) => r.path === paths.socket)).toEqual([{ path: paths.socket, locked: true }]);
  expect(existsSync(paths.socket)).toBe(false);
  expect(existsSync(paths.lock)).toBe(false);
});

it('leaves its socket on close while another process holds the start lock', async () => {
  const paths = files.hostPaths({ env: { XDG_STATE_HOME: dir }, home: dir, host: 'box' });
  const listener = await bindSocket(paths);
  hooks.lockHeld = true;
  await listener.close();
  expect(existsSync(paths.socket)).toBe(true);
});
