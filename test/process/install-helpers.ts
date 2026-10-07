import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, linkSync, lstatSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import { alive, waitUntil } from '../support/daemon-host.js';
import { REPO_ROOT } from '../support/exec.js';
import { shellQuote } from '../support/fake-ssh.js';

export const UNIT_NAME = 'worktree-term-daemon.service';
export const WM_CLASS = 'chrome-127.0.0.1__-Default';
export const PTY_PACKAGE = join('node_modules', '@homebridge', 'node-pty-prebuilt-multiarch');

export const packageVersion = (): string => {
  const pkg: unknown = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  if (typeof pkg !== 'object' || pkg === null || !('version' in pkg) || typeof pkg.version !== 'string') throw new Error('no version');
  return pkg.version;
};

/** Asserts one line on the stream, without a stack trace. */
export const expectOneLine = (text: string): void => {
  expect(text.trimEnd()).not.toBe('');
  expect(text.trimEnd()).not.toContain('\n');
  expect(text).not.toMatch(/\n[ \t]+at /);
};

/** Where an installation in `home` puts its files. */
export const installPaths = (
  home: string,
  configHome = join(home, '.config'),
): { dataDir: string; versions: string; current: string; shim: string; launcher: string; unit: string } => {
  const dataDir = join(home, '.local', 'share', 'worktree-term');
  return {
    dataDir,
    versions: join(dataDir, 'versions'),
    current: join(dataDir, 'current'),
    shim: join(home, '.local', 'bin', 'wtd'),
    launcher: join(home, '.local', 'share', 'applications', 'worktree-term.desktop'),
    unit: join(configHome, 'systemd', 'user', UNIT_NAME),
  };
};

/** Release directory names under `versions/`, without in-progress dot-names, sorted. */
export const releasesIn = (versions: string): string[] =>
  existsSync(versions)
    ? readdirSync(versions)
        .filter((name) => !name.startsWith('.'))
        .sort()
    : [];

/** Every entry below `dir` (symbolic links not followed) with its type, mode and content digest or target. */
export const treeSnapshot = (dir: string): string[] => {
  if (!existsSync(dir)) return [];
  const entries: string[] = [];
  const walk = (relative: string): void => {
    for (const name of readdirSync(join(dir, relative)).sort()) {
      const path = relative === '' ? name : `${relative}/${name}`;
      const full = join(dir, path);
      const stats = lstatSync(full);
      const mode = (stats.mode & 0o7777).toString(8);
      if (stats.isSymbolicLink()) entries.push(`${path} link ${mode} -> ${readlinkSync(full)}`);
      else if (stats.isDirectory()) {
        entries.push(`${path} dir ${mode}`);
        walk(path);
      } else entries.push(`${path} file ${mode} ${createHash('sha256').update(readFileSync(full)).digest('hex')}`);
    }
  };
  walk('');
  return entries;
};

/** Directories below `dir`, symbolic links not followed, with their permission bits. */
export const directoryModes = (dir: string): [string, number][] => {
  const found: [string, number][] = [];
  const walk = (path: string): void => {
    const stats = lstatSync(path);
    if (!stats.isDirectory()) return;
    found.push([path, stats.mode & 0o777]);
    for (const name of readdirSync(path)) walk(join(path, name));
  };
  walk(dir);
  return found;
};

/** Pids of `… daemon` processes whose environment holds `XDG_STATE_HOME=<stateHome>`, however started. */
export const daemonPidsOf = (stateHome: string): number[] => {
  const pids: number[] = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const cmdline = readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0');
      if (cmdline[2] !== 'daemon') continue;
      const environ = readFileSync(`/proc/${name}/environ`, 'utf8').split('\0');
      if (environ.includes(`XDG_STATE_HOME=${stateHome}`) && alive(Number(name))) pids.push(Number(name));
    } catch {
      // The process exited while we looked.
    }
  }
  return pids;
};

export const killAll = async (pids: () => number[]): Promise<void> => {
  for (const pid of pids()) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  await waitUntil(() => pids().length === 0, 'processes to exit').catch(() => undefined);
};

/**
 * A fake `systemctl` recording each argv as a JSON line in `log`; `start` launches
 * `$HOME/.local/bin/wtd daemon` detached as the unit would; with `failOn` that subcommand exits 1.
 */
export const fakeSystemctl = (dir: string, log: string, failOn: string | null = null): string => {
  const path = join(dir, 'systemctl');
  const fail =
    failOn === null ? '' : `for a in "$@"; do [ "$a" = ${shellQuote(failOn)} ] && { echo "Failed to ${failOn}" >&2; exit 1; }; done\n`;
  writeFileSync(
    path,
    String.raw`#!/bin/sh
${shellQuote(process.execPath)} -e 'require("node:fs").appendFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)) + "\n")' ${shellQuote(log)} "$@"
${fail}for a in "$@"; do
  if [ "$a" = start ]; then setsid "$HOME/.local/bin/wtd" daemon </dev/null >/dev/null 2>&1 & exit 0; fi
done
exit 0
`,
  );
  chmodSync(path, 0o755);
  return path;
};

