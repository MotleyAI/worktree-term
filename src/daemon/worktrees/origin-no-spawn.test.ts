import type * as ChildProcess from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { git, makeRepo } from '../../../test/support/daemon-host.js';
import { discoverRepos } from './index.js';
import { readOrigin } from './origin.js';

// While `forbidden`, every process start, promisified included, throws and is recorded in `attempts`.
const spawns = vi.hoisted((): { forbidden: boolean; attempts: string[] } => ({ forbidden: false, attempts: [] }));

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof ChildProcess>();
  const guard =
    <A extends unknown[], R>(name: string, start: (...args: A) => R) =>
    (...args: A): R => {
      if (spawns.forbidden) {
        spawns.attempts.push(name);
        throw new Error(`${name} called while process starts are forbidden`);
      }
      return start(...args);
    };
  const exec = Object.defineProperty(guard('exec', real.exec), promisify.custom, { value: guard('exec', promisify(real.exec)) });
  const execFile = Object.defineProperty(guard('execFile', real.execFile), promisify.custom, {
    value: guard('execFile', promisify(real.execFile)),
  });
  const guarded = {
    ...real,
    spawn: guard('spawn', real.spawn),
    spawnSync: guard('spawnSync', real.spawnSync),
    exec,
    execSync: guard('execSync', real.execSync),
    execFile,
    execFileSync: guard('execFileSync', real.execFileSync),
    fork: guard('fork', real.fork),
  };
  return { ...guarded, default: guarded };
});

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'wtd-no-spawn-')));
});

afterEach(() => {
  spawns.forbidden = false;
  spawns.attempts = [];
  rmSync(root, { recursive: true, force: true });
});

/** A repo with `origin` set by git, whose own processes run before process starts are forbidden. */
const repoWithOrigin = (name: string, url: string): string => {
  const repo = makeRepo(join(root, name));
  git(repo, 'remote', 'add', 'origin', url);
  return repo;
};

it('reads an origin without starting a process', async () => {
  const repo = repoWithOrigin('repo', 'git@github.com:Acme/App.git');
  spawns.forbidden = true;
  expect(await readOrigin(repo)).toBe('github.com/Acme/App');
  expect(spawns.attempts).toEqual([]);
});

it('reads a bare repository origin without starting a process', async () => {
  const bare = join(root, 'bare.git');
  git(root, 'init', '-q', '--bare', bare);
  git(bare, 'remote', 'add', 'origin', 'https://github.com/acme/app.git');
  spawns.forbidden = true;
  expect(await readOrigin(bare)).toBe('github.com/acme/app');
  expect(spawns.attempts).toEqual([]);
});

it('discovers repositories with their origins without starting a process', async () => {
  const a = repoWithOrigin('a', 'ssh://git@host:2222/a');
  const b = join(root, 'b.git');
  git(root, 'init', '-q', '--bare', b);
  writeFileSync(join(b, 'config'), '[remote "origin"]\n\turl = https://host/b\n');
  spawns.forbidden = true;
  expect(await discoverRepos([root], 1)).toEqual([
    { path: a, origin: 'host:2222/a' },
    { path: b, origin: 'host/b' },
  ]);
  expect(spawns.attempts).toEqual([]);
});
