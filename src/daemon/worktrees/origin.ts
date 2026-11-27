import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_ORIGIN = 4096;

const DEFAULT_PORTS: Readonly<Record<string, number>> = {
  ssh: 22,
  'git+ssh': 22,
  'ssh+git': 22,
  git: 9418,
  http: 80,
  https: 443,
};

/** Whitespace, control characters, `?` and `#` make an origin URL unusable. */
const UNUSABLE = /[\s\p{Cc}?#]/u;

/** `host[:port]` split, the host lowercased and an IPv6 host kept bracketed; null when malformed. */
const splitHost = (authority: string): { host: string; port: string } | null => {
  let host: string;
  let rest: string;
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']');
    if (end < 0) return null;
    host = authority.slice(0, end + 1);
    rest = authority.slice(end + 1);
  } else {
    const colon = authority.indexOf(':');
    host = colon < 0 ? authority : authority.slice(0, colon);
    rest = colon < 0 ? '' : authority.slice(colon);
  }
  if (host === '' || host === '[]') return null;
  if (rest === '') return { host: host.toLowerCase(), port: '' };
  if (!/^:\d*$/.test(rest)) return null;
  return { host: host.toLowerCase(), port: rest.slice(1) };
};

/** The path without leading `/` and `~/`, trailing `/` and one trailing `.git`. */
const trimPath = (path: string): string => {
  let trimmed = path;
  while (trimmed.startsWith('/') || trimmed.startsWith('~/')) trimmed = trimmed.slice(trimmed.startsWith('/') ? 1 : 2);
  while (trimmed.endsWith('/')) trimmed = trimmed.slice(0, -1);
  return trimmed.endsWith('.git') ? trimmed.slice(0, -'.git'.length) : trimmed;
};

const withoutUser = (text: string): string => text.slice(text.lastIndexOf('@') + 1);

const originOf = (host: string, port: string, path: string): string | null => {
  const trimmed = trimPath(path);
  if (trimmed === '') return null;
  const hostPort = port === '' ? host : `${host}:${port}`;
  const origin = `${hostPort}/${trimmed}`;
  return origin.length > MAX_ORIGIN ? null : origin;
};

const fromUrl = (scheme: string, rest: string): string | null => {
  const defaultPort = DEFAULT_PORTS[scheme.toLowerCase()];
  if (defaultPort === undefined) return null;
  const slash = rest.indexOf('/');
  if (slash < 0) return null;
  const parts = splitHost(withoutUser(rest.slice(0, slash)));
  if (parts === null) return null;
  const digits = parts.port.replace(/^0+(?=\d)/, '');
  const port = digits === String(defaultPort) ? '' : digits;
  return originOf(parts.host, port, rest.slice(slash));
};

/** The `:` ending an SCP-like URL's host, past a bracketed IPv6 host; -1 when there is none. */
const scpSeparator = (url: string): number => {
  const colon = url.indexOf(':');
  const open = url.indexOf('[');
  if (open < 0 || colon < open) return colon;
  const close = url.indexOf(']', open);
  return close >= 0 && url.charAt(close + 1) === ':' ? close + 1 : -1;
};

const fromScpLike = (url: string): string | null => {
  const colon = scpSeparator(url);
  if (colon < 0 || url.slice(0, url.indexOf(':')).includes('/')) return null;
  const host = withoutUser(url.slice(0, colon));
  if (host === '') return null;
  return originOf(host.toLowerCase(), '', url.slice(colon + 1));
};

/** The normalized origin of a remote URL, or null for a local, unsupported or malformed one. */
export const normalizeOrigin = (url: string): string | null => {
  if (url === '' || UNUSABLE.test(url)) return null;
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(url);
  if (scheme !== null) return fromUrl(scheme[1] ?? '', url.slice(scheme[0].length));
  if (url.includes('://')) return null;
  return fromScpLike(url);
};

/** A git config value: quotes removed, escapes applied, a trailing comment and unquoted outer spaces dropped. */
const configValue = (raw: string): string => {
  const ESCAPES: Readonly<Record<string, string>> = { n: '\n', t: '\t', b: '\b', '\\': '\\', '"': '"' };
  let value = '';
  let kept = 0;
  let quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charAt(i);
    if (c === '\\' && i + 1 < raw.length) {
      value += ESCAPES[raw.charAt(++i)] ?? '';
      kept = value.length;
    } else if (c === '"') {
      quoted = !quoted;
      kept = value.length;
    } else if (!quoted && (c === ';' || c === '#')) {
      break;
    } else {
      value += c;
      if (quoted || !/\s/.test(c)) kept = value.length;
    }
  }
  return value.slice(0, kept).trimStart();
};

const SECTION = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/;
const KEY = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=(.*))?$/;

/** Whether `text` ends in a `\` escaping its line end: unescaped itself, and not inside a comment, which a line end closes. */
const continues = (text: string): boolean => {
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i);
    if (c === '\\') {
      if (i === text.length - 1) return true;
      i++;
    } else if (c === '"') {
      quoted = !quoted;
    } else if (!quoted && (c === ';' || c === '#')) {
      return false;
    }
  }
  return false;
};

/** Git config text as logical lines, continued lines joined. */
const logicalLines = (config: string): string[] => {
  const lines: string[] = [];
  let pending = '';
  for (const raw of config.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (continues(pending + line)) {
      pending += line.slice(0, -1);
    } else {
      lines.push(pending + line);
      pending = '';
    }
  }
  if (pending !== '') lines.push(pending);
  return lines;
};

/** The first `url` of `[remote "origin"]` in git config text, or null. */
const originUrl = (config: string): string | null => {
  let inOrigin = false;
  for (const line of logicalLines(config)) {
    let text = line.trim();
    if (text === '' || text.startsWith('#') || text.startsWith(';')) continue;
    const section = SECTION.exec(text);
    if (section !== null) {
      inOrigin = section[1]?.toLowerCase() === 'remote' && section[2] === 'origin';
      text = text.slice(section[0].length).trim();
    }
    const key = KEY.exec(text);
    if (inOrigin && key?.[1]?.toLowerCase() === 'url') return configValue(key[2] ?? '');
  }
  return null;
};

const MISSING = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EISDIR']);

const isMissing = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && typeof error.code === 'string' && MISSING.has(error.code);

/** The repository's own config file: `.git/config`, or `config` of a bare repository. */
const configFile = async (repo: string): Promise<string> => {
  try {
    if ((await stat(join(repo, '.git'))).isDirectory()) return join(repo, '.git', 'config');
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  return join(repo, 'config');
};

/** The normalized origin of the repository at `repo`, read from its config file without starting a process. */
export const readOrigin = async (repo: string): Promise<string | null> => {
  try {
    const url = originUrl(await readFile(await configFile(repo), 'utf8'));
    return url === null ? null : normalizeOrigin(url);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
};
