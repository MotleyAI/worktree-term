import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

const SHELL = [{ name: 'shell', command: null }];
const CLAUDE = { name: 'claude', command: 'claude' };

const presets = (n: number): { name: string; command: string | null }[] =>
  Array.from({ length: n }, (_, i) => ({ name: `p${String(i)}`, command: null }));

describe('parseConfig', () => {
  it('uses port 7417, no repos and the shell preset for a missing file', () => {
    expect(DEFAULT_PORT).toBe(7417);
    expect(parseConfig(null, HOME)).toEqual({ port: 7417, repos: [], presets: SHELL });
  });

  it('uses the defaults for an empty object', () => {
    expect(parse({})).toEqual({ port: 7417, repos: [], presets: SHELL });
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
    expect(problem(JSON.stringify({ port: 8080, theme: 'dark' }))).toContain('theme');
  });

  it('keeps exactly the listed presets in their order', () => {
    expect(parse({ presets: [CLAUDE, ...SHELL] }).presets).toEqual([CLAUDE, ...SHELL]);
    expect(parse({ presets: [CLAUDE] }).presets).toEqual([CLAUDE]);
  });

  it('accepts names that differ only by case or whitespace', () => {
    const list = [
      { name: 'a', command: null },
      { name: 'A', command: null },
      { name: 'a ', command: 'x' },
    ];
    expect(parse({ presets: list }).presets).toEqual(list);
  });

  it('accepts names and commands at their length limits, keeping them as written', () => {
    const list = [
      { name: 'n'.repeat(64), command: 'c'.repeat(4096) },
      { name: ' a ', command: 'x' },
    ];
    expect(parse({ presets: list }).presets).toEqual(list);
  });

  it('accepts 64 presets and refuses 65', () => {
    expect(parse({ presets: presets(64) }).presets).toEqual(presets(64));
    expect(problem(JSON.stringify({ presets: presets(65) }))).toContain('presets');
  });

  it.each([
    ['an empty list', []],
    [
      'two presets named a',
      [
        { name: 'a', command: null },
        { name: 'a', command: 'x' },
      ],
    ],
    ['a blank name', [{ name: '   ', command: null }]],
    ['a name of tabs and spaces', [{ name: ' \t ', command: null }]],
    ['an empty name', [{ name: '', command: null }]],
    ['a name over 64 characters', [{ name: 'n'.repeat(65), command: null }]],
    ['an empty command', [{ name: 'a', command: '' }]],
    ['a command over 4096 characters', [{ name: 'a', command: 'c'.repeat(4097) }]],
    ['an unknown key in a preset', [{ name: 'a', command: null, icon: 'x' }]],
    ['a preset that is not an object', ['a']],
    ['a single object instead of a list', { name: 'a', command: null }],
  ])('refuses %s as presets, naming the key', (_name, value) => {
    const message = problem(JSON.stringify({ presets: value }));
    expect(message).toContain('presets');
    expect(message).not.toContain('\n');
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
    expect(await loadConfig(path, HOME)).toEqual({ port: 7417, repos: [], presets: SHELL });
    expect(existsSync(join(dir, 'worktree-term'))).toBe(false);
  });

  it('reads the file', async () => {
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify({ port: 9000, repos: ['~/app'], presets: [CLAUDE] }));
    expect(await loadConfig(path, HOME)).toEqual({ port: 9000, repos: ['/home/u/app'], presets: [CLAUDE] });
  });

  it('fails with one line naming the file and the problem', async () => {
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify({ theme: 'dark' }));
    const loading = loadConfig(path, HOME);
    await expect(loading).rejects.toBeInstanceOf(ConfigError);
    await expect(loadConfig(path, HOME)).rejects.toThrow(path);
    await expect(loadConfig(path, HOME)).rejects.toThrow('theme');
    await expect(loadConfig(path, HOME)).rejects.toThrow(/^[^\n]*$/);
  });

  it('fails with one line naming the file and presets for invalid presets', async () => {
    const path = join(dir, 'config.json');
    writeFileSync(
      path,
      JSON.stringify({
        presets: [
          { name: 'a', command: null },
          { name: 'a', command: null },
        ],
      }),
    );
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
    expect(await source.snapshot()).toEqual({ config: { port: 7417, repos: ['/a', '/b'], presets: SHELL }, problem: null });
  });

  it('keeps the last valid configuration and reports the problem of an invalid file', async () => {
    const path = join(dir, 'config.json');
    write(path, { repos: ['/a'] });
    const source = new ConfigSource(path, HOME, await loadConfig(path, HOME));
    write(path, { repos: ['/a', '/b'] });
    await source.snapshot();
    write(path, { repos: ['relative'] });
    const snapshot = await source.snapshot();
    expect(snapshot.config).toEqual({ port: 7417, repos: ['/a', '/b'], presets: SHELL });
    expect(snapshot.problem).toContain('repos');
    write(path, '{');
    expect((await source.snapshot()).config.repos).toEqual(['/a', '/b']);
    write(path, { repos: ['/c'] });
    expect(await source.snapshot()).toEqual({ config: { port: 7417, repos: ['/c'], presets: SHELL }, problem: null });
  });

  it('snapshots edited presets and keeps the last valid ones when they become invalid', async () => {
    const path = join(dir, 'config.json');
    write(path, { repos: ['/a'] });
    const source = new ConfigSource(path, HOME, await loadConfig(path, HOME));
    write(path, { repos: ['/a'], presets: [CLAUDE, ...SHELL] });
    expect(await source.snapshot()).toEqual({ config: { port: 7417, repos: ['/a'], presets: [CLAUDE, ...SHELL] }, problem: null });
    write(path, { repos: ['/b'], presets: [{ name: 'claude', command: '' }] });
    const snapshot = await source.snapshot();
    expect(snapshot.config).toEqual({ port: 7417, repos: ['/a'], presets: [CLAUDE, ...SHELL] });
    expect(snapshot.problem).toContain('presets');
  });

  it('uses the defaults once the file is removed', async () => {
    const path = join(dir, 'config.json');
    write(path, { port: 9000, repos: ['/a'], presets: [CLAUDE] });
    const source = new ConfigSource(path, HOME, await loadConfig(path, HOME));
    rmSync(path);
    expect(await source.snapshot()).toEqual({ config: { port: 7417, repos: [], presets: SHELL }, problem: null });
  });
});

describe('README', () => {
  const readme = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8');

  /** The text of the section headed `## <title>`. */
  const section = (title: string): string => {
    const start = readme.indexOf(`## ${title}\n`);
    if (start < 0) throw new Error(`README has no section ${title}`);
    const end = readme.indexOf('\n## ', start + 1);
    return readme.slice(start, end < 0 ? undefined : end);
  };

  const jsonBlocks = (text: string): string[] => [...text.matchAll(/^```json\n([\s\S]*?)^```$/gm)].map((m) => m[1] ?? '');

  it('closes every code fence', () => {
    expect(readme.match(/^```/gm)?.length ?? 0).toSatisfy((n: number) => n % 2 === 0);
  });

  it('gives configuration examples that the hub accepts', () => {
    const blocks = jsonBlocks(section('Configuration'));
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) expect(() => parseConfig(block, HOME)).not.toThrow();
    expect(parseConfig(blocks[0] ?? '', HOME).presets).toEqual([CLAUDE, ...SHELL]);
  });

  it('tells Claude Code to ring the bell', () => {
    const [settings] = jsonBlocks(section('Attention marks'));
    expect(JSON.parse(settings ?? '')).toEqual({ preferredNotifChannel: 'terminal_bell' });
  });
});
