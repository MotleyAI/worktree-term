import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Worktree } from '../../protocol/index.js';
import { parsePorcelain } from './porcelain.js';

/** Most worktrees a repo may have. */
export const MAX_WORKTREES = 1024;

const MAX_OUTPUT = 64 * 1024 * 1024;

/** `path` is not the main worktree (or bare directory) of a git repository. */
export class NotARepoError extends Error {
  override readonly name = 'NotARepoError';
}

const run = promisify(execFile);

const git = async (cwd: string, args: readonly string[]): Promise<string> =>
  (await run('git', args, { cwd, encoding: 'utf8', maxBuffer: MAX_OUTPUT })).stdout;

/** The worktrees of the repo at `repo`, main first. */
export const listWorktrees = async (repo: string): Promise<Worktree[]> => {
  const worktrees = parsePorcelain(await git(repo, ['worktree', 'list', '--porcelain', '-z']));
  if (worktrees.length > MAX_WORKTREES) throw new Error(`${repo} has more than ${String(MAX_WORKTREES)} worktrees`);
  return worktrees;
};

/** The repository's common git directory. */
export const commonDir = async (repo: string): Promise<string> => {
  const dir = (await git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).replace(/\n$/, '');
  return isAbsolute(dir) ? dir : resolve(repo, dir);
};

const realOrNull = async (path: string): Promise<string | null> => {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
};

/**
 * Checks that `repo` is exactly the main worktree (or bare directory) path git lists, a real path,
 * so a repo has one name; returns its common dir.
 */
export const checkRepo = async (repo: string): Promise<string> => {
  if ((await realOrNull(repo)) === null) throw new NotARepoError(`${repo} does not exist`);
  let listing: string;
  let common: string;
  try {
    [listing, common] = await Promise.all([git(repo, ['worktree', 'list', '--porcelain', '-z']), commonDir(repo)]);
  } catch (error) {
    throw new NotARepoError(`${repo} is not a git repository`, { cause: error });
  }
  const main = parsePorcelain(listing)[0];
  if (main?.path !== repo) throw new NotARepoError(`${repo} is not a repository's main worktree path`);
  return common;
};

/** Remote-tracking refs a worktree's head is compared with, in order of preference after `origin/HEAD`. */
const BASE_CANDIDATES = ['refs/remotes/origin/main', 'refs/remotes/origin/master'];
const REMOTES_PREFIX = 'refs/remotes/';

/** What deleting a worktree would lose, apart from its terminals. */
export interface WorktreeRisks {
  /** The ref compared with, e.g. `origin/main`; null when the repo has none. */
  base: string | null;
  /** Commits of the worktree's head not in `base`; null without a base. */
  ahead: number | null;
  /** Uncommitted changes, untracked files included; 0 when its directory is gone. */
  changes: number;
}

/** The output of a `--quiet` git query, or null when it exits with 1 for a missing ref. */
const gitOrNull = async (cwd: string, args: readonly string[]): Promise<string | null> => {
  try {
    return (await git(cwd, args)).trim();
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 1) return null;
    throw error;
  }
};

/** The full name of the remote-tracking ref heads are compared with: `origin/HEAD`'s target, else origin's main or master. */
const baseRef = async (repo: string): Promise<string | null> => {
  const head = await gitOrNull(repo, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (head !== null && head !== '') return head;
  for (const candidate of BASE_CANDIDATES) {
    if ((await gitOrNull(repo, ['rev-parse', '--verify', '--quiet', candidate])) !== null) return candidate;
  }
  return null;
};

/** How long fetching the base ref may take. */
const FETCH_MS = 20_000;

/**
 * Fetches the remote branch behind the remote-tracking `ref`, so a branch merged since the last fetch counts
 * as merged; false when that failed (offline, no access), leaving the local ref, which can only err towards asking.
 */
const fetchBase = async (repo: string, ref: string): Promise<boolean> => {
  const [remote, ...branch] = ref.slice(REMOTES_PREFIX.length).split('/');
  if (remote === undefined || branch.length === 0) return false;
  try {
    await run('git', ['fetch', '--quiet', '--no-tags', '--', remote, branch.join('/')], {
      cwd: repo,
      timeout: FETCH_MS,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', SSH_ASKPASS_REQUIRE: 'never' },
    });
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error) return false;
    throw error;
  }
};

const isDirectory = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return false;
    throw error;
  }
};

/** What deleting `worktree` of `repo` would lose: commits not in the base ref and uncommitted changes. */
export const worktreeRisks = async (repo: string, worktree: Worktree): Promise<WorktreeRisks> => {
  const ref = await baseRef(repo);
  if (ref !== null) await fetchBase(repo, ref);
  const base = ref === null ? null : ref.slice(ref.startsWith(REMOTES_PREFIX) ? REMOTES_PREFIX.length : 0);
  let ahead: number | null = null;
  if (ref !== null) ahead = worktree.head === null ? 0 : Number(await git(repo, ['rev-list', '--count', `${ref}..${worktree.head}`]));
  const status = (await isDirectory(worktree.path)) ? await git(worktree.path, ['status', '--porcelain', '--untracked-files=normal']) : '';
  return { base, ahead, changes: status.split('\n').filter((line) => line !== '').length };
};

/** Removes `worktree` of `repo`, `force` also discarding its changes; a worktree whose directory is gone is pruned. */
export const removeWorktree = async (repo: string, worktree: Worktree, force: boolean): Promise<void> => {
  if (worktree.prunable && !(await isDirectory(worktree.path))) {
    await git(repo, ['worktree', 'prune']);
    return;
  }
  await git(repo, ['worktree', 'remove', ...(force ? ['--force'] : []), worktree.path]);
};
