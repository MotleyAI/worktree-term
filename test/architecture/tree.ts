import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { resolveImport, scanImports, type ImportRef, type Target } from './imports.js';

export interface ResolvedImport extends ImportRef {
  /** Repo-relative path for local files. */
  target: Target;
}

export interface SourceFile {
  /** Repo-relative, `/`-separated. */
  path: string;
  imports: ResolvedImport[];
}

const SOURCE = /\.(ts|tsx|mts|cts)$/;

const toRepoPath = (root: string, absolute: string): string => relative(root, absolute).split(sep).join('/');

/** Scans every TypeScript source under `src/` and resolves its imports. */
export const scanTree = (root: string): SourceFile[] => {
  const srcDir = join(root, 'src');
  if (!existsSync(srcDir)) return [];
  const files = readdirSync(srcDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && SOURCE.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
  return files.map((absolute) => ({
    path: toRepoPath(root, absolute),
    imports: scanImports(absolute, readFileSync(absolute, 'utf8')).map((ref) => {
      const target = resolveImport(ref.specifier, absolute);
      return { ...ref, target: target.kind === 'file' ? { kind: 'file', path: toRepoPath(root, target.path) } : target };
    }),
  }));
};

export const isTestFile = (path: string): boolean => /\.test\.tsx?$/.test(path);
