import { beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../support/exec.js';
import { ALLOWLIST, checkDependencies } from './dependencies.js';
import { cleanTree, external, file, withFile } from './fixtures.js';
import { resolveImport } from './imports.js';
import { loadModel, type ArchModel } from './model.js';
import { scanTree } from './tree.js';

let model: ArchModel;

beforeAll(async () => {
  model = await loadModel(REPO_ROOT);
});

const dirOf = (unit: string): string => {
  const element = model.elements.find((e) => e.id === unit);
  if (element === undefined) throw new Error(`no unit ${unit}`);
  return element.dir;
};

/** The clean tree with `unit`'s index.ts importing `specifiers`. */
const importing = (unit: string, specifiers: readonly string[], typeOnly = false): ReturnType<typeof cleanTree> => {
  const path = `${dirOf(unit)}/index.ts`;
  const imports = specifiers.map((s) => external(s, resolveImport(s, `${REPO_ROOT}/${path}`), typeOnly));
  return withFile(cleanTree(model), file(path, ...imports));
};

const rules = (unit: string, specifiers: readonly string[], typeOnly = false): string[] =>
  checkDependencies(model, importing(unit, specifiers, typeOnly)).map((v) => v.rule);

describe('dependency allowlist', () => {
  it('names only units of the model', () => {
    const units = model.elements.filter((e) => e.unit).map((e) => e.id);
    expect(units).toEqual(expect.arrayContaining(Object.keys(ALLOWLIST)));
  });

  it.each(Object.entries(ALLOWLIST))('accepts what %s is allowed: %j', (unit, allowed) => {
    expect(rules(unit, allowed)).toEqual([]);
  });

  it('accepts node: and /promises forms of an allowed built-in', () => {
    expect(rules('platform.files', ['node:fs', 'fs/promises', 'node:fs/promises'])).toEqual([]);
  });

  it('accepts a package subpath of an allowed package', () => {
    expect(rules('web.terminals', ['@xterm/addon-fit/lib/fit'])).toEqual([]);
  });

  it('accepts pure built-ins in Node units', () => {
    const pure = ['node:path', 'util', 'events', 'buffer', 'crypto', 'stream', 'string_decoder', 'url', 'os', 'timers/promises', 'assert', 'process'];
    expect(rules('daemon.main', pure)).toEqual([]);
  });

  it.each([
    ['protocol', 'path'],
    ['protocol', 'node:crypto'],
    ['web.layout', 'node:path'],
    ['web.client', 'events'],
  ])('reports %s importing built-in %s', (unit, specifier) => {
    expect(rules(unit, [specifier])).toEqual(['builtin-in-pure-unit']);
  });

  it.each([
    ['hub.server', 'fs'],
    ['hub.server', 'node:fs/promises'],
    ['daemon.server', 'child_process'],
    ['platform.files', 'net'],
    ['platform.files', 'child_process'],
    ['cli', 'net'],
    ['hub.router', 'net'],
    ['daemon.state', 'node:sqlite'],
    ['daemon.main', 'worker_threads'],
  ])('reports %s importing I/O built-in %s', (unit, specifier) => {
    expect(rules(unit, [specifier])).toEqual(['io-builtin-not-allowed']);
  });

  it.each([
    ['web.layout', 'preact'],
    ['daemon.terminals', '@xterm/xterm'],
    ['hub.router', 'zod'],
    ['cli', 'ws'],
  ])('reports %s importing package %s', (unit, specifier) => {
    expect(rules(unit, [specifier])).toEqual(['package-not-allowed']);
  });

  it('reports a type-only import of a package outside the allowlist', () => {
    expect(rules('web.ui', ['@xterm/xterm'], true)).toEqual(['package-not-allowed']);
  });

  it('exempts test files', () => {
    const path = 'src/hub/server/server.test.ts';
    const imports = ['vitest', 'node:fs'].map((s) => external(s, resolveImport(s, `${REPO_ROOT}/${path}`)));
    expect(checkDependencies(model, [...cleanTree(model), file(path, ...imports)])).toEqual([]);
  });

  it('reports the file and the specifier', () => {
    expect(checkDependencies(model, importing('hub.server', ['fs']))).toEqual([
      { rule: 'io-builtin-not-allowed', file: 'src/hub/server/index.ts', detail: 'hub.server imports fs' },
    ]);
  });
});

describe('source tree', () => {
  it('obeys the dependency allowlist', () => {
    expect(checkDependencies(model, scanTree(REPO_ROOT))).toEqual([]);
  });
});
