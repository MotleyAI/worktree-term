import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
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

/** Checks that `repo` is a repository's main worktree or bare directory; returns its common dir. */
export const checkRepo = async (repo: string): Promise<string> => {
  const real = await realOrNull(repo);
  if (real === null) throw new NotARepoError(`${repo} does not exist`);
  let listing: string;
  let common: string;
  try {
    [listing, common] = await Promise.all([git(repo, ['worktree', 'list', '--porcelain', '-z']), commonDir(repo)]);
  } catch (error) {
    throw new NotARepoError(`${repo} is not a git repository`, { cause: error });
  }
  const main = parsePorcelain(listing)[0];
  if (main === undefined || (await realOrNull(main.path)) !== real) throw new NotARepoError(`${repo} is not a repository's main worktree`);
  return common;
};