/** The argv of every recorded systemctl run, in order. */
export const systemctlCalls = (log: string): string[][] =>
  existsSync(log)
    ? readFileSync(log, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line): string[] => {
          const value: unknown = JSON.parse(line);
          if (!Array.isArray(value)) throw new Error(`bad systemctl log line ${line}`);
          return value.map(String);
        })
    : [];

/** A Node binary reachable at `<dir>/node` whose `process.execPath` is that path. */
export const nodeAt = (dir: string): string => {
  const path = join(dir, 'node');
  try {
    linkSync(process.execPath, path);
  } catch {
    copyFileSync(process.execPath, path);
    chmodSync(path, 0o755);
  }
  return path;
};

/** Key → value of `group` in an INI-like file (desktop entry or unit), values unprocessed. */
export const iniGroup = (text: string, group: string): Map<string, string> => {
  const values = new Map<string, string>();
  let current = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('#') || line.trim() === '') continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header?.[1] !== undefined) {
      current = header[1];
      continue;
    }
    const eq = line.indexOf('=');
    if (current === group && eq > 0) values.set(line.slice(0, eq).trim(), line.slice(eq + 1).trimStart());
  }
  return values;
};

/** A desktop entry string value with `\s \n \t \r \\` unescaped. */
export const desktopString = (raw: string): string =>
  raw.replace(/\\(.)/g, (_match, c: string) => ({ s: ' ', n: '\n', t: '\t', r: '\r', '\\': '\\' })[c] ?? `\\${c}`);

/** A read position in a text. */
class Scanner {
  pos = 0;

  constructor(readonly text: string) {}

  get done(): boolean {
    return this.pos >= this.text.length;
  }

  peek(): string {
    return this.text[this.pos] ?? '';
  }

  next(): string {
    const c = this.peek();
    this.pos++;
    return c;
  }

  take(count: number): string {
    const taken = this.text.slice(this.pos, this.pos + count);
    this.pos += count;
    return taken;
  }
}

/** Words split on unquoted `separators`; `word` reads on from the scanner, given the word so far. */
const splitWords = (text: string, separators: string, word: (s: Scanner, arg: string | null) => string): string[] => {
  const s = new Scanner(text);
  const args: string[] = [];
  let arg: string | null = null;
  while (!s.done) {
    if (separators.includes(s.peek())) {
      s.next();
      if (arg !== null) args.push(arg);
      arg = null;
    } else arg = word(s, arg);
  }
  if (arg !== null) args.push(arg);
  return args;
};

/** The rest of a quoted part up to `quote`, which is consumed; `escaped` reads after a backslash. */
const quoted = (s: Scanner, quote: string, escaped: (s: Scanner) => string, what: string): string => {
  let arg = '';
  while (!s.done && s.peek() !== quote) {
    const c = s.next();
    arg += c === '\\' ? escaped(s) : c;
  }
  if (s.done) throw new Error(`unterminated quote in ${what}`);
  s.next();
  return arg;
};

/** The argv of a desktop entry `Exec` value, per the Desktop Entry specification. */
export const desktopExec = (raw: string): string[] => {
  const what = `Exec ${raw}`;
  const escaped = (s: Scanner): string => ('"`$\\'.includes(s.peek()) ? s.next() : '\\');
  const args = splitWords(desktopString(raw), ' ', (s, arg) => {
    const c = s.next();
    return (arg ?? '') + (c === '"' ? quoted(s, '"', escaped, what) : c);
  });
  return args.map((a) => {
    if (/%[^%]/.test(a.replaceAll('%%', ''))) throw new Error(`field code in Exec argument ${a}`);
    return a.replaceAll('%%', '%');
  });
};

const C_ESCAPES: Record<string, string> = {
  a: '\x07',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
  s: ' ',
  '\\': '\\',
  '"': '"',
  "'": "'",
};

/** The argv of a systemd `ExecStart` value: quoting, C escapes, `%%` and `$$`. */
export const systemdExec = (raw: string): string[] => {
  const what = `ExecStart ${raw}`;
  const escaped = (s: Scanner): string => {
    const c = s.next();
    if (c === 'x') return String.fromCodePoint(Number.parseInt(s.take(2), 16));
    const mapped = C_ESCAPES[c];
    if (mapped === undefined) throw new Error(`unknown escape \\${c} in ${what}`);
    return mapped;
  };
  const args = splitWords(raw, ' \t', (s, arg) => {
    const c = s.next();
    if ((c === '"' || c === "'") && arg === null) return quoted(s, c, escaped, what);
    return (arg ?? '') + (c === '\\' ? escaped(s) : c);
  });
  return args.map((a) => {
    if (/%[^%]/.test(a.replaceAll('%%', ''))) throw new Error(`specifier in ExecStart argument ${a}`);
    if (/\$[^$]/.test(a.replaceAll('$$', ''))) throw new Error(`variable in ExecStart argument ${a}`);
    return a.replaceAll('%%', '%').replaceAll('$$', '$');
  });
};
