import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { packageName, resolveImport, scanImports, type ImportRef } from './imports.js';

const ref = (specifier: string, form: ImportRef['form'], typeOnly = false): ImportRef => ({ specifier, form, typeOnly });

describe('scanImports', () => {
  it.each<[string, string, ImportRef[]]>([
    ['default and named import', `import a, { b } from './a.js';`, [ref('./a.js', 'import')]],
    ['namespace import', `import * as ns from 'zod';`, [ref('zod', 'import')]],
    ['import type', `import type { T } from './t.js';`, [ref('./t.js', 'import', true)]],
    ['inline type specifiers, kept by verbatimModuleSyntax', `import { type T } from './t.js';`, [ref('./t.js', 'import')]],
    ['export from', `export { a } from './a.js';`, [ref('./a.js', 'export-from')]],
    ['export type from', `export type { T } from './t.js';`, [ref('./t.js', 'export-from', true)]],
    ['export star', `export * from './a.js';`, [ref('./a.js', 'export-star')]],
    ['export star as namespace', `export * as ns from './a.js';`, [ref('./a.js', 'export-star')]],
    ['side-effect import', `import './polyfill.js';`, [ref('./polyfill.js', 'side-effect')]],
    ['import equals require', `import fs = require('fs');`, [ref('fs', 'import-equals')]],
    ['import type equals require', `import type fs = require('fs');`, [ref('fs', 'import-equals', true)]],
    ['dynamic import', `const m = await import('./lazy.js');`, [ref('./lazy.js', 'dynamic-import')]],
    ['dynamic import inside a function', `function f() { return import('net'); }`, [ref('net', 'dynamic-import')]],
    ['require call', `const m = require('child_process');`, [ref('child_process', 'require')]],
    ['import type node', `type T = typeof import('./t.js');`, [ref('./t.js', 'import-type-node', true)]],
    ['package subpath', `import { FitAddon } from '@xterm/addon-fit/lib/fit';`, [ref('@xterm/addon-fit/lib/fit', 'import')]],
  ])('detects %s', (_name, text, expected) => {
    expect(scanImports('fixture.ts', text)).toEqual(expected);
  });

  it('parses JSX in .tsx files', () => {
    const text = `import { h } from 'preact';\nexport const v = <div>{import('./lazy.js')}</div>;`;
    expect(scanImports('fixture.tsx', text)).toEqual([ref('preact', 'import'), ref('./lazy.js', 'dynamic-import')]);
  });

  it('parses angle-bracket assertions in .ts files', () => {
    expect(scanImports('fixture.ts', `const v = <number>x;\nimport('./a.js');`)).toEqual([ref('./a.js', 'dynamic-import')]);
  });

  it('reports a non-literal dynamic import or require with an empty specifier', () => {
    const text = `const m = await import(name);\nconst n = require(name);`;
    expect(scanImports('fixture.ts', text)).toEqual([ref('', 'dynamic-import'), ref('', 'require')]);
  });

  it('reports every import of a file in order', () => {
    const text = [`import 'a';`, `import type { B } from 'b';`, `export * from 'c';`].join('\n');
    expect(scanImports('fixture.ts', text).map((r) => r.specifier)).toEqual(['a', 'b', 'c']);
  });
});

describe('packageName', () => {
  it.each([
    ['zod', 'zod'],
    ['zod/v4', 'zod'],
    ['@xterm/addon-fit', '@xterm/addon-fit'],
    ['@xterm/addon-fit/lib/fit', '@xterm/addon-fit'],
  ])('%s belongs to %s', (specifier, name) => {
    expect(packageName(specifier)).toBe(name);
  });
});

describe('resolveImport', () => {
  let dir = '';
  const at = (name: string): string => join(dir, name);

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'wt-imports-'));
    mkdirSync(at('b'));
    for (const name of ['from.ts', 'a.ts', 'b/index.ts', 'c.tsx']) writeFileSync(at(name), 'export {};\n');
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    ['fs', 'fs'],
    ['node:fs', 'fs'],
    ['fs/promises', 'fs'],
    ['node:fs/promises', 'fs'],
    ['node:child_process', 'child_process'],
    ['timers/promises', 'timers'],
  ])('classifies %s as built-in %s', (specifier, name) => {
    expect(resolveImport(specifier, at('from.ts'))).toEqual({ kind: 'builtin', name });
  });

  it.each([
    ['zod/v4', 'zod'],
    ['@xterm/addon-fit/lib/fit', '@xterm/addon-fit'],
  ])('classifies %s as package %s', (specifier, name) => {
    expect(resolveImport(specifier, at('from.ts'))).toEqual({ kind: 'package', name });
  });

  it.each([
    ['./a.js', 'a.ts'],
    ['./b/index.js', 'b/index.ts'],
    ['./b', 'b/index.ts'],
    ['./c.js', 'c.tsx'],
  ])('resolves %s to %s', (specifier, file) => {
    expect(resolveImport(specifier, at('from.ts'))).toEqual({ kind: 'file', path: at(file) });
  });

  it.each(['./missing.js', ''])('reports %j as unresolved', (specifier) => {
    expect(resolveImport(specifier, at('from.ts'))).toEqual({ kind: 'unresolved' });
  });
});
