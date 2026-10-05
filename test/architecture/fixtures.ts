import type { Target } from './imports.js';
import type { ArchModel } from './model.js';
import type { ResolvedImport, SourceFile } from './tree.js';

/** A runtime import of a local file. */
export const local = (path: string, typeOnly = false): ResolvedImport => ({
  specifier: path,
  form: 'import',
  typeOnly,
  target: { kind: 'file', path },
});

/** A runtime import of a package or built-in. */
export const external = (specifier: string, target: Target, typeOnly = false): ResolvedImport => ({
  specifier,
  form: 'import',
  typeOnly,
  target,
});

export const file = (path: string, ...imports: ResolvedImport[]): SourceFile => ({ path, imports });

/** One import-free `index.ts` per unit of the model: a tree with no violations. */
export const cleanTree = (model: ArchModel): SourceFile[] =>
  model.elements.filter((e) => e.unit).map((e) => file(`${e.dir}/index.ts`));

/** `tree` with `replacement` swapped in for the file at the same path, or appended. */
export const withFile = (tree: readonly SourceFile[], replacement: SourceFile): SourceFile[] => [
  ...tree.filter((f) => f.path !== replacement.path),
  replacement,
];
