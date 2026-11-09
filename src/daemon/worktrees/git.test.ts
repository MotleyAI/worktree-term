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

const DEFAULT_PAIR = ['main', 'origin/main'];
const FOUR = ['feature-x', 'origin/feature-x', 'main', 'origin/main'];
const NOTHING_AHEAD: WorktreeRisks = { bases: DEFAULT_PAIR, ahead: 0, fetchFailed: [], changes: 0 };
const NOT_A_REPO = (path: string): string => `fatal: '${path}' does not appear to be a git repository`;

/** Runs `body` with a `git` first on PATH that runs the shell code `onMatch` when an argument is `word`, and git otherwise. */
const withGitAs = async (word: string, onMatch: string, body: () => Promise<void>): Promise<void> => {
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'git'),
    `#!/bin/sh\nPATH='${process.env['PATH'] ?? ''}'\nexport PATH\nfor a; do [ "$a" = ${word} ] && { ${onMatch}\nexit; }; done\nexec git "$@"\n`,
    { mode: 0o755 },
  );
  vi.stubEnv('PATH', `${bin}:${process.env['PATH'] ?? ''}`);
  try {
    await body();
  } finally {
    vi.unstubAllEnvs();
  }
};

describe('worktreeRisks: bases', () => {
  it('reports no base, whether or not the worktree has a head, in a repo without origin, main or master', async () => {
    git(repo, 'branch', '-m', 'main', 'trunk');
    const wt = addWorktree(repo, join(root, 'wt'), 'feat');
    git(repo, 'worktree', 'add', '-q', '--orphan', '-b', 'empty', join(root, 'empty'));
    const none: WorktreeRisks = { bases: [], ahead: null, fetchFailed: [], changes: 0 };
    expect(await risksOf(wt)).toEqual(none);
    expect(await risksOf(realpathSync(join(root, 'empty')))).toEqual(none);
  });

  it('compares with the local main alone without an origin', async () => {
    const wt = addWorktree(repo, join(root, 'wt'), 'feat');
    expect(await risksOf(wt)).toEqual({ ...NOTHING_AHEAD, bases: ['main'] });
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
      bases: ['develop', 'origin/develop'],
      ahead: 1,
      fetchFailed: [{ ref: 'origin/develop', reason: NOT_A_REPO(origin) }],
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
      expect(await risksOf(wt)).toEqual({ ...NOTHING_AHEAD, bases: ['master'] });
    });

    it('falls back to origin/main alone', async () => {
      withOrigin();
      git(repo, 'remote', 'set-head', 'origin', '--delete');
      originHead();
      git(repo, 'branch', '-m', 'main', 'trunk');
      const wt = addWorktree(repo, join(root, 'wt'), 'feat');
      expect(await risksOf(wt)).toEqual({ ...NOTHING_AHEAD, bases: ['origin/main'] });
    });

    it('prefers main to master', async () => {
      git(repo, 'branch', 'master');
      originHead();
      const wt = addWorktree(repo, join(root, 'wt'), 'feat');
      expect(await risksOf(wt)).toEqual({ ...NOTHING_AHEAD, bases: ['main'] });
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
    expect(await risksOf(wt)).toMatchObject({ bases: DEFAULT_PAIR, ahead: 1 });
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

  it('counts a change made while main is being fetched', async () => {
    withOrigin();
    const wt = addWorktree(repo, join(root, 'wt'), 'feat');
    commit(wt, 'a');
    extOrigin(repo, root, `echo new > '${join(wt, 'during-fetch')}'; exit 1`);
    expect((await risksOf(wt)).changes).toBe(1);
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

  it('counts a commit of a detached worktree made while main is being fetched', async () => {
    withOrigin();
    const stale = git(repo, 'rev-parse', 'refs/remotes/origin/main');
    const wt = addWorktree(repo, join(root, 'wt'), 'feat');
    const merged = commit(wt, 'a');
    git(wt, 'checkout', '-q', '--detach');
    git(wt, 'push', '-q', 'origin', `${merged}:refs/heads/main`);
    setOriginMain(stale);
    const commitB = `cd '${wt}' && echo b > b && git add b && git -c user.name=t -c user.email=t@t commit -q -m b`;
    await withGitAs('fetch', `git "$@" || exit\n${commitB}`, async () => {
      expect(await risksOf(wt)).toEqual({ ...NOTHING_AHEAD, ahead: 1 });
    });
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

  it("reports a failed fetch with git's reason", async () => {
    const origin = withOrigin();
    const wt = addWorktree(repo, join(root, 'wt'), 'feat');
    commit(wt, 'a');
    rmSync(origin, { recursive: true });
    expect(await risksOf(wt)).toEqual({
      ...NOTHING_AHEAD,
      ahead: 1,
      fetchFailed: [{ ref: 'origin/main', reason: NOT_A_REPO(origin) }],
    });
  });

  it('reports a failed fetch from an origin whose URL is not a repository', async () => {
    const nowhere = join(root, 'nowhere');
    git(repo, 'remote', 'add', 'origin', nowhere);
    const wt = addWorktree(repo, join(root, 'wt'), 'feat');
    commit(wt, 'a');
    expect(await risksOf(wt)).toEqual({
      ...NOTHING_AHEAD,
      bases: ['main'],
      ahead: 1,
      fetchFailed: [{ ref: 'origin/main', reason: NOT_A_REPO(nowhere) }],
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
    const wt = addWorktree(repo, join(root, 'wt'), 'feat');
    commit(wt, 'a');
    await withGitAs('fetch', 'exit 0', async () => {
      expect(await risksOf(wt)).toEqual({
        ...NOTHING_AHEAD,
        bases: ['main'],
        ahead: 1,
        fetchFailed: [{ ref: 'origin/main', reason: 'origin/main is missing after the fetch' }],
      });
    });
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
    expect(await risksOf(wt)).toEqual({ ...NOTHING_AHEAD, bases: ['main'], ahead: 1 });
  });

  it('stops a fetch that takes longer than the timeout', async () => {
    withOrigin();
    extOrigin(repo, root, 'exec sleep 10');
    const wt = addWorktree(repo, join(root, 'wt'), 'feat');
    commit(wt, 'a');
    expect(await risksOf(wt, 1000)).toEqual({
      ...NOTHING_AHEAD,
      ahead: 1,
      fetchFailed: [{ ref: 'origin/main', reason: 'timed out after 1 s' }],
    });
  });

  it("takes git's first non-blank error line, with control characters as spaces", async () => {
    withOrigin();
    extOrigin(repo, root, String.raw`printf '\n   \n\t\nfatal: a\001b\177c\302\205d <b>x</b>\nsecond\n' >&2; exit 1`);
    const wt = addWorktree(repo, join(root, 'wt'), 'feat');
    commit(wt, 'a');
    expect((await risksOf(wt)).fetchFailed).toEqual([{ ref: 'origin/main', reason: 'fatal: a b c d <b>x</b>' }]);
  });
});

/** Adds the worktree `wt` on a new branch `branch` created from `start`; returns its real path. */
const branchFrom = (start: string, branch = 'feat'): string => {
  git(repo, 'worktree', 'add', '-q', '-b', branch, join(root, 'wt'), start);
  return realpathSync(join(root, 'wt'));
};

/** Creates `feature-x` at `main`, also on `origin` when `pushed`. */
const featureX = (pushed: boolean): void => {
  git(repo, 'branch', 'feature-x');
  if (pushed) git(repo, 'push', '-q', 'origin', 'feature-x');
};

const basesOf = async (path: string): Promise<readonly string[]> => (await risksOf(path)).bases;

describe('worktreeRisks: base branch', () => {
  it('takes the branch it was created from as its base', async () => {
    featureX(false);
    const wt = branchFrom('feature-x');
    expect(await basesOf(wt)).toEqual(['feature-x', 'main']);
  });

  it('takes a base that exists only as origin/<base>', async () => {
    withOrigin();
    featureX(true);
    git(repo, 'branch', '-D', 'feature-x');
    const wt = branchFrom('origin/feature-x');
    expect(await basesOf(wt)).toEqual(['origin/feature-x', 'main', 'origin/main']);
  });

  it.each([
    ['.', false],
    ['origin', true],
  ])('takes the upstream on %s before the branch it was created from', async (remote, pushed) => {
    withOrigin();
    featureX(pushed);
    const wt = branchFrom('main');
    git(repo, 'config', 'branch.feat.remote', remote);
    git(repo, 'config', 'branch.feat.merge', 'refs/heads/feature-x');
    git(repo, 'branch', '-f', 'feature-x', commit(wt, 'a'));
    const reached = failingOrigin(repo, root);
    expect(await risksOf(wt)).toEqual({ ...NOTHING_AHEAD, bases: pushed ? FOUR : ['feature-x', 'main', 'origin/main'] });
    expect(reached()).toBe(false);
  });

  const unusableUpstreams: readonly (readonly [string, () => void])[] = [
    [
      'its own branch on origin',
      () => {
        git(repo, 'config', 'branch.feat.remote', 'origin');
        git(repo, 'config', 'branch.feat.merge', 'refs/heads/feat');
      },
    ],
    [
      'a branch on a remote other than origin',
      () => {
        git(repo, 'branch', 'feature-y');
        git(repo, 'remote', 'add', 'upstream', join(root, 'nowhere'));
        git(repo, 'config', 'branch.feat.remote', 'upstream');
        git(repo, 'config', 'branch.feat.merge', 'refs/heads/feature-y');
      },
    ],
    [
      'two merge values',
      () => {
        git(repo, 'branch', 'feature-y');
        git(repo, 'branch', 'feature-z');
        git(repo, 'config', 'branch.feat.remote', '.');
        git(repo, 'config', '--add', 'branch.feat.merge', 'refs/heads/feature-y');
        git(repo, 'config', '--add', 'branch.feat.merge', 'refs/heads/feature-z');
      },
    ],
  ];

  it.each(unusableUpstreams)('ignores an upstream that is %s', async (_name, upstream) => {
    featureX(false);
    const wt = branchFrom('feature-x');
    upstream();
    expect(await basesOf(wt)).toEqual(['feature-x', 'main']);
  });

  const notBranches: readonly (readonly [string, () => string])[] = [
    ['HEAD', () => 'HEAD'],
    [
      'HEAD~1',
      () => {
        git(repo, 'commit', '-q', '--allow-empty', '-m', 'second');
        return 'HEAD~1';
      },
    ],
    ['a commit id', () => git(repo, 'rev-parse', 'HEAD')],
    [
      'a tag',
      () => {
        git(repo, 'tag', 'v1');
        return 'v1';
      },
    ],
    [
      'another remote’s branch',
      () => {
        git(root, 'init', '-q', '--bare', '-b', 'main', join(root, 'up.git'));
        git(repo, 'remote', 'add', 'upstream', join(root, 'up.git'));
        git(repo, 'push', '-q', 'upstream', 'main');
        return 'upstream/main';
      },
    ],
  ];

  it.each(notBranches)('finds no base for a branch created from %s', async (_name, start) => {
    const wt = branchFrom(start());
    expect(await basesOf(wt)).toEqual(['main']);
  });

  it('finds no base for a branch created from a tag that also names a branch', async () => {
    git(repo, 'tag', 'v1');
    const wt = branchFrom('v1');
    git(repo, 'branch', 'v1');
    expect(await basesOf(wt)).toEqual(['main']);
  });

  it('finds no base for a branch without a reflog', async () => {
    featureX(false);
    git(repo, '-c', 'core.logAllRefUpdates=false', 'worktree', 'add', '-q', '-b', 'feat', join(root, 'wt'), 'feature-x');
    expect(git(repo, 'reflog', 'show', '--format=%gs', 'refs/heads/feat')).toBe('');
    expect(await basesOf(realpathSync(join(root, 'wt')))).toEqual(['main']);
  });

  it('finds no base once the creation entry has expired', async () => {
    featureX(false);
    const wt = branchFrom('feature-x');
    git(repo, 'reflog', 'expire', '--expire=all', 'refs/heads/feat');
    expect(await basesOf(wt)).toEqual(['main']);
  });

  it('finds no base when the oldest surviving entry is not the creation', async () => {
    featureX(false);
    const wt = branchFrom('feature-x');
    commit(wt, 'a');
    git(repo, 'reflog', 'delete', 'refs/heads/feat@{1}');
    expect(git(repo, 'reflog', 'show', '--format=%gs', 'refs/heads/feat')).toBe('commit: a');
    expect(await basesOf(wt)).toEqual(['main']);
  });

  it('falls through a vanished upstream to the branch it was created from, then to none', async () => {
    featureX(false);
    git(repo, 'branch', 'feature-y');
    const wt = branchFrom('feature-x');
    git(repo, 'branch', '--set-upstream-to=feature-y', 'feat');
    git(repo, 'branch', '-D', 'feature-y');
    expect(await basesOf(wt)).toEqual(['feature-x', 'main']);
    git(repo, 'branch', '-D', 'feature-x');
    expect(await basesOf(wt)).toEqual(['main']);
  });

  it.each([
    ['created from', () => branchFrom('release/1.2', 'egor/feat.2')],
    [
      'tracking',
      () => {
        const wt = branchFrom('main', 'egor/feat.2');
        git(repo, 'branch', '--set-upstream-to=release/1.2', 'egor/feat.2');
        return wt;
      },
    ],
  ])('finds the base of a branch with slashes and dots %s one', async (_name, add) => {
    git(repo, 'branch', 'release/1.2');
    expect(await basesOf(add())).toEqual(['release/1.2', 'main']);
  });

  it('compares a detached worktree with the default branch only', async () => {
    const origin = withOrigin();
    featureX(true);
    const wt = branchFrom('feature-x');
    git(wt, 'checkout', '-q', '--detach');
    commit(wt, 'a');
    rmSync(origin, { recursive: true });
    expect(await risksOf(wt)).toEqual({
      ...NOTHING_AHEAD,
      ahead: 1,
      fetchFailed: [{ ref: 'origin/main', reason: NOT_A_REPO(origin) }],
    });
  });

  it.each([
    ['reflog', 'echo "fatal: boom" >&2; exit 128'],
    ['config', 'echo "fatal: bad config" >&2; exit 3'],
  ])('rethrows a %s query that fails other than for a missing entry', async (word, onMatch) => {
    featureX(false);
    const wt = branchFrom('feature-x');
    const worktree = await listed(wt);
    await withGitAs(word, onMatch, async () => {
      await expect(worktreeRisks(repo, worktree)).rejects.toThrow();
    });
  });
});

describe('worktreeRisks: comparing with the base', () => {
  it('finds nothing ahead for commits merged into the base only, without trying the remote', async () => {
    withOrigin();
    featureX(false);
    const wt = branchFrom('feature-x');
    git(repo, 'branch', '-f', 'feature-x', commit(wt, 'a'));
    const reached = failingOrigin(repo, root);
    expect(await risksOf(wt)).toEqual({ ...NOTHING_AHEAD, bases: ['feature-x', 'main', 'origin/main'] });
    expect(reached()).toBe(false);
  });

  it('finds nothing ahead for commits in origin/<base> as last fetched only', async () => {
    withOrigin();
    featureX(true);
    const wt = branchFrom('feature-x');
    git(repo, 'update-ref', 'refs/remotes/origin/feature-x', commit(wt, 'a'));
    const reached = failingOrigin(repo, root);
    expect(await risksOf(wt)).toEqual({ ...NOTHING_AHEAD, bases: FOUR });
    expect(reached()).toBe(false);
  });

  it('finds nothing ahead for commits merged into main past a stale base', async () => {
    withOrigin();
    featureX(true);
    const wt = branchFrom('feature-x');
    mergeIntoMain(commit(wt, 'a'));
    const reached = failingOrigin(repo, root);
    expect(await risksOf(wt)).toEqual({ ...NOTHING_AHEAD, bases: FOUR });
    expect(reached()).toBe(false);
  });

  it('counts commits in none of the bases, naming the base first', async () => {
    const origin = withOrigin();
    featureX(true);
    const wt = branchFrom('feature-x');
    commit(wt, 'a');
    rmSync(origin, { recursive: true });
    expect(await risksOf(wt)).toEqual({
      bases: FOUR,
      ahead: 1,
      fetchFailed: [
        { ref: 'origin/feature-x', reason: NOT_A_REPO(origin) },
        { ref: 'origin/main', reason: NOT_A_REPO(origin) },
      ],
      changes: 0,
    });
  });

  it('lists the default branch once when it is the base', async () => {
    withOrigin();
    const log = join(root, 'fetches');
    extOrigin(repo, root, `echo fetch >> '${log}'; echo 'fatal: nope' >&2; exit 1`);
    const wt = branchFrom('origin/main');
    commit(wt, 'a');
    expect(await risksOf(wt)).toEqual({
      ...NOTHING_AHEAD,
      ahead: 1,
      fetchFailed: [{ ref: 'origin/main', reason: 'fatal: nope' }],
    });
    expect(readFileSync(log, 'utf8')).toBe('fetch\n');
  });

  it('finds no base and no default branch: no bases and no count', async () => {
    git(repo, 'branch', '-m', 'main', 'trunk');
    git(repo, 'branch', 'feature-x');
    const wt = branchFrom('feature-x');
    git(repo, 'branch', '-D', 'feature-x');
    expect(await risksOf(wt)).toEqual({ bases: [], ahead: null, fetchFailed: [], changes: 0 });
  });
});

describe('worktreeRisks: fetching the base', () => {
  /** Runs `body` while every fetch's arguments are appended to a log, one line each; resolves with the lines. */
  const loggingFetches = async (body: () => Promise<void>): Promise<string[]> => {
    const log = join(root, 'fetch-args');
    writeFileSync(log, '');
    await withGitAs('fetch', `echo "$*" >> '${log}'\nexec git "$@"`, body);
    return readFileSync(log, 'utf8')
      .split('\n')
      .filter((line) => line !== '');
  };

  it("fetches the base when origin's fetch refspec excludes it, so a base merged since counts", async () => {
    withOrigin();
    featureX(true);
    git(repo, 'config', 'remote.origin.fetch', '+refs/heads/other:refs/remotes/origin/other');
    const stale = git(repo, 'rev-parse', 'refs/remotes/origin/feature-x');
    const wt = branchFrom('feature-x');
    const head = commit(wt, 'a');
    git(wt, 'push', '-q', 'origin', 'feat:feature-x');
    git(repo, 'update-ref', 'refs/remotes/origin/feature-x', stale);
    expect(await risksOf(wt)).toEqual({ ...NOTHING_AHEAD, bases: FOUR });
    expect(git(repo, 'rev-parse', 'refs/remotes/origin/feature-x')).toBe(head);
  });

  it('fetches both refs isolated, with explicit refspecs', async () => {
    withOrigin();
    featureX(true);
    const wt = branchFrom('feature-x');
    commit(wt, 'a');
    const fetches = await loggingFetches(async () => {
      await risksOf(wt);
    });
    expect(fetches).toHaveLength(2);
    for (const flag of ['--no-write-fetch-head', '--no-auto-maintenance', '--no-tags'])
      expect(fetches.every((f) => f.split(' ').includes(flag))).toBe(true);
    expect(fetches.map((f) => f.split(' ').at(-1)).sort()).toEqual([
      '+refs/heads/feature-x:refs/remotes/origin/feature-x',
      '+refs/heads/main:refs/remotes/origin/main',
    ]);
  });

  it('does not fetch a base that exists only as a local branch', async () => {
    withOrigin();
    featureX(false);
    const wt = branchFrom('feature-x');
    commit(wt, 'a');
    let risks: WorktreeRisks | undefined;
    const fetches = await loggingFetches(async () => {
      risks = await risksOf(wt);
    });
    expect(risks).toEqual({ bases: ['feature-x', 'main', 'origin/main'], ahead: 1, fetchFailed: [], changes: 0 });
    expect(fetches).toHaveLength(1);
    expect(fetches[0]).not.toContain('feature-x');
  });

  it('reports only the failed base fetch, with counts from after the default fetch', async () => {
    const origin = withOrigin();
    featureX(true);
    const stale = git(repo, 'rev-parse', 'refs/remotes/origin/main');
    const wt = branchFrom('feature-x');
    git(wt, 'push', '-q', 'origin', `${commit(wt, 'a')}:refs/heads/main`);
    commit(wt, 'b');
    setOriginMain(stale);
    git(origin, 'branch', '-D', 'feature-x');
    expect(await risksOf(wt)).toEqual({
      bases: FOUR,
      ahead: 1,
      fetchFailed: [{ ref: 'origin/feature-x', reason: "fatal: couldn't find remote ref refs/heads/feature-x" }],
      changes: 0,
    });
  });

  it('reports a base missing after a fetch that succeeded without it', async () => {
    withOrigin();
    featureX(true);
    const wt = branchFrom('feature-x');
    commit(wt, 'a');
    await withGitAs(
      'fetch',
      'case "$*" in *feature-x*) git update-ref -d refs/remotes/origin/feature-x; exit 0;; esac\nexec git "$@"',
      async () => {
        expect(await risksOf(wt)).toEqual({
          bases: ['feature-x', 'main', 'origin/main'],
          ahead: 1,
          fetchFailed: [{ ref: 'origin/feature-x', reason: 'origin/feature-x is missing after the fetch' }],
          changes: 0,
        });
      },
    );
  });

  it('keeps the base chosen before the fetch', async () => {
    withOrigin();
    featureX(false);
    git(repo, 'branch', 'feature-y');
    const wt = branchFrom('main');
    git(repo, 'branch', '--set-upstream-to=feature-x', 'feat');
    commit(wt, 'a');
    await withGitAs('fetch', 'git config branch.feat.merge refs/heads/feature-y\nexec git "$@"', async () => {
      expect(await basesOf(wt)).toEqual(['feature-x', 'main', 'origin/main']);
    });
  });

  it('keeps the default branch chosen before the fetch', async () => {
    withOrigin();
    git(repo, 'branch', 'develop');
    git(repo, 'push', '-q', 'origin', 'develop');
    const wt = addWorktree(repo, join(root, 'wt'), 'feat');
    commit(wt, 'a');
    await withGitAs('fetch', 'git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/develop\nexec git "$@"', async () => {
      expect(await risksOf(wt)).toEqual({ ...NOTHING_AHEAD, ahead: 1 });
    });
  });

  it('runs both fetches at once, so both time out within one limit', async () => {
    withOrigin();
    featureX(true);
    extOrigin(repo, root, 'exec sleep 10');
    const wt = branchFrom('feature-x');
    commit(wt, 'a');
    const started = Date.now();
    expect(await risksOf(wt, 1000)).toEqual({
      bases: FOUR,
      ahead: 1,
      fetchFailed: [
        { ref: 'origin/feature-x', reason: 'timed out after 1 s' },
        { ref: 'origin/main', reason: 'timed out after 1 s' },
      ],
      changes: 0,
    });
    expect(Date.now() - started).toBeLessThan(1900);
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
