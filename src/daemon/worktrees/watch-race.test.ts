import { execFileSync } from 'node:child_process';
import type * as Fs from 'node:fs';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Worktree } from '../../protocol/index.js';
import { watchWorktrees, type WorktreeWatch } from './index.js';

// `vanishOnce`: removed between its stat and its fs.watch, so watching it fails once with ENOENT.
// `silenced`: its events reach the watcher only through `unnamed`, which reports them without a name.
const hooks = vi.hoisted((): { vanishOnce: string | null; silenced: string | null; unnamed: (() => void) | null } => ({
  vanishOnce: null,
  silenced: null,
  unnamed: null,
}));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof Fs>();
  const watch = (path: Fs.PathLike, options: Fs.WatchOptionsWithStringEncoding, listener: Fs.WatchListener<string>): Fs.FSWatcher => {
    if (String(path) === hooks.vanishOnce) {
      hooks.vanishOnce = null;
      throw Object.assign(new Error(`ENOENT: no such file or directory, watch '${String(path)}'`), { code: 'ENOENT' });
    }
    if (String(path) === hooks.silenced) {
      hooks.unnamed = () => {
        Reflect.apply(listener, undefined, ['rename', null]);
      };
      return real.watch(path, options, () => undefined);
    }
    return real.watch(path, options, listener);
  };
  return { ...real, watch, default: { ...real, watch } };
});

const git = (cwd: string, ...args: string[]): void => {
  execFileSync('git', args, {
    cwd,
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
    stdio: 'ignore',
  });
};

let dir: string;
let repo: string;
let watch: WorktreeWatch | undefined;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'wtd-watch-race-')));
  repo = join(dir, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(repo, 'worktree', 'add', '-q', '-b', 'wt', join(dir, 'wt'));
});

afterEach(() => {
  hooks.vanishOnce = null;
  hooks.silenced = null;
  hooks.unnamed = null;
  watch?.close();
  rmSync(dir, { recursive: true, force: true });
});

const start = async (failures: Error[]): Promise<WorktreeWatch> =>
  watchWorktrees(repo, {
    changed: () => undefined,
    failed: (error: Error) => failures.push(error),
  });

it('keeps watching when a worktree admin directory vanishes before it is watched', async () => {
  hooks.vanishOnce = join(repo, '.git', 'worktrees', 'wt');
  const failures: Error[] = [];
  watch = await start(failures);
  expect(hooks.vanishOnce).toBeNull();
  expect(watch.worktrees.map((w: Worktree) => w.path)).toEqual([repo, join(dir, 'wt')]);
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(failures).toEqual([]);
});

it('fails when the common git directory cannot be watched', async () => {
  hooks.vanishOnce = join(repo, '.git');
  await expect(start([])).rejects.toThrow(/ENOENT/);
});

it('refreshes on a common-directory event without a name', async () => {
  git(repo, 'branch', 'other');
  hooks.silenced = join(repo, '.git');
  const changes: Worktree[][] = [];
  watch = await watchWorktrees(repo, { changed: (worktrees: Worktree[]) => changes.push(worktrees), failed: () => undefined });
  git(repo, 'symbolic-ref', 'HEAD', 'refs/heads/other');
  hooks.unnamed?.();
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(changes.at(-1)?.[0]?.branch).toBe('other');
});
