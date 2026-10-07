import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Most repositories one discovery reports. */
const MAX_REPOS = 4096;

const exists = async (path: string, directory: boolean): Promise<boolean> => {
  try {
    const stats = await lstat(path);
    return directory ? stats.isDirectory() : stats.isFile();
  } catch {
    return false;
  }
};

/** A directory holding a `.git` directory, or a bare repository. */
const isRepo = async (dir: string): Promise<boolean> => {
  if (await exists(join(dir, '.git'), true)) return true;
  const [head, objects, refs] = await Promise.all([
    exists(join(dir, 'HEAD'), false),
    exists(join(dir, 'objects'), true),
    exists(join(dir, 'refs'), true),
  ]);
  return head && objects && refs;
};

/** Locale-independent order, as the default sort gives for strings. */
const byCodeUnits = (a: string, b: string): number => {
  if (a === b) return 0;
  return a < b ? -1 : 1;
};

/** Subdirectories worth searching, sorted: no symbolic links, hidden directories or node_modules. */
const children = async (dir: string): Promise<string[]> => {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map((e) => e.name)
      .sort(byCodeUnits);
  } catch {
    return [];
  }
};

/** The real path of `path` if it is a directory, else null. */
const realDirectory = async (path: string): Promise<string | null> => {
  try {
    return (await stat(path)).isDirectory() ? await realpath(path) : null;
  } catch {
    return null;
  }
};

/** `root` with a leading `~` expanded against the home directory. */
const expandHome = (root: string): string => {
  if (root === '~') return homedir();
  return root.startsWith('~/') ? join(homedir(), root.slice(2)) : root;
};

/**
 * Repositories at most `depth` levels below each root (the root being level 0), sorted, at most
 * the first 4096 in visiting order.
 */
export const discoverRepos = async (roots: readonly string[], depth: number): Promise<string[]> => {
  const found = new Set<string>();
  const visit = async (dir: string, level: number): Promise<void> => {
    if (found.size >= MAX_REPOS) return;
    if (await isRepo(dir)) {
      found.add(dir);
      return;
    }
    if (level >= depth) return;
    for (const name of await children(dir)) await visit(join(dir, name), level + 1); // NOSONAR(S9382) — ordered walk keeps the cap deterministic
  };
  for (const root of roots) {
    const real = await realDirectory(expandHome(root)); // NOSONAR(S9382) — ordered walk
    if (real !== null) await visit(real, 0); // NOSONAR(S9382) — ordered walk
  }
  return [...found].sort(byCodeUnits);
};
