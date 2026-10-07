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
    write({ port: 9000, repos: ['~/a'], ...OTHERS });
    const result = await editor().addRepo(null, '/r/b');
    expect(result).toEqual({ changed: true, repos: ['/home/u/a', '/r/b'] });
    const expected = { port: 9000, repos: ['~/a', '/r/b'], ...OTHERS };
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
    await expect(editor().addRepo(null, '/r/new')).rejects.toBeInstanceOf(ConfigError);
    await expect(editor().addRepo(null, '/r/new')).rejects.toThrow(/256/);
    expect(text()).toBe(before);
  });

  it.each([
    ['an unknown key', JSON.stringify({ theme: 'dark' }), 'theme'],
    ['invalid JSON', '{"repos":', 'JSON'],
  ])('refuses to edit a file with %s, naming the problem and leaving it unchanged', async (_name, content, problem) => {
    write(content);
    await expect(editor().addRepo(null, '/r/a')).rejects.toThrow(problem);
    expect(text()).toBe(content);
  });

  it('refuses to edit a host the file no longer lists, naming it', async () => {
    write({ hosts: [{ name: 'gpu', ssh: 'gpu' }] });
    const before = text();
    await expect(editor().addRepo('box', '/srv/a')).rejects.toThrow('box');
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
