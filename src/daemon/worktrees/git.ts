import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Worktree } from '../../protocol/index.js';
import { branchCandidate, createdFrom } from './base.js';
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

/** A fetch that failed: the remote-tracking ref, e.g. `origin/main`, and why. */
export interface FetchFailure {
  ref: string;
  reason: string;
}

/** The refs a worktree's head is compared with, and its commits in none of them. */
interface Comparison {
  /** The base's and the default branch's local branch and `origin` ref that exist, e.g. `feature-x`, `origin/main`. */
  bases: string[];
  /** Commits of the head in none of `bases`; null without bases, 0 without a head. */
  ahead: number | null;
}

/** What deleting a worktree would lose, apart from its terminals. */
export interface WorktreeRisks extends Comparison {
  /** The fetches before comparing again that failed, the base's first. */
  fetchFailed: FetchFailure[];
  /** Uncommitted changes, untracked files included; 0 when its directory is gone. */
  changes: number;
}

/** The output of a `--quiet` git query, or null when it exits with 1 for a missing ref or config key. */
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

/** Remotes whose upstream branch can be a base: `origin`, and `.` for a local branch. */
const UPSTREAM_REMOTES = new Set(['origin', '.']);

/** The single `refs/heads/` ref `branch` tracks on `origin` or locally, if any. */
const upstreamOf = async (repo: string, branch: string): Promise<string | null> => {
  const remote = await gitOrNull(repo, ['config', '--get', `branch.${branch}.remote`]);
  if (remote === null || !UPSTREAM_REMOTES.has(remote)) return null;
  const merges = (await gitOrNull(repo, ['config', '--get-all', `branch.${branch}.merge`]))?.split('\n') ?? [];
  const [merge] = merges;
  return merges.length === 1 && merge?.startsWith('refs/heads/') === true ? merge : null;
};

/** The branch `ref` names when it can be the base of `branch`: not itself, not also a tag, and existing locally or under `origin`. */
const usableBase = async (repo: string, branch: string, ref: string | null): Promise<string | null> => {
  const name = ref === null ? null : branchCandidate(ref);
  if (name === null || name === branch) return null;
  const [tagged, local, remote] = await Promise.all([
    refExists(repo, `refs/tags/${name}`),
    refExists(repo, `refs/heads/${name}`),
    refExists(repo, `${ORIGIN_PREFIX}${name}`),
  ]);
  return !tagged && (local || remote) ? name : null;
};

/** The branch `worktree` is based on: its upstream, else the branch it was created from; null when detached or neither. */
const baseOf = async (repo: string, worktree: Worktree): Promise<string | null> => {
  const { branch } = worktree;
  if (branch === null) return null;
  const upstream = await usableBase(repo, branch, await upstreamOf(repo, branch));
  if (upstream !== null) return upstream;
  // An unborn branch has no ref, so no reflog.
  const reflog = worktree.head === null ? '' : await git(repo, ['reflog', 'show', '--format=%gs', `refs/heads/${branch}`, '--']);
  return usableBase(repo, branch, createdFrom(reflog));
};

/** Compares `head` with the local branch and `origin` ref of each of `branches` that exist. */
const compare = async (repo: string, branches: readonly string[], head: string | null): Promise<Comparison> => {
  const candidates = branches.flatMap((branch) => [
    { name: branch, ref: `refs/heads/${branch}` },
    { name: `origin/${branch}`, ref: `${ORIGIN_PREFIX}${branch}` },
  ]);
  const exists = await Promise.all(candidates.map(({ ref }) => refExists(repo, ref)));
  const found = candidates.filter((_, i) => exists[i]);
  const bases = found.map(({ name }) => name);
  if (found.length === 0) return { bases, ahead: null };
  if (head === null) return { bases, ahead: 0 };
  return { bases, ahead: Number(await git(repo, ['rev-list', '--count', head, '--not', ...found.map(({ ref }) => ref)])) };
};

/** How long fetching a branch may take. */
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
 * Fetches `branch` from `origin` into `origin/<branch>`, whatever origin's configured refspec, sharing no
 * file with a concurrent fetch; the reason when that failed.
 */
const fetchBranch = async (repo: string, branch: string, timeoutMs: number): Promise<string | null> => {
  const refspec = `+refs/heads/${branch}:${ORIGIN_PREFIX}${branch}`;
  try {
    await run('git', ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--no-auto-maintenance', '--', 'origin', refspec], {
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

/** The worktree as listed now: `worktree` may predate its latest commit. */
const currentOf = async (repo: string, worktree: Worktree): Promise<Worktree> =>
  (await listWorktrees(repo)).find((w) => w.path === worktree.path) ?? worktree;

/**
 * What deleting `worktree` of `repo` would lose: commits in none of its base's and the default branch's local
 * branch and `origin` ref, compared again after fetching both when some are, and uncommitted changes.
 */
export const worktreeRisks = async (repo: string, worktree: Worktree, fetchMs = FETCH_MS): Promise<WorktreeRisks> => {
  const current = await currentOf(repo, worktree);
  const [base, fallback] = await Promise.all([baseOf(repo, current), defaultBranch(repo)]);
  const branches = [...new Set([base, fallback].filter((b) => b !== null))];
  const before = await compare(repo, branches, current.head);
  if ((before.ahead ?? 0) === 0 || !(await hasOrigin(repo)))
    return { ...before, fetchFailed: [], changes: await changesIn(worktree.path) };
  const trackedBase = base !== null && base !== fallback && before.bases.includes(`origin/${base}`) ? [base] : [];
  const fetched = [...trackedBase, ...(fallback === null ? [] : [fallback])];
  const reasons = await Promise.all(fetched.map((branch) => fetchBranch(repo, branch, fetchMs)));
  // Head and changes are read again after the fetches, which may take a while, so work done meanwhile counts.
  const [after, changes] = await Promise.all([
    currentOf(repo, worktree).then(({ head }) => compare(repo, branches, head)),
    changesIn(worktree.path),
  ]);
  const fetchFailed = fetched.flatMap((branch, i) => {
    const ref = `origin/${branch}`;
    const reason = reasons[i] ?? (after.bases.includes(ref) ? null : `${ref} is missing after the fetch`);
    return reason === null ? [] : [{ ref, reason }];
  });
  return { ...after, fetchFailed, changes };
};

/** Removes `worktree` of `repo`, also when its directory is gone, `force` also discarding its changes. */
export const removeWorktree = async (repo: string, worktree: Worktree, force: boolean): Promise<void> => {
  await git(repo, ['worktree', 'remove', ...(force ? ['--force'] : []), worktree.path]);
};
