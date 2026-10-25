import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addWorktree, extOrigin, failingOrigin, git, makeRepo } from '../../../test/support/daemon-host.js';
import type { Worktree } from '../../protocol/index.js';
import { fetchFailureReason } from './git.js';
import { listWorktrees, removeWorktree, worktreeRisks, type WorktreeRisks } from './index.js';

let root: string;
let repo: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'wtd-git-')));
  repo = makeRepo(join(root, 'repo'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Gives `repo` a bare `origin` holding its `main`, with `origin/HEAD` pointing at it; returns the origin's path. */
const withOrigin = (): string => {
  const origin = join(root, 'origin.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'remote', 'set-head', 'origin', 'main');
  return origin;
};

/** Commits a new file and returns the commit. */
const commit = (cwd: string, file: string): string => {
  writeFileSync(join(cwd, file), file);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', file);
  return git(cwd, 'rev-parse', 'HEAD');
};

/** The listed worktree at `path`. */
const listed = async (path: string): Promise<Worktree> => {
  const found = (await listWorktrees(repo)).find((w) => w.path === path);
  if (found === undefined) throw new Error(`${path} is not listed`);
  return found;
};

const risksOf = async (path: string, fetchMs?: number): Promise<WorktreeRisks> => worktreeRisks(repo, await listed(path), fetchMs);

/** Moves the local `main`, checked out in `repo`, forward to `commit`. */
const mergeIntoMain = (commit: string): void => {
  git(repo, 'merge', '-q', '--ff-only', commit);
};

/** Points `origin/main` at `commit`, as if last fetched there. */
const setOriginMain = (commit: string): void => {
  git(repo, 'update-ref', 'refs/remotes/origin/main', commit);
};

const NOTHING_AHEAD: WorktreeRisks = { local: 'main', remote: 'origin/main', ahead: 0, fetchFailed: null, changes: 0 };
const NOT_A_REPO = (path: string): string => `fatal: '${path}' does not appear to be a git repository`;

describe('worktreeRisks: bases', () => {
  it('reports no base, whether or not the worktree has a head, in a repo without origin, main or master', async () => {
    git(repo, 'branch', '-m', 'main', 'trunk');
    const wt = addWorktree(repo, join(root, 'wt'), 'feat');
    git(repo, 'worktree', 'add', '-q', '--orphan', '-b', 'empty', join(root, 'empty'));
    const none: WorktreeRisks = { local: null, remote: null, ahead: null, fetchFailed: null, changes: 0 };
    expect(await risksOf(wt)).toEqual(none);
    expect(await risksOf(realpathSync(join(root, 'empty')))).toEqual(none);
  });

  it('compares with the local main alone without an origin', async () => {
    const wt = addWorktree(repo, join(root, 'wt'), 'feat');
    expect(await risksOf(wt)).toEqual({ ...NOTHING_AHEAD, remote: null });
  });

  it('compares with main and origin/main, which origin/HEAD names', async () => {
    withOrigin();
    const wt = addWorktree(repo, join(root, 'wt'), 'feat');
    expect(await risksOf(wt)).toEqual(NOTHING_AHEAD);
  });

  it("takes the default branch from origin/HEAD's target before main", async () => {
    const origin = withOrigin();
    git(repo, 'branch', 'develop');
    git(repo, 'push', '-q', 'origin', 'develop');
    git(repo, 'remote', 'set-head', 'origin', 'develop');
    const wt = addWorktree(repo, join(root, 'wt'), 'feat');
    mergeIntoMain(commit(wt, 'a'));
    rmSync(origin, { recursive: true });
    expect(await risksOf(wt)).toEqual({
      local: 'develop',
      remote: 'origin/develop',
      ahead: 1,
      fetchFailed: { ref: 'origin/develop', reason: NOT_A_REPO(origin) },
      changes: 0,
    });
  });

  const withoutOriginHead: readonly (readonly [string, () => void])[] = [
    ['is absent', () => undefined],
    ['names a missing ref', () => git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/gone')],
  ];

  describe.each(withoutOriginHead)('when origin/HEAD %s', (_name, originHead) => {
    it('falls back to a local master alone', async () => {
      git(repo, 'branch', '-m', 'main', 'master');
      originHead();
      const wt = addWorktree(repo, join(root, 'wt'), 'feat');
      expect(await risksOf(wt)).toEqual({ ...NOTHING_AHEAD, local: 'master', remote: null });
    });

    it('falls back to origin/main alone', async () => {
      withOrigin();
      git(repo, 'remote', 'set-head', 'origin', '--delete');
      originHead();
      git(repo, 'branch', '-m', 'main', 'trunk');
      const wt = addWorktree(repo, join(root, 'wt'), 'feat');
      expect(await risksOf(wt)).toEqual({ ...NOTHING_AHEAD, local: null });
    });

    it('prefers main to master', async () => {
      git(repo, 'branch', 'master');
      originHead();
      const wt = addWorktree(repo, join(root, 'wt'), 'feat');
      expect(await risksOf(wt)).toEqual({ ...NOTHING_AHEAD, remote: null });
    });
  });
});

describe('worktreeRisks: counting', () => {
  it('finds nothing ahead for a commit only in the local main, without trying the remote', async () => {
    withOrigin();
    const wt = addWorktree(repo, join(root, 'wt'), 'feat');
    mergeIntoMain(commit(wt, 'a'));
    const reached = failingOrigin(repo, root);
    expect(await risksOf(wt)).toEqual(NOTHING_AHEAD);
    expect(reached()).toBe(false);
  });

  it('finds nothing ahead for a commit only in origin/main as last fetched, without trying the remote', async () => {
    withOrigin();
    const wt = addWorktree(repo, join(root, 'wt'), 'feat');
    setOriginMain(commit(wt, 'a'));
    const reached = failingOrigin(repo, root);
    expect(await risksOf(wt)).toEqual(NOTHING_AHEAD);
    expect(reached()).toBe(false);
  });

  it('counts the commits in neither main nor origin/main', async () => {
    withOrigin();
    const wt = addWorktree(repo, join(root, 'wt'), 'feat');
    commit(wt, 'a');
    commit(wt, 'b');
    expect(await risksOf(wt)).toEqual({ ...NOTHING_AHEAD, ahead: 2 });
  });

  it('counts only the merge of a commit in main and a commit in origin/main', async () => {
    const origin = withOrigin();
    const wt = addWorktree(repo, join(root, 'wt'), 'feat');
    const other = addWorktree(repo, join(root, 'other'), 'other');
    const a = commit(wt, 'a');
    const b = commit(other, 'b');
    git(wt, 'merge', '-q', '--no-ff', '-m', 'merge', 'other');
    mergeIntoMain(a);
    setOriginMain(b);
    rmSync(origin, { recursive: true });
    expect(await risksOf(wt)).toMatchObject({ local: 'main', remote: 'origin/main', ahead: 1 });
  });

  it('finds nothing ahead for a worktree without a head, without trying the remote', async () => {
    withOrigin();
    const reached = failingOrigin(repo, root);
    git(repo, 'worktree', 'add', '-q', '--orphan', '-b', 'empty', join(root, 'empty'));
    expect(await risksOf(realpathSync(join(root, 'empty')))).toEqual(NOTHING_AHEAD);
    expect(reached()).toBe(false);
  });

  it('counts commits made after the worktree was listed', async () => {
    withOrigin();
    const wt = addWorktree(repo, join(root, 'wt'), 'feat');
    const cached = await listed(wt);
    commit(wt, 'a');
    expect((await worktreeRisks(repo, cached)).ahead).toBe(1);
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
    expect((await risksOf(wt)).changes).toBe(2);
  });

  it('reports no changes for a worktree whose directory is gone', async () => {
    withOrigin();
    const wt = addWorktree(repo, join(root, 'wt'), 'feat');
    rmSync(wt, { recursive: true });
    expect(await risksOf(wt)).toEqual(NOTHING_AHEAD);
  });
});

describe('worktreeRisks: fetching', () => {
  it('fetches main, so a branch merged on the remote since the last fetch counts as merged', async () => {
    withOrigin();
    const stale = git(repo, 'rev-parse', 'refs/remotes/origin/main');
    const wt = addWorktree(repo, join(root, 'wt'), 'feat');
    const head = commit(wt, 'a');
    git(wt, 'push', '-q', 'origin', 'feat:main');
    setOriginMain(stale);
    expect(await risksOf(wt)).toEqual(NOTHING_AHEAD);
    expect(git(repo, 'rev-parse', 'refs/remotes/origin/main')).toBe(head);
  });

  it("updates origin/main when origin's fetch refspec does not map main", async () => {
    withOrigin();
    git(repo, 'config', 'remote.origin.fetch', '+refs/heads/other:refs/remotes/origin/other');
    const stale = git(repo, 'rev-parse', 'refs/remotes/origin/main');
    const wt = addWorktree(repo, join(root, 'wt'), 'feat');
    const head = commit(wt, 'a');
    git(wt, 'push', '-q', 'origin', 'feat:main');
    setOriginMain(stale);
    expect(await risksOf(wt)).toEqual(NOTHING_AHEAD);
    expect(git(repo, 'rev-parse', 'refs/remotes/origin/main')).toBe(head);
  });

  it("reports a failed fetch with git's reason, keeping the counts from before it", async () => {
    const origin = withOrigin();
    const wt = addWorktree(repo, join(root, 'wt'), 'feat');
    commit(wt, 'a');
    rmSync(origin, { recursive: true });
    expect(await risksOf(wt)).toEqual({
      ...NOTHING_AHEAD,
      ahead: 1,
      fetchFailed: { ref: 'origin/main', reason: NOT_A_REPO(origin) },
    });
  });

  it('reports a failed fetch from an origin whose URL is not a repository', async () => {
    const nowhere = join(root, 'nowhere');
    git(repo, 'remote', 'add', 'origin', nowhere);
    const wt = addWorktree(repo, join(root, 'wt'), 'feat');
    commit(wt, 'a');
    expect(await risksOf(wt)).toEqual({
      ...NOTHING_AHEAD,
      remote: null,
      ahead: 1,
      fetchFailed: { ref: 'origin/main', reason: NOT_A_REPO(nowhere) },
    });
  });

  it('updates origin/main to a force-pushed main', async () => {
    withOrigin();
    const old = addWorktree(repo, join(root, 'old'), 'old');
    git(old, 'push', '-q', 'origin', `${commit(old, 'x')}:refs/heads/main`);
    git(repo, 'fetch', '-q', 'origin');
    const wt = addWorktree(repo, join(root, 'wt'), 'feat');
    const head = commit(wt, 'a');
    git(wt, 'push', '-q', '--force', 'origin', 'feat:main');
    expect(await risksOf(wt)).toEqual(NOTHING_AHEAD);
    expect(git(repo, 'rev-parse', 'refs/remotes/origin/main')).toBe(head);
  });

  it('reports origin/main missing after a fetch that succeeded without it', async () => {
    git(repo, 'remote', 'add', 'origin', join(root, 'nowhere'));
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'git'),
      `#!/bin/sh\nfor a; do [ "$a" = fetch ] && exit 0; done\nPATH='${process.env['PATH'] ?? ''}' exec git "$@"\n`,
      { mode: 0o755 },
    );
    const wt = addWorktree(repo, join(root, 'wt'), 'feat');
    commit(wt, 'a');
    vi.stubEnv('PATH', `${bin}:${process.env['PATH'] ?? ''}`);
    try {
      expect(await risksOf(wt)).toEqual({
        ...NOTHING_AHEAD,
        remote: null,
        ahead: 1,
        fetchFailed: { ref: 'origin/main', reason: 'origin/main is missing after the fetch' },
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('fetches without prompting for credentials', async () => {
    withOrigin();
    const seen = join(root, 'env');
    extOrigin(repo, root, `echo "$GIT_TERMINAL_PROMPT $SSH_ASKPASS_REQUIRE" > '${seen}'; exit 1`);
    const wt = addWorktree(repo, join(root, 'wt'), 'feat');
    commit(wt, 'a');
    await risksOf(wt);
    expect(readFileSync(seen, 'utf8')).toBe('0 never\n');
  });

  it('fetches nothing without an origin', async () => {
    const wt = addWorktree(repo, join(root, 'wt'), 'feat');
    commit(wt, 'a');
    expect(await risksOf(wt)).toEqual({ ...NOTHING_AHEAD, remote: null, ahead: 1 });
  });

  it('stops a fetch that takes longer than the timeout', async () => {
    withOrigin();
    extOrigin(repo, root, 'exec sleep 10');
    const wt = addWorktree(repo, join(root, 'wt'), 'feat');
    commit(wt, 'a');
    expect(await risksOf(wt, 1000)).toEqual({
      ...NOTHING_AHEAD,
      ahead: 1,
      fetchFailed: { ref: 'origin/main', reason: 'timed out after 1 s' },
    });
  });

  it("takes git's first non-blank error line, with control characters as spaces", async () => {
    withOrigin();
    extOrigin(repo, root, String.raw`printf '\n   \n\t\nfatal: a\001b\177c\302\205d <b>x</b>\nsecond\n' >&2; exit 1`);
    const wt = addWorktree(repo, join(root, 'wt'), 'feat');
    commit(wt, 'a');
    expect((await risksOf(wt)).fetchFailed).toEqual({ ref: 'origin/main', reason: 'fatal: a b c d <b>x</b>' });
  });
});

describe('fetchFailureReason', () => {
  const failed = (message: string, fields: Record<string, unknown>): Error => Object.assign(new Error(message), fields);

  it("gives a failed git's first non-blank error line", () => {
    const error = failed('Command failed: git fetch', { code: 128, killed: false, signal: null, stderr: '\n  \nfatal: no\nmore\n' });
    expect(fetchFailureReason(error, 20_000)).toBe('fatal: no');
  });

  it('says a stopped fetch timed out', () => {
    const error = failed('Command failed: git fetch', { code: null, killed: true, signal: 'SIGTERM', stderr: '' });
    expect(fetchFailureReason(error, 20_000)).toBe('timed out after 20 s');
  });

  it('gives the message of a git killed by a signal without error output', () => {
    const error = failed('Command failed: git fetch', { code: null, killed: false, signal: 'SIGKILL', stderr: '' });
    expect(fetchFailureReason(error, 20_000)).toBe('Command failed: git fetch');
  });

  it('gives the message of a git that could not start', () => {
    const error = failed('spawn git ENOENT', { code: 'ENOENT', errno: -2, syscall: 'spawn git', path: 'git' });
    expect(fetchFailureReason(error, 20_000)).toBe('spawn git ENOENT');
  });

  it('cuts the reason to 1024 characters', () => {
    const error = failed('Command failed: git fetch', { code: 128, killed: false, signal: null, stderr: `${'x'.repeat(2000)}\n` });
    expect(fetchFailureReason(error, 20_000)).toBe('x'.repeat(1024));
  });

  it('rethrows what is not a process failure', () => {
    const bug = new TypeError('bug');
    expect(() => fetchFailureReason(bug, 20_000)).toThrow(bug);
    expect(() => fetchFailureReason('bug', 20_000)).toThrow();
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

  it('removes a worktree whose directory is gone, leaving other missing worktrees registered', async () => {
    const wt = addWorktree(repo, join(root, 'wt'), 'feat');
    const other = addWorktree(repo, join(root, 'other'), 'other');
    rmSync(wt, { recursive: true });
    rmSync(other, { recursive: true });
    const gone = await listed(wt);
    expect(gone.prunable).toBe(true);
    await removeWorktree(repo, gone, false);
    expect((await listWorktrees(repo)).map((w) => w.path)).toEqual([repo, other]);
  });

  it('removes a worktree whose directory went after it was listed', async () => {
    const wt = addWorktree(repo, join(root, 'wt'), 'feat');
    const cached = await listed(wt);
    rmSync(wt, { recursive: true });
    expect(cached.prunable).toBe(false);
    await removeWorktree(repo, cached, false);
    expect((await listWorktrees(repo)).map((w) => w.path)).toEqual([repo]);
  });
});
