import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type * as files from '../files/index.js';
import { spawnDetached, SpawnError } from './index.js';

interface Hooks {
  isDirectoryCalls: string[];
  /** What the next directory check answers instead of looking; null looks. */
  firstAnswer: boolean | null;
}

const hooks = vi.hoisted((): Hooks => ({ isDirectoryCalls: [], firstAnswer: null }));

vi.mock('../files/index.js', async (importOriginal) => {
  const real = await importOriginal<typeof files>();
  return {
    ...real,
    isDirectory: (path: string): Promise<boolean> => {
      hooks.isDirectoryCalls.push(path);
      const first = hooks.firstAnswer;
      hooks.firstAnswer = null;
      return first === null ? real.isDirectory(path) : Promise.resolve(first);
    },
  };
});

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wtd-spawn-race-'));
  hooks.isDirectoryCalls = [];
  hooks.firstAnswer = null;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

it('fails as a missing directory when the working directory vanishes between the check and the spawn', async () => {
  const gone = join(dir, 'gone');
  hooks.firstAnswer = true;
  const error: unknown = await spawnDetached([process.execPath, '-e', ''], null, { cwd: gone }).then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(SpawnError);
  expect(error instanceof SpawnError ? error.failure : null).toBe('missing-directory');
  expect(hooks.isDirectoryCalls).toEqual([gone, gone]);
});

it('checks the working directory once when the program starts', async () => {
  await spawnDetached([process.execPath, '-e', ''], null, { cwd: dir });
  expect(hooks.isDirectoryCalls).toEqual([dir]);
});
