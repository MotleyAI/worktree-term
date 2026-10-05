import { beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../support/exec.js';
import { cleanTree, file, local, withFile } from './fixtures.js';
import { loadModel, type ArchModel } from './model.js';
import { checkStructure } from './structure.js';
import { scanTree } from './tree.js';

let model: ArchModel;

beforeAll(async () => {
  model = await loadModel(REPO_ROOT);
});

const rules = (files: Parameters<typeof checkStructure>[1]): string[] => checkStructure(model, files).map((v) => v.rule);

describe('model', () => {
  it('maps every element to its source directory', () => {
    expect(model.elements.map((e) => [e.id, e.dir, e.unit])).toEqual([
      ['protocol', 'src/protocol', true],
      ['platform', 'src/platform', false],
      ['daemon', 'src/daemon', false],
      ['hub', 'src/hub', false],
      ['cli', 'src/cli', true],
      ['web', 'src/web', false],
      ['platform.files', 'src/platform/files', true],
      ['platform.dialer', 'src/platform/dialer', true],
      ['daemon.worktrees', 'src/daemon/worktrees', true],
      ['daemon.terminals', 'src/daemon/terminals', true],
      ['daemon.state', 'src/daemon/state', true],
      ['daemon.server', 'src/daemon/server', true],
      ['daemon.main', 'src/daemon/main', true],
      ['hub.server', 'src/hub/server', true],
      ['hub.links', 'src/hub/links', true],
      ['hub.config', 'src/hub/config', true],
      ['hub.router', 'src/hub/router', true],
      ['hub.main', 'src/hub/main', true],
      ['web.client', 'src/web/client', true],
      ['web.terminals', 'src/web/terminals', true],
      ['web.layout', 'src/web/layout', true],
      ['web.ui', 'src/web/ui', true],
      ['web.main', 'src/web/main', true],
    ]);
  });

  it('reads the arrows', () => {
    expect(model.arrows).toContainEqual({ from: 'cli', to: 'daemon.main' });
    expect(model.arrows).toContainEqual({ from: 'daemon', to: 'protocol' });
    expect(model.arrows).toHaveLength(34);
  });
});

describe('structure rules', () => {
  it('accept a tree with an index.ts per unit', () => {
    expect(rules(cleanTree(model))).toEqual([]);
  });

  it('accept non-index modules and imports inside one unit', () => {
    const tree = withFile(cleanTree(model), file('src/daemon/state/index.ts', local('src/daemon/state/store.ts')));
    expect(rules([...tree, file('src/daemon/state/store.ts')])).toEqual([]);
  });

  it('report a unit without index.ts', () => {
    const tree = cleanTree(model).filter((f) => f.path !== 'src/hub/router/index.ts');
    expect(checkStructure(model, tree)).toEqual([
      { rule: 'missing-index', file: 'src/hub/router/index.ts', detail: 'hub.router has no index.ts' },
    ]);
  });

  it('report a module directly in a node with nested elements', () => {
    expect(rules([...cleanTree(model), file('src/daemon/util.ts')])).toEqual(['module-in-container']);
  });

  it.each(['src/misc.ts', 'src/misc/x.ts', 'src/daemon/util/x.ts'])('report %s as outside every unit', (path) => {
    expect(rules([...cleanTree(model), file(path)])).toEqual(['outside-units']);
  });

  it('report an import past another unit index.ts', () => {
    const tree = withFile(cleanTree(model), file('src/hub/main/index.ts', local('src/hub/server/impl.ts')));
    expect(rules([...tree, file('src/hub/server/impl.ts')])).toEqual(['deep-import']);
  });

  it('report a deep import from a test file', () => {
    const tree = [...cleanTree(model), file('src/hub/server/impl.ts'), file('src/cli/x.test.ts', local('src/hub/server/impl.ts'))];
    expect(rules(tree)).toEqual(['deep-import']);
  });

  it('report a type-only import without a model arrow', () => {
    const tree = withFile(cleanTree(model), file('src/web/layout/index.ts', local('src/web/client/index.ts', true)));
    expect(checkStructure(model, tree)).toEqual([
      { rule: 'type-import-without-arrow', file: 'src/web/layout/index.ts', detail: 'web.layout -> web.client' },
    ]);
  });

  it.each([
    ['protocol from anywhere', 'src/platform/files/index.ts', 'src/protocol/index.ts'],
    ['along an element arrow', 'src/web/ui/index.ts', 'src/web/client/index.ts'],
    ['along a node arrow', 'src/daemon/server/index.ts', 'src/platform/files/index.ts'],
  ])('accept a type-only import of %s', (_name, from, to) => {
    expect(rules(withFile(cleanTree(model), file(from, local(to, true))))).toEqual([]);
  });

  it('report an unresolved local import', () => {
    const broken = file('src/cli/index.ts', { specifier: './nope.js', form: 'import', typeOnly: false, target: { kind: 'unresolved' } });
    expect(rules(withFile(cleanTree(model), broken))).toEqual(['unresolved-import']);
  });
});

describe('source tree', () => {
  it('obeys the structure rules', () => {
    expect(checkStructure(model, scanTree(REPO_ROOT))).toEqual([]);
  });
});
