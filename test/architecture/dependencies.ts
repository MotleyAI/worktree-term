import { unitOf, type ArchModel } from './model.js';
import type { Violation } from './structure.js';
import { isTestFile, type SourceFile } from './tree.js';

/** Node built-ins without I/O; free in Node units. */
export const PURE_BUILTINS: ReadonlySet<string> = new Set([
  'path',
  'util',
  'events',
  'buffer',
  'crypto',
  'stream',
  'string_decoder',
  'url',
  'os',
  'timers',
  'assert',
  'process',
]);

/** Third-party packages and I/O-capable built-ins each unit may import. */
export const ALLOWLIST: Readonly<Record<string, readonly string[]>> = {
  protocol: ['zod'],
  'platform.files': ['fs'],
  'platform.dialer': ['net', 'child_process'],
  'daemon.worktrees': ['fs', 'child_process'],
  'daemon.terminals': ['@homebridge/node-pty-prebuilt-multiarch', '@xterm/headless', '@xterm/addon-serialize'],
  'daemon.state': ['zod'],
  'daemon.server': ['net'],
  'hub.server': ['http', 'ws'],
  'hub.links': ['net', 'child_process'],
  'hub.config': ['zod'],
  cli: ['child_process'],
  'web.client': ['@preact/signals'],
  'web.terminals': [
    '@xterm/xterm',
    '@xterm/addon-webgl',
    '@xterm/addon-fit',
    '@xterm/addon-web-links',
    '@xterm/addon-unicode11',
    '@xterm/addon-search',
  ],
  'web.ui': ['preact', '@preact/signals'],
  'web.main': ['preact'],
};

const noBuiltins = (unit: string): boolean => unit === 'protocol' || unit.startsWith('web.');

/** Dependency rules of `architecture/system.arc42.md` principle 3; test files are exempt. */
export const checkDependencies = (model: ArchModel, files: readonly SourceFile[]): Violation[] => {
  const violations: Violation[] = [];
  for (const file of files) {
    if (isTestFile(file.path)) continue;
    const unit = unitOf(model, file.path);
    if (unit === undefined) continue;
    const allowed = ALLOWLIST[unit.id] ?? [];
    for (const ref of file.imports) {
      const { target } = ref;
      if (target.kind === 'builtin') {
        if (noBuiltins(unit.id)) {
          violations.push({ rule: 'builtin-in-pure-unit', file: file.path, detail: `${unit.id} imports ${ref.specifier}` });
        } else if (!PURE_BUILTINS.has(target.name) && !allowed.includes(target.name)) {
          violations.push({ rule: 'io-builtin-not-allowed', file: file.path, detail: `${unit.id} imports ${ref.specifier}` });
        }
      } else if (target.kind === 'package' && !allowed.includes(target.name)) {
        violations.push({ rule: 'package-not-allowed', file: file.path, detail: `${unit.id} imports ${ref.specifier}` });
      }
    }
  }
  return violations;
};
