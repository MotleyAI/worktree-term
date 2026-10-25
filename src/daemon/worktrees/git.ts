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

/** Default branch names tried after `origin/HEAD`'s target, in order. */
const DEFAULT_BRANCHES = ['main', 'master'];
const ORIGIN_PREFIX = 'refs/remotes/origin/';

/** A fetch of the default branch that failed: the remote-tracking ref, e.g. `origin/main`, and why. */
export interface FetchFailure {
  ref: string;
  reason: string;
}

/** The bases a worktree's head is compared with, and its commits in neither. */
interface Comparison {
  /** The local default branch, e.g. `main`; null when it does not exist. */
  local: string | null;
  /** Its `origin` remote-tracking ref, e.g. `origin/main`; null when it does not exist. */
  remote: string | null;
  /** Commits of the head in neither base; null without either, 0 without a head. */
  ahead: number | null;
}

/** What deleting a worktree would lose, apart from its terminals. */
export interface WorktreeRisks extends Comparison {
  /** Set when fetching the default branch to compare again failed. */
  fetchFailed: FetchFailure | null;
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

const refExists = async (repo: string, ref: string): Promise<boolean> =>
  (await gitOrNull(repo, ['rev-parse', '--verify', '--quiet', ref])) !== null;

/** The first of `origin/HEAD`'s target, `main` and `master` that exists as a local branch or under `origin`. */
const defaultBranch = async (repo: string): Promise<string | null> => {
  const head = await gitOrNull(repo, ['symbolic-ref', '--quiet', `${ORIGIN_PREFIX}HEAD`]);
  const named = head?.startsWith(ORIGIN_PREFIX) === true ? [head.slice(ORIGIN_PREFIX.length)] : [];
  for (const branch of [...named, ...DEFAULT_BRANCHES]) {
    if ((await refExists(repo, `refs/heads/${branch}`)) || (await refExists(repo, `${ORIGIN_PREFIX}${branch}`))) return branch;
  }
  return null;
};

/** Compares `head` with the local `branch` and `origin/<branch>`, whichever exist. */
const compare = async (repo: string, branch: string, head: string | null): Promise<Comparison> => {
  const localRef = `refs/heads/${branch}`;
  const remoteRef = `${ORIGIN_PREFIX}${branch}`;
  const [hasLocal, hasRemote] = await Promise.all([refExists(repo, localRef), refExists(repo, remoteRef)]);
  const local = hasLocal ? branch : null;
  const remote = hasRemote ? `origin/${branch}` : null;
  if (!hasLocal && !hasRemote) return { local, remote, ahead: null };
  if (head === null) return { local, remote, ahead: 0 };
  const bases = [...(hasLocal ? [localRef] : []), ...(hasRemote ? [remoteRef] : [])];
  return { local, remote, ahead: Number(await git(repo, ['rev-list', '--count', head, '--not', ...bases])) };
};

/** How long fetching the default branch may take. */
const FETCH_MS = 20_000;
const MAX_REASON = 1024;
// eslint-disable-next-line no-control-regex -- control characters are what it replaces
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/** Why a failed `execFile` of git failed: a timeout, git's first non-blank error line, else the error's message; rethrows anything else. */
export const fetchFailureReason = (error: unknown, timeoutMs: number): string => {
  if (!(error instanceof Error) || !('code' in error)) throw error;
  const { code } = error;
  const signal = 'signal' in error ? error.signal : null;
  if (typeof code !== 'number' && typeof code !== 'string' && typeof signal !== 'string') throw error;
  if ('killed' in error && error.killed === true) return `timed out after ${String(timeoutMs / 1000)} s`;
  const stderr = 'stderr' in error && typeof error.stderr === 'string' ? error.stderr : '';
  const line = stderr
    .split('\n')
    .map((l) => l.replace(CONTROL, ' ').trim())
    .find((l) => l !== '');
  return (line ?? error.message).slice(0, MAX_REASON);
};

/**
 * Fetches `branch` from `origin` into `origin/<branch>`, whatever origin's configured refspec;
 * the reason when that failed.
 */
const fetchDefault = async (repo: string, branch: string, timeoutMs: number): Promise<string | null> => {
  try {
    await run('git', ['fetch', '--quiet', '--no-tags', '--', 'origin', `+refs/heads/${branch}:${ORIGIN_PREFIX}${branch}`], {
      cwd: repo,
      timeout: timeoutMs,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', SSH_ASKPASS_REQUIRE: 'never' },
    });
    return null;
  } catch (error) {
    return fetchFailureReason(error, timeoutMs);
  }
};

const hasOrigin = async (repo: string): Promise<boolean> => (await git(repo, ['remote'])).split('\n').includes('origin');

const isDirectory = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return false;
    throw error;
  }
};

const changesIn = async (path: string): Promise<number> => {
  const status = (await isDirectory(path)) ? await git(path, ['status', '--porcelain', '--untracked-files=normal']) : '';
  return status.split('\n').filter((line) => line !== '').length;
};

/**
 * What deleting `worktree` of `repo` would lose: commits in neither the local default branch nor its
 * `origin` remote-tracking ref, compared again after fetching it when some are, and uncommitted changes.
 */
export const worktreeRisks = async (repo: string, worktree: Worktree, fetchMs = FETCH_MS): Promise<WorktreeRisks> => {
  // `worktree` may predate its latest commit.
  const head = (await listWorktrees(repo)).find((w) => w.path === worktree.path)?.head ?? worktree.head;
  const changes = await changesIn(worktree.path);
  const branch = await defaultBranch(repo);
  if (branch === null) return { local: null, remote: null, ahead: null, fetchFailed: null, changes };
  const before = await compare(repo, branch, head);
  if ((before.ahead ?? 0) === 0 || !(await hasOrigin(repo))) return { ...before, fetchFailed: null, changes };
  const ref = `origin/${branch}`;
  const reason = await fetchDefault(repo, branch, fetchMs);
  if (reason !== null) return { ...before, fetchFailed: { ref, reason }, changes };
  const after = await compare(repo, branch, head);
  if (after.remote === null) return { ...before, fetchFailed: { ref, reason: `${ref} is missing after the fetch` }, changes };
  return { ...after, fetchFailed: null, changes };
};

/** Removes `worktree` of `repo`, also when its directory is gone, `force` also discarding its changes. */
export const removeWorktree = async (repo: string, worktree: Worktree, force: boolean): Promise<void> => {
  await git(repo, ['worktree', 'remove', ...(force ? ['--force'] : []), worktree.path]);
};
