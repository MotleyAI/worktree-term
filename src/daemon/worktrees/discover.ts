import { lstat, readdir, stat } from 'node:fs/promises';
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

/** Subdirectories worth searching, sorted: no symbolic links, hidden directories or node_modules. */
const children = async (dir: string): Promise<string[]> => {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
};

const isDirectory = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
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
    for (const name of await children(dir)) await visit(join(dir, name), level + 1);
  };
  for (const root of roots) {
    if (await isDirectory(root)) await visit(root, 0);
  }
  return [...found].sort();
};
