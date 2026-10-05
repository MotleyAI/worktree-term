import { join } from 'node:path';
import { LikeC4 } from 'likec4';

export interface Element {
  /** Model id without the root, e.g. `daemon.server`. */
  id: string;
  /** Repo-relative source directory. */
  dir: string;
  /** A unit is a leaf element: it owns modules. Elements with children own none. */
  unit: boolean;
}

export interface Arrow {
  from: string;
  to: string;
}

export interface ArchModel {
  elements: Element[];
  arrows: Arrow[];
}

const ROOT_PREFIX = 'typescript.';

/** Reads elements, their source directories and arrows from the LikeC4 model. */
export const loadModel = async (repoRoot: string): Promise<ArchModel> => {
  const likec4 = await LikeC4.fromWorkspace(join(repoRoot, 'architecture'), { printErrors: false, logger: false, throwIfInvalid: true });
  const model = await likec4.computedModel();
  const strip = (id: string): string => id.slice(ROOT_PREFIX.length);
  const elements: Element[] = [];
  for (const element of model.elements()) {
    if (!element.id.startsWith(ROOT_PREFIX)) continue;
    const id = strip(element.id);
    const unit = [...element.children()].length === 0;
    const pkg = element.getMetadata('package');
    const parent = element.parent;
    let dir: string;
    if (typeof pkg === 'string') dir = pkg;
    else if (parent !== null && typeof parent.getMetadata('package') === 'string') {
      dir = `${String(parent.getMetadata('package'))}/${element.name}`;
    } else throw new Error(`element ${id} has no source directory`);
    elements.push({ id, dir, unit });
  }
  const arrows = [...model.relationships()].map((r) => ({ from: strip(r.source.id), to: strip(r.target.id) }));
  return { elements, arrows };
};

const within = (id: string, ancestor: string): boolean => id === ancestor || id.startsWith(`${ancestor}.`);

/** Whether a model arrow lets unit `from` import unit `to`. */
export const arrowAllows = (model: ArchModel, from: string, to: string): boolean =>
  model.arrows.some((arrow) => within(from, arrow.from) && within(to, arrow.to));

/** The unit whose directory contains a repo-relative file path. */
export const unitOf = (model: ArchModel, file: string): Element | undefined =>
  model.elements.find((e) => e.unit && file.startsWith(`${e.dir}/`));
