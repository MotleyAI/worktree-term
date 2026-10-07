import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkNodePath,
  desktopEntry,
  releaseName,
  releasesToRemove,
  REMOTE_INSTALL_COMMAND,
  shimScript,
  systemdUnit,
  tarArchive,
  type TarEntry,
} from './index.js';

let dir: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'wtd-install-')));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const encoder = new TextEncoder();
const bytes = (text: string): Uint8Array => encoder.encode(text);

/** Paths with every character the escapers must handle, besides the plain one. */
const AWKWARD = [
  'plain',
  'with space',
  "it's",
  'dollar$HOME',
  'per%cent',
  'back\\slash',
  'dq"uote',
  'back`tick',
  'sem;i&co|lon',
  'tab\there',
];

const writeTar = (entries: readonly TarEntry[]): string => {
  const path = join(dir, 'archive.tar');
  writeFileSync(path, tarArchive(entries));
  return path;
};

describe('tarArchive', () => {
  const extract = (archive: string): string => {
    const out = join(dir, 'out');
    mkdirSync(out);
    execFileSync('tar', ['--no-same-owner', '-p', '-x', '-C', out, '-f', archive]);
    return out;
  };

  it('round-trips directories and files with their modes through tar', () => {
    const entries: TarEntry[] = [
      { path: 'a', mode: 0o755 },
      { path: 'a/x.txt', mode: 0o644, data: bytes('hello\n') },
      { path: 'a/run', mode: 0o755, data: bytes('#!/bin/sh\necho hi\n') },
      { path: 'a/empty', mode: 0o600, data: new Uint8Array() },
      { path: 'a/é-ünïcode', mode: 0o644, data: bytes('ü') },
    ];
    const out = extract(writeTar(entries));
    expect(statSync(join(out, 'a')).isDirectory()).toBe(true);
    expect(statSync(join(out, 'a')).mode & 0o777).toBe(0o755);
    expect(readFileSync(join(out, 'a', 'x.txt'), 'utf8')).toBe('hello\n');
    expect(statSync(join(out, 'a', 'x.txt')).mode & 0o777).toBe(0o644);
    expect(statSync(join(out, 'a', 'run')).mode & 0o777).toBe(0o755);
    expect(readFileSync(join(out, 'a', 'empty')).length).toBe(0);
    expect(statSync(join(out, 'a', 'empty')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(out, 'a', 'é-ünïcode'), 'utf8')).toBe('ü');
  });

  it('stores a file of several blocks intact', () => {
    const data = Uint8Array.from({ length: 1024 * 1024 + 7 }, (_, i) => (i * 31) % 251);
    const out = extract(writeTar([{ path: 'big.bin', mode: 0o644, data }]));
    expect(Buffer.compare(readFileSync(join(out, 'big.bin')), Buffer.from(data))).toBe(0);
  });

  it('stores names longer than 100 bytes through the ustar prefix', () => {
    const parent = 'p'.repeat(120);
    const name = `${parent}/${'n'.repeat(90)}`;
    const archive = writeTar([
      { path: parent, mode: 0o755 },
      { path: name, mode: 0o644, data: bytes('deep') },
    ]);
    expect(execFileSync('tar', ['-t', '-f', archive], { encoding: 'utf8' }).split('\n').filter(Boolean)).toEqual([`${parent}/`, name]);
    expect(readFileSync(join(extract(archive), name), 'utf8')).toBe('deep');
  });

  it('lists only regular files and directories', () => {
    const archive = writeTar([
      { path: 'd', mode: 0o700 },
      { path: 'd/f', mode: 0o600, data: bytes('x') },
    ]);
    const types = execFileSync('tar', ['-tv', '-f', archive], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .map((line) => line[0]);
    expect(types).toEqual(['d', '-']);
  });

  it('pads to whole 512-byte blocks and ends with two zero blocks', () => {
    const archive = tarArchive([{ path: 'f', mode: 0o644, data: bytes('abc') }]);
    expect(archive.length % 512).toBe(0);
    expect(archive.length).toBeGreaterThanOrEqual(512 * 4);
    expect(archive.subarray(archive.length - 1024).every((b) => b === 0)).toBe(true);
  });

  it.each([
    ['a single component over 100 bytes', 'x'.repeat(101)],
    ['a name over 255 bytes', `${'d'.repeat(150)}/${'e'.repeat(110)}`],
    ['a prefix over 155 bytes', `${'d'.repeat(160)}/f`],
  ])('refuses %s, naming it', (_name, path) => {
    expect(() => tarArchive([{ path, mode: 0o644, data: bytes('') }])).toThrow(path);
  });

  it.each([['/abs'], ['../up'], ['a/../b'], ['']])('refuses the unsafe path %j', (path) => {
    expect(() => tarArchive([{ path, mode: 0o644, data: bytes('') }])).toThrow();
  });
});

describe('REMOTE_INSTALL_COMMAND', () => {
  it('is one single-quoted sh -c script without a quote or backslash inside', () => {
    const match = /^exec sh -c '([^']*)'$/.exec(REMOTE_INSTALL_COMMAND);
    expect(match).not.toBeNull();
    expect(match?.[1]).not.toMatch(/['\\]/);
  });

  it.each(['sh', 'bash', 'dash'].filter((shell) => spawnSync('sh', ['-c', `command -v ${shell}`]).status === 0))(
    'unpacks the archive from stdin and runs its install.sh from the home directory under %s',
    (shell) => {
      const home = join(dir, 'home dir');
      mkdirSync(home);
      const archive = tarArchive([{ path: 'install.sh', mode: 0o755, data: bytes('printf "ok:%s\\n" "$1"; pwd; ls "$1"\n') }]);
      const result = spawnSync(shell, ['-c', REMOTE_INSTALL_COMMAND], {
        input: archive,
        cwd: dir,
        env: { HOME: home, PATH: process.env['PATH'] ?? '/usr/bin:/bin' },
        encoding: 'utf8',
      });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      const [ok, cwd, ...listing] = result.stdout.trimEnd().split('\n');
      expect(ok).toMatch(/^ok:\//);
      expect(cwd).toBe(home);
      expect(listing).toContain('install.sh');
    },
  );
});

/** Arguments a stand-in Node at `path` was run with, one per NUL-terminated record in `log`. */
const fakeNode = (path: string, log: string): void => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `#!/bin/sh\nfor a in "$@"; do printf '%s\\0' "$a"; done > '${log.replaceAll("'", "'\\''")}'\n`);
  chmodSync(path, 0o755);
};

