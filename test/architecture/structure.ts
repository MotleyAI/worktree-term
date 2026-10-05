import { posix } from 'node:path';
import { arrowAllows, unitOf, type ArchModel, type Element } from './model.js';
import type { ResolvedImport, SourceFile } from './tree.js';

export interface Violation {
  rule: string;
  file: string;
  detail: string;
}

const PROTOCOL = 'protocol';

const missingIndexes = (model: ArchModel, paths: ReadonlySet<string>): Violation[] =>
  model.elements
    .filter((e) => e.unit && !paths.has(`${e.dir}/index.ts`))
    .map((e) => ({ rule: 'missing-index', file: `${e.dir}/index.ts`, detail: `${e.id} has no index.ts` }));

const importViolations = (model: ArchModel, from: Element, file: string, ref: ResolvedImport): Violation[] => {
  const { target } = ref;
  if (target.kind === 'unresolved') return [{ rule: 'unresolved-import', file, detail: ref.specifier }];
  if (target.kind !== 'file') return [];
  const to = unitOf(model, target.path);
  if (to === undefined || to.id === from.id) return [];
  const violations: Violation[] = [];
  if (target.path !== `${to.dir}/index.ts`) {
    violations.push({ rule: 'deep-import', file, detail: `${ref.specifier} reaches past ${to.id}/index.ts` });
  }
  // Runtime imports are arch_check's model-truth; it does not see type-only ones.
  if (ref.typeOnly && to.id !== PROTOCOL && !arrowAllows(model, from.id, to.id)) {
    violations.push({ rule: 'type-import-without-arrow', file, detail: `${from.id} -> ${to.id}` });
  }
  return violations;
};

const fileViolations = (model: ArchModel, file: SourceFile): Violation[] => {
  const container = model.elements.find((e) => !e.unit && posix.dirname(file.path) === e.dir);
  if (container !== undefined) return [{ rule: 'module-in-container', file: file.path, detail: `${container.id} has nested elements` }];
  const from = unitOf(model, file.path);
  if (from === undefined) return [{ rule: 'outside-units', file: file.path, detail: 'not inside any model element' }];
  return file.imports.flatMap((ref) => importViolations(model, from, file.path, ref));
};

/** Structure rules of `architecture/system.arc42.md` principles 1 and 2. */
export const checkStructure = (model: ArchModel, files: readonly SourceFile[]): Violation[] => [
  ...missingIndexes(model, new Set(files.map((f) => f.path))),
  ...files.flatMap((file) => fileViolations(model, file)),
];
