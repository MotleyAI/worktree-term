import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Worktree } from '../../protocol/index.js';
import { watchWorktrees, type WorktreeWatch } from './index.js';

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

const git = (cwd: string, ...args: string[]): void => {
  execFileSync('git', args, { cwd, env: GIT_ENV, stdio: 'ignore' });
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let dir: string;
let repo: string;
let watch: WorktreeWatch | undefined;
let events: { at: number; worktrees: Worktree[] }[];
let failures: Error[];

/** The marker file `git worktree lock` creates for worktree `wt`. */
const lockFile = (): string => join(repo, '.git', 'worktrees', 'wt', 'locked');

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'wtd-watch-')));
  repo = join(dir, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(repo, 'worktree', 'add', '-q', '-b', 'wt', join(dir, 'wt'));
  events = [];
  failures = [];
  watch = await watchWorktrees(repo, {
    changed: (worktrees: Worktree[]) => events.push({ at: Date.now(), worktrees }),
    failed: (error: Error) => failures.push(error),
  });
});

afterEach(() => {
  watch?.close();
  rmSync(dir, { recursive: true, force: true });
});

const lockedOf = (worktrees: readonly Worktree[]): boolean | undefined => worktrees.find((w) => w.path === join(dir, 'wt'))?.locked;

describe('watchWorktrees', () => {
  it('lists the worktrees when watching starts', () => {
    expect(watch?.worktrees.map((w: Worktree) => w.path)).toEqual([repo, join(dir, 'wt')]);
  });

  it('reports a change once, at least 100 ms after it happened', async () => {
    const changedAt = Date.now();
    writeFileSync(lockFile(), '');
    await sleep(600);
    expect(events).toHaveLength(1);
    expect(lockedOf(events[0]?.worktrees ?? [])).toBe(true);
    expect((events[0]?.at ?? 0) - changedAt).toBeGreaterThanOrEqual(95);
    expect(lockedOf(watch?.worktrees ?? [])).toBe(true);
  });

  it('reports nothing for a change undone within the debounce window', async () => {
    writeFileSync(lockFile(), '');
    await sleep(20);
    unlinkSync(lockFile());
    await sleep(600);
    expect(events).toEqual([]);
  });

  it('waits for 100 ms of quiet after a burst before reporting once', async () => {
    let lastAt = 0;
    for (let i = 0; i < 9; i++) {
      if (i % 2 === 0) writeFileSync(lockFile(), '');
      else unlinkSync(lockFile());
      lastAt = Date.now();
      await sleep(50);
    }
    await sleep(600);
    expect(events).toHaveLength(1);
    expect(lockedOf(events[0]?.worktrees ?? [])).toBe(true);
    expect((events[0]?.at ?? 0) - lastAt).toBeGreaterThanOrEqual(95);
  });

  it('stops reporting once closed', async () => {
    watch?.close();
    writeFileSync(lockFile(), '');
    await sleep(400);
    expect(events).toEqual([]);
    expect(failures).toEqual([]);
  });
});