const argsIn = (log: string): string[] => readFileSync(log, 'utf8').split('\0').slice(0, -1);

describe('shimScript', () => {
  it.each(AWKWARD)('runs a Node whose path contains %j with wtd.mjs under the home and every argument', (part) => {
    const node = join(dir, `n ${part}`, 'bin', 'node');
    const log = join(dir, 'args');
    fakeNode(node, log);
    const home = join(dir, `home ${part.replaceAll('\t', '_')}`);
    const shim = join(home, '.local', 'bin', 'wtd');
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    writeFileSync(shim, shimScript(node));
    chmodSync(shim, 0o700);
    const result = spawnSync(shim, ['connect', 'a b', '$x', "'", ''], { env: { HOME: home, PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(argsIn(log)).toEqual([join(home, '.local', 'share', 'worktree-term', 'current', 'wtd.mjs'), 'connect', 'a b', '$x', "'", '']);
  });

  it('is a POSIX shell script', () => {
    expect(shimScript('/usr/bin/node').startsWith('#!/bin/sh\n')).toBe(true);
  });

  it.each([
    ['a relative path', 'node'],
    ['a NUL', '/opt/no\u0000de'],
    ['a newline', '/opt/no\nde'],
  ])('refuses a Node path with %s', (_name, node) => {
    expect(() => shimScript(node)).toThrow();
  });
});

describe('checkNodePath', () => {
  it.each([['/usr/bin/node'], ['/opt/my node/bin/node'], ["/opt/n'; touch x; '/node"], ['/a/$HOME/%/\\/node']])('accepts %j', (path) => {
    expect(() => {
      checkNodePath(path);
    }).not.toThrow();
  });

  it.each([
    ['a relative path', 'bin/node'],
    ['an empty path', ''],
    ['a NUL', '/opt/no\u0000de'],
    ['a newline', '/opt/no\nde'],
    ['a carriage return', '/opt/no\rde'],
  ])('refuses %s, naming the path', (_name, path) => {
    expect(() => {
      checkNodePath(path);
    }).toThrow(/node/i);
  });
});

/** Values of the `[group]` section of an INI-like file, by key. */
const section = (text: string, group: string): Map<string, string> => {
  const values = new Map<string, string>();
  let inGroup = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('[')) inGroup = line === `[${group}]`;
    else if (inGroup && line.includes('=') && !line.startsWith('#')) {
      const at = line.indexOf('=');
      values.set(line.slice(0, at), line.slice(at + 1));
    }
  }
  return values;
};

/** A Desktop Entry string value, unescaped. */
const desktopString = (raw: string): string =>
  raw.replace(/\\(.)/g, (_m, c: string) => ({ s: ' ', n: '\n', t: '\t', r: '\r', '\\': '\\' })[c] ?? `\\${c}`);

const RESERVED = /[ \t\n"'\\><~|&;$*?#()`]/;

/** An unescaped Desktop Entry `Exec` value split into arguments, as the spec defines. */
const execArguments = (value: string): string[] => {
  const args: string[] = [];
  let at = 0;
  while (at < value.length) {
    let arg = '';
    if (value[at] === '"') {
      at++;
      for (;;) {
        const c = value[at++];
        if (c === undefined) throw new Error(`unterminated quote in ${value}`);
        if (c === '"') break;
        if (c === '\\') {
          const next = value[at++] ?? '';
          if (!'"`$\\'.includes(next)) throw new Error(`bad escape \\${next} in ${value}`);
          arg += next;
        } else {
          if ('"`$\\'.includes(c)) throw new Error(`unescaped ${c} in ${value}`);
          arg += c;
        }
      }
    } else {
      while (at < value.length && value[at] !== ' ') arg += value[at++] ?? '';
      if (RESERVED.test(arg)) throw new Error(`unquoted reserved character in ${arg}`);
    }
    if (value[at] !== undefined && value[at] !== ' ') throw new Error(`no separator after an argument in ${value}`);
    if (value[at] === ' ') at++;
    if (/%[^%]/.test(arg.replaceAll('%%', ''))) throw new Error(`field code in ${arg}`);
    args.push(arg.replaceAll('%%', '%'));
  }
  return args;
};

describe('desktopEntry', () => {
  it.each(AWKWARD)('runs the shim with ui from a home whose path contains %j', (part) => {
    const home = `/home/u ${part}`;
    const shim = `${home}/.local/bin/wtd`;
    const icon = `${home}/.local/share/worktree-term/current/web/icon.svg`;
    const entry = section(desktopEntry({ shim, icon }), 'Desktop Entry');
    expect(execArguments(desktopString(entry.get('Exec') ?? ''))).toEqual([shim, 'ui']);
    expect(desktopString(entry.get('Icon') ?? '')).toBe(icon);
  });

  it('is an application named worktree-term, outside a terminal, matching the app window', () => {
    const entry = section(desktopEntry({ shim: '/home/u/.local/bin/wtd', icon: '/i.svg' }), 'Desktop Entry');
    expect(entry.get('Type')).toBe('Application');
    expect(entry.get('Name')).toBe('worktree-term');
    expect(entry.get('Terminal')).toBe('false');
    expect(entry.get('StartupWMClass')).toBe('chrome-127.0.0.1__-Default');
  });
});

/** An `ExecStart` value split into arguments, as systemd.service defines, with specifiers and `$$` resolved. */
const execStartArguments = (value: string): string[] => {
  const args: string[] = [];
  let arg: string | null = null;
  let quote: string | null = null;
  const ESCAPES: Record<string, string> = { n: '\n', t: '\t', s: ' ', '\\': '\\', '"': '"', "'": "'", r: '\r' };
  for (let at = 0; at < value.length; at++) {
    const c = value[at] ?? '';
    if (c === '\\') {
      const next = value[++at] ?? '';
      if (next === 'x') {
        arg = (arg ?? '') + String.fromCharCode(Number.parseInt(value.slice(at + 1, at + 3), 16));
        at += 2;
      } else {
        const escaped = ESCAPES[next];
        if (escaped === undefined) throw new Error(`bad escape \\${next} in ${value}`);
        arg = (arg ?? '') + escaped;
      }
    } else if (quote !== null) {
      if (c === quote) quote = null;
      else arg = (arg ?? '') + c;
    } else if (c === '"' || c === "'") {
      quote = c;
      arg ??= '';
    } else if (c === ' ' || c === '\t') {
      if (arg !== null) args.push(arg);
      arg = null;
    } else arg = (arg ?? '') + c;
  }
  if (quote !== null) throw new Error(`unterminated quote in ${value}`);
  if (arg !== null) args.push(arg);
  return args.map((a) => {
    if (
      /%[^%]/.test(a.replaceAll('%%', '')) ||
      /\$[^$]/.test(a.replaceAll('$$', '')) ||
      /[%$]$/.test(a.replaceAll('%%', '').replaceAll('$$', ''))
    ) {
      throw new Error(`unresolved specifier or variable in ${a}`);
    }
    return a.replaceAll('%%', '%').replaceAll('$$', '$');
  });
};

describe('systemdUnit', () => {
  it.each(AWKWARD)('runs the shim with daemon from a home whose path contains %j', (part) => {
    const shim = `/home/u ${part}/.local/bin/wtd`;
    const service = section(systemdUnit(shim), 'Service');
    expect(execStartArguments(service.get('ExecStart') ?? '')).toEqual([shim, 'daemon']);
  });

  it('restarts only on failure and is wanted by default.target', () => {
    const unit = systemdUnit('/home/u/.local/bin/wtd');
    expect(section(unit, 'Service').get('Restart')).toBe('on-failure');
    expect(section(unit, 'Install').get('WantedBy')).toBe('default.target');
  });
});

describe('release names', () => {
  it('are the version and 12 random lowercase hex digits', () => {
    const a = releaseName('0.2.0');
    const b = releaseName('0.2.0');
    expect(a).toMatch(/^0\.2\.0-[0-9a-f]{12}$/);
    expect(b).toMatch(/^0\.2\.0-[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
  });
});

describe('releasesToRemove', () => {
  it('keeps the new release and the one current pointed to before', () => {
    expect(
      releasesToRemove(['0.1.0-aaaaaaaaaaaa', '0.2.0-bbbbbbbbbbbb', '0.2.0-cccccccccccc'], '0.2.0-cccccccccccc', '0.2.0-bbbbbbbbbbbb'),
    ).toEqual(['0.1.0-aaaaaaaaaaaa']);
  });

  it('keeps only the new release on a first installation', () => {
    expect(releasesToRemove(['0.1.0-aaaaaaaaaaaa', '0.2.0-bbbbbbbbbbbb'], '0.2.0-bbbbbbbbbbbb', null)).toEqual(['0.1.0-aaaaaaaaaaaa']);
  });

  it('ignores a previous release that no longer exists', () => {
    expect(releasesToRemove(['0.1.0-aaaaaaaaaaaa', '0.2.0-bbbbbbbbbbbb'], '0.2.0-bbbbbbbbbbbb', '0.0.9-dddddddddddd')).toEqual([
      '0.1.0-aaaaaaaaaaaa',
    ]);
  });

  it('leaves releases still being assembled alone', () => {
    expect(releasesToRemove(['.0.3.0-eeeeeeeeeeee', '0.2.0-bbbbbbbbbbbb'], '0.2.0-bbbbbbbbbbbb', null)).toEqual([]);
  });
});

describe('test helpers', () => {
  it('parse a quoted Desktop Entry Exec and a systemd ExecStart', () => {
    expect(execArguments(desktopString('"/a b/\\\\$x" ui'))).toEqual(['/a b/$x', 'ui']);
    expect(execStartArguments('"/a b/$$x%%" daemon')).toEqual(['/a b/$x%', 'daemon']);
    expect(() => execArguments('/a b/x ui')).not.toThrow();
    expect(() => execArguments('/a$b ui')).toThrow();
    expect(() => execStartArguments('/a/$HOME daemon')).toThrow();
  });
});
