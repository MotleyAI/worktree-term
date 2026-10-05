import { posix } from 'node:path';
import { arrowAllows, unitOf, type ArchModel } from './model.js';
import type { SourceFile } from './tree.js';

export interface Violation {
  rule: string;
  file: string;
  detail: string;
}

const PROTOCOL = 'protocol';

/** Structure rules of `architecture/system.arc42.md` principles 1 and 2. */
export const checkStructure = (model: ArchModel, files: readonly SourceFile[]): Violation[] => {
  const violations: Violation[] = [];
  const paths = new Set(files.map((f) => f.path));

  for (const element of model.elements) {
    if (element.unit && !paths.has(`${element.dir}/index.ts`)) {
      violations.push({ rule: 'missing-index', file: `${element.dir}/index.ts`, detail: `${element.id} has no index.ts` });
    }
  }

  for (const file of files) {
    const container = model.elements.find((e) => !e.unit && posix.dirname(file.path) === e.dir);
    if (container !== undefined) {
      violations.push({ rule: 'module-in-container', file: file.path, detail: `${container.id} has nested elements` });
      continue;
    }
    const from = unitOf(model, file.path);
    if (from === undefined) {
      violations.push({ rule: 'outside-units', file: file.path, detail: 'not inside any model element' });
      continue;
    }
    for (const ref of file.imports) {
      if (ref.target.kind === 'unresolved') {
        violations.push({ rule: 'unresolved-import', file: file.path, detail: ref.specifier });
        continue;
      }
      if (ref.target.kind !== 'file') continue;
      const to = unitOf(model, ref.target.path);
      if (to === undefined || to.id === from.id) continue;
      if (ref.target.path !== `${to.dir}/index.ts`) {
        violations.push({ rule: 'deep-import', file: file.path, detail: `${ref.specifier} reaches past ${to.id}/index.ts` });
      }
      // Runtime imports are arch_check's model-truth; it does not see type-only ones.
      if (ref.typeOnly && to.id !== PROTOCOL && !arrowAllows(model, from.id, to.id)) {
        violations.push({ rule: 'type-import-without-arrow', file: file.path, detail: `${from.id} -> ${to.id}` });
      }
    }
  }
  return violations;
};
