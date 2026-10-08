import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addWorktree, git, makeRepo } from '../../../test/support/daemon-host.js';
import type { Worktree } from '../../protocol/index.js';
import { listWorktrees, removeWorktree, worktreeRisks } from './index.js';

let root: string;
let repo: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'wtd-git-')));
  repo = makeRepo(join(root, 'repo'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Gives `repo` a bare `origin` holding its `main`, with `origin/HEAD` pointing at it. */
const withOrigin = (): void => {
  const origin = join(root, 'origin.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'remote', 'set-head', 'origin', 'main');
};

const commit = (cwd: string, file: string): void => {
  writeFileSync(join(cwd, file), file);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', file);
};

/** The listed worktree at `path`. */
const listed = async (path: string): Promise<Worktree> => {
  const found = (await listWorktrees(repo)).find((w) => w.path === path);
  if (found === undefined) throw new Error(`${path} is not listed`);
  return found;
};

describe('worktreeRisks', () => {
  it('reports no base and unknown commits without an origin', async () => {
    const wt = addWorktree(repo, join(root, 'wt'), 'feat');
    expect(await worktreeRisks(repo, await listed(wt))).toEqual({ base: null, ahead: null, changes: 0 });
  });

  it('counts the commits not in origin/main, which origin/HEAD names', async () => {
    withOrigin();
    const wt = addWorktree(repo, join(root, 'wt'), 'feat');
    expect(await worktreeRisks(repo, await listed(wt))).toEqual({ base: 'origin/main', ahead: 0, changes: 0 });
    commit(wt, 'a');
    commit(wt, 'b');
    expect(await worktreeRisks(repo, await listed(wt))).toEqual({ base: 'origin/main', ahead: 2, changes: 0 });
  });

  it('falls back to origin/main without origin/HEAD', async () => {
    withOrigin();
    git(repo, 'remote', 'set-head', 'origin', '--delete');
    const wt = addWorktree(repo, join(root, 'wt'), 'feat');
    commit(wt, 'a');
    expect((await worktreeRisks(repo, await listed(wt))).base).toBe('origin/main');
    expect((await worktreeRisks(repo, await listed(wt))).ahead).toBe(1);
  });

  it('falls back to origin/main when origin/HEAD names a missing ref', async () => {
    withOrigin();
    git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/gone');
    const wt = addWorktree(repo, join(root, 'wt'), 'feat');
    commit(wt, 'a');
    expect(await worktreeRisks(repo, await listed(wt))).toEqual({ base: 'origin/main', ahead: 1, changes: 0 });
  });

  it('finds nothing ahead once the branch is merged into origin/main', async () => {
    withOrigin();
    const wt = addWorktree(repo, join(root, 'wt'), 'feat');
    commit(wt, 'a');
    git(wt, 'push', '-q', 'origin', 'feat:main');
    expect((await worktreeRisks(repo, await listed(wt))).ahead).toBe(0);
  });

  it('fetches origin/main first, so a branch merged on the remote since the last fetch counts as merged', async () => {
    withOrigin();
    const stale = git(repo, 'rev-parse', 'refs/remotes/origin/main');
    const wt = addWorktree(repo, join(root, 'wt'), 'feat');
    commit(wt, 'a');
    git(wt, 'push', '-q', 'origin', 'feat:main');
    // As if the merge happened elsewhere: the local origin/main has not seen it.
    git(repo, 'update-ref', 'refs/remotes/origin/main', stale);
    expect((await worktreeRisks(repo, await listed(wt))).ahead).toBe(0);
    expect(git(repo, 'rev-parse', 'refs/remotes/origin/main')).toBe(git(wt, 'rev-parse', 'HEAD'));
  });

  it('compares with the local origin/main when the remote cannot be reached', async () => {
    withOrigin();
    const wt = addWorktree(repo, join(root, 'wt'), 'feat');
    commit(wt, 'a');
    rmSync(join(root, 'origin.git'), { recursive: true });
    expect(await worktreeRisks(repo, await listed(wt))).toEqual({ base: 'origin/main', ahead: 1, changes: 0 });
  });

  it('counts modified and untracked files but not ignored ones', async () => {
    withOrigin();
    const wt = addWorktree(repo, join(root, 'wt'), 'feat');
    commit(wt, 'tracked');
    writeFileSync(join(wt, '.gitignore'), 'ignored\n');
    git(wt, 'add', '.gitignore');
    git(wt, 'commit', '-q', '-m', 'ignore');
    writeFileSync(join(wt, 'tracked'), 'changed');
    writeFileSync(join(wt, 'untracked'), 'new');
    writeFileSync(join(wt, 'ignored'), 'skip');
    expect((await worktreeRisks(repo, await listed(wt))).changes).toBe(2);
  });

  it('counts commits made after the worktree was listed', async () => {
    withOrigin();
    const wt = addWorktree(repo, join(root, 'wt'), 'feat');
    const cached = await listed(wt);
    commit(wt, 'a');
    expect((await worktreeRisks(repo, cached)).ahead).toBe(1);
  });

  it('reports no changes for a worktree whose directory is gone', async () => {
    withOrigin();
    const wt = addWorktree(repo, join(root, 'wt'), 'feat');
    rmSync(wt, { recursive: true });
    expect(await worktreeRisks(repo, await listed(wt))).toEqual({ base: 'origin/main', ahead: 0, changes: 0 });
  });
});

describe('removeWorktree', () => {
  it('removes a clean worktree and keeps its branch', async () => {
    const wt = addWorktree(repo, join(root, 'wt'), 'feat');
    await removeWorktree(repo, await listed(wt), false);
    expect(existsSync(wt)).toBe(false);
    expect((await listWorktrees(repo)).map((w) => w.path)).toEqual([repo]);
    expect(git(repo, 'branch', '--list', 'feat')).toContain('feat');
  });

  it('refuses a worktree with changes unless forced', async () => {
    const wt = addWorktree(repo, join(root, 'wt'), 'feat');
    writeFileSync(join(wt, 'untracked'), 'new');
    const changed = await listed(wt);
    await expect(removeWorktree(repo, changed, false)).rejects.toThrow();
    expect(existsSync(wt)).toBe(true);
    await removeWorktree(repo, await listed(wt), true);
    expect(existsSync(wt)).toBe(false);
  });

  it('prunes a worktree whose directory is gone', async () => {
    const wt = addWorktree(repo, join(root, 'wt'), 'feat');
    rmSync(wt, { recursive: true });
    const gone = await listed(wt);
    expect(gone.prunable).toBe(true);
    await removeWorktree(repo, gone, false);
    expect((await listWorktrees(repo)).map((w) => w.path)).toEqual([repo]);
  });

  it('prunes a worktree whose directory went after it was listed', async () => {
    const wt = addWorktree(repo, join(root, 'wt'), 'feat');
    const cached = await listed(wt);
    rmSync(wt, { recursive: true });
    expect(cached.prunable).toBe(false);
    await removeWorktree(repo, cached, false);
    expect((await listWorktrees(repo)).map((w) => w.path)).toEqual([repo]);
  });
});
