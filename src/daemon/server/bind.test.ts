import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as files from '../../platform/files/index.js';
import { bindSocket } from './bind.js';

const hooks = vi.hoisted(() => ({ failRename: false }));

vi.mock('../../platform/files/index.js', async (importOriginal) => {
  const real = await importOriginal<typeof files>();
  return {
    ...real,
    renameFile: async (from: string, to: string): Promise<void> => {
      if (hooks.failRename) throw Object.assign(new Error('EXDEV: rename failed'), { code: 'EXDEV' });
      await real.renameFile(from, to);
    },
  };
});

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wtd-bind-'));
  hooks.failRename = false;
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
