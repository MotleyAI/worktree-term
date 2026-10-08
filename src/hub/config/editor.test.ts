import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ConfigEditor, ConfigError } from './index.js';

const HOME = '/home/u';

let dir: string;
let path: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'wtd-editor-')));
  path = join(dir, 'worktree-term', 'config.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const write = (value: unknown): void => {
  mkdirSync(join(dir, 'worktree-term'), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
};

const read = (): unknown => JSON.parse(readFileSync(path, 'utf8'));
const text = (): string => readFileSync(path, 'utf8');
const keysOf = (value: unknown): string[] => (typeof value === 'object' && value !== null ? Object.keys(value) : []);
const reposOf = (value: unknown): string[] => z.object({ repos: z.array(z.string()) }).parse(value).repos;
const editor = (hooks?: ConstructorParameters<typeof ConfigEditor>[2]): ConfigEditor => new ConfigEditor(path, HOME, hooks);

const paths = (n: number): string[] => Array.from({ length: n }, (_, i) => `/r/${String(i)}`);

const OTHERS = {
  port: 9000,
  roots: ['~/src'],
  presets: [{ name: 'claude', command: 'claude' }],
  hosts: [
    { name: 'box', ssh: 'box.example.org', repos: ['/srv/a'], roots: ['~'] },
    { name: 'gpu', ssh: 'gpu' },
  ],
};

describe('ConfigEditor adding repos', () => {
  it('creates an absent file, owner-only, holding the added repo', async () => {
    expect(await editor().addRepo(null, '/r/app')).toEqual({ changed: true, repos: ['/r/app'] });
    expect(read()).toEqual({ repos: ['/r/app'] });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('keeps every other value as written, ~/ forms unexpanded, and indents by 2 spaces', async () => {
    const { port, ...others } = OTHERS;
    write({ port, repos: ['~/a'], ...others });
    const result = await editor().addRepo(null, '/r/b');
    expect(result).toEqual({ changed: true, repos: ['/home/u/a', '/r/b'] });
    const expected = { port, repos: ['~/a', '/r/b'], ...others };
    expect(read()).toEqual(expected);
    expect(keysOf(read())).toEqual(Object.keys(expected));
    expect(text().trimEnd()).toBe(JSON.stringify(expected, null, 2));
  });

  it('adds to the named remote host only', async () => {
    write(OTHERS);
    expect(await editor().addRepo('box', '/srv/b')).toEqual({ changed: true, repos: ['/srv/a', '/srv/b'] });
    expect(read()).toEqual({ ...OTHERS, hosts: [{ ...OTHERS.hosts[0], repos: ['/srv/a', '/srv/b'] }, OTHERS.hosts[1]] });
  });

  it('creates the repos of a remote host that has none', async () => {
    write(OTHERS);
    expect(await editor().addRepo('gpu', '/data/x')).toEqual({ changed: true, repos: ['/data/x'] });
    expect(read()).toEqual({ ...OTHERS, hosts: [OTHERS.hosts[0], { name: 'gpu', ssh: 'gpu', repos: ['/data/x'] }] });
  });

  it.each([
    ['as given', ['/r/a'], '/r/a'],
    ['by a ~/ form expanding to it', ['~/a'], '/home/u/a'],
  ])('leaves a repo already listed %s unchanged', async (_name, repos, repo) => {
    write({ repos });
    const before = text();
    const mtime = statSync(path).mtimeMs;
    expect((await editor().addRepo(null, repo)).changed).toBe(false);
    expect(text()).toBe(before);
    expect(statSync(path).mtimeMs).toBe(mtime);
  });

  it('refuses a 257th repo for a host, leaving the file unchanged', async () => {
    write({ repos: paths(256) });
    const before = text();
    const edits = editor();
    await expect(edits.addRepo(null, '/r/new')).rejects.toBeInstanceOf(ConfigError);
    await expect(edits.addRepo(null, '/r/new')).rejects.toThrow(/256/);
    expect(text()).toBe(before);
  });

  it.each([
    ['an unknown key', JSON.stringify({ theme: 'dark' }), 'theme'],
    ['invalid JSON', '{"repos":', 'JSON'],
  ])('refuses to edit a file with %s, naming the problem and leaving it unchanged', async (_name, content, problem) => {
    write(content);
    const edits = editor();
    await expect(edits.addRepo(null, '/r/a')).rejects.toThrow(problem);
    expect(text()).toBe(content);
  });

  it('refuses to edit a host the file no longer lists, naming it', async () => {
    write({ hosts: [{ name: 'gpu', ssh: 'gpu' }] });
    const before = text();
    const edits = editor();
    await expect(edits.addRepo('box', '/srv/a')).rejects.toThrow('box');
    expect(text()).toBe(before);
  });

  it('replaces an existing looser file with an owner-only one', async () => {
    write({ repos: [] });
    chmodSync(path, 0o644);
    await editor().addRepo(null, '/r/a');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe('ConfigEditor removing repos', () => {
  it('removes every entry naming the repo, as given or by a ~/ form', async () => {
    write({ repos: ['~/app', '/r/x', '/home/u/app'], ...OTHERS });
    expect(await editor().removeRepo(null, '/home/u/app')).toEqual({ changed: true, repos: ['/r/x'] });
    expect(read()).toEqual({ repos: ['/r/x'], ...OTHERS });
  });

  it('removes from the named remote host only', async () => {
    write({ repos: ['/srv/a'], ...OTHERS });
    expect(await editor().removeRepo('box', '/srv/a')).toEqual({ changed: true, repos: [] });
    expect(read()).toEqual({ repos: ['/srv/a'], ...OTHERS, hosts: [{ ...OTHERS.hosts[0], repos: [] }, OTHERS.hosts[1]] });
  });

  it('leaves the file unchanged for a repo it does not list', async () => {
    write({ repos: ['/r/a'] });
    const before = text();
    expect(await editor().removeRepo(null, '/r/b')).toEqual({ changed: false, repos: ['/r/a'] });
    expect(text()).toBe(before);
  });

  it('creates no file when removing from an absent one', async () => {
    expect(await editor().removeRepo(null, '/r/a')).toEqual({ changed: false, repos: [] });
    expect(existsSync(path)).toBe(false);
  });
});

const SHELL = { name: 'shell', command: null };
const CLAUDE = { name: 'claude', command: 'claude' };
const CODEX = { name: 'codex', command: 'codex' };
const presetList = (n: number): { name: string; command: string | null }[] =>
  Array.from({ length: n }, (_, i) => ({ name: `p${String(i)}`, command: null }));

describe('ConfigEditor editing presets', () => {
  it('appends to the defaults when the file has no presets, creating it owner-only', async () => {
    const added = { name: 'htop', command: 'htop' };
    expect(await editor().addPreset(added)).toEqual({ changed: true, presets: [SHELL, CLAUDE, CODEX, added] });
    expect(read()).toEqual({ presets: [SHELL, CLAUDE, CODEX, added] });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('appends to the listed presets, keeping every other value as written', async () => {
    write(OTHERS);
    const added = { name: 'plain', command: null };
    expect(await editor().addPreset(added)).toEqual({ changed: true, presets: [CLAUDE, added] });
    const expected = { ...OTHERS, presets: [CLAUDE, added] };
    expect(read()).toEqual(expected);
    expect(keysOf(read())).toEqual(Object.keys(expected));
  });

  it('refuses a name that is taken, leaving the file unchanged', async () => {
    write({ presets: [CLAUDE] });
    const before = text();
    const edit = editor();
    await expect(edit.addPreset({ name: 'claude', command: 'other' })).rejects.toThrow('a preset named claude exists');
    expect(text()).toBe(before);
  });

  it('refuses a 65th preset', async () => {
    write({ presets: presetList(64) });
    const edit = editor();
    await expect(edit.addPreset({ name: 'one more', command: null })).rejects.toBeInstanceOf(ConfigError);
    expect(z.object({ presets: z.array(z.unknown()) }).parse(read()).presets).toHaveLength(64);
  });

  it('removes a preset by name, from the defaults when the file has none', async () => {
    write({ repos: ['/r/a'] });
    expect(await editor().removePreset('claude')).toEqual({ changed: true, presets: [SHELL, CODEX] });
    expect(read()).toEqual({ repos: ['/r/a'], presets: [SHELL, CODEX] });
  });

  it('leaves the file unchanged for a name it does not list', async () => {
    write({ presets: [CLAUDE, SHELL] });
    const before = text();
    expect(await editor().removePreset('nope')).toEqual({ changed: false, presets: [CLAUDE, SHELL] });
    expect(text()).toBe(before);
  });

  it('creates no file when removing an unknown name from an absent one', async () => {
    expect(await editor().removePreset('nope')).toEqual({ changed: false, presets: [SHELL, CLAUDE, CODEX] });
    expect(existsSync(path)).toBe(false);
  });

  it('refuses to remove the last preset', async () => {
    write({ presets: [CLAUDE] });
    const edit = editor();
    await expect(edit.removePreset('claude')).rejects.toThrow('the last preset cannot be removed');
    expect(read()).toEqual({ presets: [CLAUDE] });
  });

  it('refuses to edit an invalid file', async () => {
    write({ presets: [] });
    const edit = editor();
    await expect(edit.addPreset(SHELL)).rejects.toBeInstanceOf(ConfigError);
  });

  it.each([
    ['to the front', 'codex', 0, [CODEX, SHELL, CLAUDE]],
    ['to the end', 'shell', 2, [CLAUDE, CODEX, SHELL]],
    ['to the end from beyond it', 'shell', 63, [CLAUDE, CODEX, SHELL]],
    ['one down', 'shell', 1, [CLAUDE, SHELL, CODEX]],
  ])('moves a preset %s, starting from the defaults', async (_name, preset, to, expected) => {
    expect(await editor().movePreset(preset, to)).toEqual({ changed: true, presets: expected });
    expect(read()).toEqual({ presets: expected });
  });

  it('leaves the file unchanged for a move in place or an unknown name', async () => {
    write({ presets: [CLAUDE, SHELL] });
    const before = text();
    expect(await editor().movePreset('claude', 0)).toEqual({ changed: false, presets: [CLAUDE, SHELL] });
    expect(await editor().movePreset('shell', 5)).toEqual({ changed: false, presets: [CLAUDE, SHELL] });
    expect(await editor().movePreset('nope', 0)).toEqual({ changed: false, presets: [CLAUDE, SHELL] });
    expect(text()).toBe(before);
  });

  it('applies concurrent preset and repo edits one at a time, losing none', async () => {
    const shared = editor();
    await Promise.all([shared.addPreset({ name: 'a', command: null }), shared.addRepo(null, '/r/1'), shared.removePreset('codex')]);
    expect(read()).toEqual({ presets: [SHELL, CLAUDE, { name: 'a', command: null }], repos: ['/r/1'] });
  });
});

describe('ConfigEditor with other writers', () => {
  it('starts over from a file changed between its read and its replacement, keeping both changes', async () => {
    write({ repos: ['/r/a'] });
    const attempts: number[] = [];
    const result = await editor({
      beforeReplace: (attempt) => {
        attempts.push(attempt);
        if (attempt === 1) writeFileSync(path, JSON.stringify({ repos: ['/r/a'], presets: [{ name: 'p', command: null }] }));
      },
    }).addRepo(null, '/r/b');
    expect(attempts).toEqual([1, 2]);
    expect(result).toEqual({ changed: true, repos: ['/r/a', '/r/b'] });
    expect(read()).toEqual({ repos: ['/r/a', '/r/b'], presets: [{ name: 'p', command: null }] });
  });

  it('gives up after 3 attempts, leaving the other writer’s content', async () => {
    write({ repos: [] });
    let n = 0;
    const attempts: number[] = [];
    const editing = editor({
      beforeReplace: (attempt) => {
        attempts.push(attempt);
        writeFileSync(path, JSON.stringify({ repos: [`/w/${String(++n)}`] }));
      },
    }).addRepo(null, '/r/b');
    await expect(editing).rejects.toBeInstanceOf(ConfigError);
    expect(attempts).toEqual([1, 2, 3]);
    expect(read()).toEqual({ repos: ['/w/3'] });
  });

  it('applies concurrent edits one at a time, losing none', async () => {
    write({ repos: [] });
    const shared = editor();
    await Promise.all([shared.addRepo(null, '/r/1'), shared.addRepo(null, '/r/2'), shared.addRepo('box', '/s/1').catch(() => undefined)]);
    expect(reposOf(read()).sort()).toEqual(['/r/1', '/r/2']);
  });
});

describe('ConfigEditor lists', () => {
  it('tells whether a host lists a repo, as given or by a ~/ form for the local host', async () => {
    write({ repos: ['~/a', '/r/b'], hosts: [{ name: 'box', ssh: 'box', repos: ['/srv/a'] }] });
    expect(await editor().lists(null, '/home/u/a')).toBe(true);
    expect(await editor().lists(null, '/r/b')).toBe(true);
    expect(await editor().lists(null, '/srv/a')).toBe(false);
    expect(await editor().lists('box', '/srv/a')).toBe(true);
    expect(await editor().lists('box', '/r/b')).toBe(false);
  });

  it('lists nothing for an absent file', async () => {
    expect(await editor().lists(null, '/r/a')).toBe(false);
  });

  it('refuses an invalid file or a host it no longer lists', async () => {
    const edits = editor();
    write({ theme: 'dark' });
    await expect(edits.lists(null, '/r/a')).rejects.toThrow('theme');
    write({ hosts: [] });
    await expect(edits.lists('box', '/r/a')).rejects.toThrow('box');
  });
});
