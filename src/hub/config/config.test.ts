import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, ConfigSource, DEFAULT_PORT, loadConfig, parseConfig } from './index.js';

const HOME = '/home/u';

let dir: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'wtd-config-')));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const parse = (value: unknown): ReturnType<typeof parseConfig> => parseConfig(JSON.stringify(value), HOME);

/** The ConfigError message `value` is refused with. */
const problem = (text: string | null): string => {
  try {
    parseConfig(text, HOME);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return error instanceof Error ? error.message : '';
  }
  throw new Error(`accepted ${String(text)}`);
};

const paths = (n: number): string[] => Array.from({ length: n }, (_, i) => `/r/${String(i)}`);

describe('parseConfig', () => {
  it('uses port 7417 and no repos for a missing file', () => {
    expect(DEFAULT_PORT).toBe(7417);
    expect(parseConfig(null, HOME)).toEqual({ port: 7417, repos: [] });
  });

  it('uses the defaults for an empty object', () => {
    expect(parse({})).toEqual({ port: 7417, repos: [] });
  });

  it.each([1024, 8080, 65535])('accepts port %d', (port) => {
    expect(parse({ port }).port).toBe(port);
  });

  it.each([
    ['1023', 1023],
    ['65536', 65536],
    ['fractional', 8080.5],
    ['a string', '8080'],
    ['null', null],
  ])('refuses a %s port, naming the key', (_name, port) => {
    expect(problem(JSON.stringify({ port }))).toContain('port');
  });

  it('keeps absolute repo paths in order', () => {
    expect(parse({ repos: ['/b/app', '/a/app'] }).repos).toEqual(['/b/app', '/a/app']);
  });

  it('expands ~/ against the home directory', () => {
    expect(parse({ repos: ['~/src/app'] }).repos).toEqual(['/home/u/src/app']);
  });

  it('does not resolve symbolic links', () => {
    mkdirSync(join(dir, 'real', 'repo'), { recursive: true });
    symlinkSync(join(dir, 'real'), join(dir, 'link'));
    expect(parseConfig(JSON.stringify({ repos: [join(dir, 'link', 'repo'), '~/repo'] }), join(dir, 'link')).repos).toEqual([
      join(dir, 'link', 'repo'),
      join(dir, 'link', 'repo'),
    ]);
  });

  it.each([
    ['a relative path', 'src/app'],
    ['an empty path', ''],
    ['a bare ~', '~'],
    ['another user’s home', '~bob/app'],
    ['a path with NUL', '/a\u0000b'],
    ['a path over 4096 characters', '/' + 'a'.repeat(4096)],
    ['a number', 7],
  ])('refuses %s as a repo, naming the key', (_name, repo) => {
    expect(problem(JSON.stringify({ repos: [repo] }))).toContain('repos');
  });

  it('accepts 256 repos and refuses 257', () => {
    expect(parse({ repos: paths(256) }).repos).toHaveLength(256);
    expect(problem(JSON.stringify({ repos: paths(257) }))).toContain('repos');
  });

  it('refuses repos that are not a list', () => {
    expect(problem(JSON.stringify({ repos: '/a' }))).toContain('repos');
  });

  it('refuses an unknown key, naming it', () => {
    expect(problem(JSON.stringify({ port: 8080, presets: [] }))).toContain('presets');
  });

  it.each([
    ['an array', '[]'],
    ['null', 'null'],
    ['a number', '1'],
    ['a string', '"x"'],
    ['invalid JSON', '{"port":'],
  ])('refuses %s', (_name, text) => {
    expect(problem(text)).not.toBe('');
  });

  it('states its problem on one line', () => {
    expect(problem(JSON.stringify({ port: 1, repos: ['x'], extra: 1 }))).not.toContain('\n');
  });
});

describe('loadConfig', () => {
  it('uses the defaults for a missing file without creating it or its directory', async () => {
    const path = join(dir, 'worktree-term', 'config.json');
    expect(await loadConfig(path, HOME)).toEqual({ port: 7417, repos: [] });
    expect(existsSync(join(dir, 'worktree-term'))).toBe(false);
  });

  it('reads the file', async () => {
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify({ port: 9000, repos: ['~/app'] }));
    expect(await loadConfig(path, HOME)).toEqual({ port: 9000, repos: ['/home/u/app'] });
  });

  it('fails with one line naming the file and the problem', async () => {
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify({ presets: [] }));
    const loading = loadConfig(path, HOME);
    await expect(loading).rejects.toBeInstanceOf(ConfigError);
    await expect(loadConfig(path, HOME)).rejects.toThrow(path);
    await expect(loadConfig(path, HOME)).rejects.toThrow('presets');
    await expect(loadConfig(path, HOME)).rejects.toThrow(/^[^\n]*$/);
  });
});

describe('ConfigSource', () => {
  const write = (path: string, value: unknown): void => {
    writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
  };

  it('snapshots the file as it is when asked', async () => {
    const path = join(dir, 'config.json');
    write(path, { repos: ['/a'] });
    const source = new ConfigSource(path, HOME, await loadConfig(path, HOME));
    write(path, { repos: ['/a', '/b'] });
    expect(await source.snapshot()).toEqual({ config: { port: 7417, repos: ['/a', '/b'] }, problem: null });
  });

  it('keeps the last valid configuration and reports the problem of an invalid file', async () => {
    const path = join(dir, 'config.json');
    write(path, { repos: ['/a'] });
    const source = new ConfigSource(path, HOME, await loadConfig(path, HOME));
    write(path, { repos: ['/a', '/b'] });
    await source.snapshot();
    write(path, { repos: ['relative'] });
    const snapshot = await source.snapshot();
    expect(snapshot.config).toEqual({ port: 7417, repos: ['/a', '/b'] });
    expect(snapshot.problem).toContain('repos');
    write(path, '{');
    expect((await source.snapshot()).config.repos).toEqual(['/a', '/b']);
    write(path, { repos: ['/c'] });
    expect(await source.snapshot()).toEqual({ config: { port: 7417, repos: ['/c'] }, problem: null });
  });

  it('uses the defaults once the file is removed', async () => {
    const path = join(dir, 'config.json');
    write(path, { port: 9000, repos: ['/a'] });
    const source = new ConfigSource(path, HOME, await loadConfig(path, HOME));
    rmSync(path);
    expect(await source.snapshot()).toEqual({ config: { port: 7417, repos: [] }, problem: null });
  });
});
