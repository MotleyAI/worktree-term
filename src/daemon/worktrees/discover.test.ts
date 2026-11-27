import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverRepos } from './index.js';

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'wtd-discover-')));
});

afterEach(() => {
  vi.unstubAllEnvs();
  chmodSync(root, 0o700);
  rmSync(root, { recursive: true, force: true });
});

/** A directory recognised as a repository: it contains a `.git` directory. */
const repo = (...parts: string[]): string => {
  const path = join(root, ...parts);
  mkdirSync(join(path, '.git'), { recursive: true });
  return path;
};

const bare = (...parts: string[]): string => {
  const path = join(root, ...parts);
  mkdirSync(path, { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', path]);
  return path;
};

const shuffled = <T>(values: readonly T[]): T[] =>
  values
    .map((value) => ({ value, key: Math.random() }))
    .sort((x, y) => x.key - y.key)
    .map(({ value }) => value);

/** Discovery entries for repositories without an origin. */
const found = (...paths: string[]): { path: string; origin: null }[] => paths.map((path) => ({ path, origin: null }));

describe('discoverRepos', () => {
  it('respects depth, counting the root as level 0', async () => {
    const one = repo('a');
    const two = repo('b', 'c');
    repo('d', 'e', 'f');
    expect(await discoverRepos([root], 2)).toEqual(found(one, two));
    expect(await discoverRepos([root], 1)).toEqual(found(one));
  });

  it('reports a root that is itself a repository without searching inside it', async () => {
    const top = repo('top');
    repo('top', 'nested');
    expect(await discoverRepos([top], 3)).toEqual(found(top));
  });

  it('does not descend into a found repository', async () => {
    const outer = repo('outer');
    repo('outer', 'inner');
    expect(await discoverRepos([root], 3)).toEqual(found(outer));
  });

  it('does not report directories holding a .git file', async () => {
    const real = repo('real');
    mkdirSync(join(root, 'linked'));
    writeFileSync(join(root, 'linked', '.git'), 'gitdir: /elsewhere\n');
    expect(await discoverRepos([root], 2)).toEqual(found(real));
  });

  it('reports bare repositories', async () => {
    const plain = repo('plain');
    const b = bare('b.git');
    expect(await discoverRepos([root], 2)).toEqual(found(...[b, plain].sort()));
  });

  it('skips symbolic links, hidden directories and node_modules', async () => {
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'wtd-elsewhere-')));
    try {
      mkdirSync(join(elsewhere, 'target', '.git'), { recursive: true });
      symlinkSync(join(elsewhere, 'target'), join(root, 'link'));
      symlinkSync(elsewhere, join(root, 'linkdir'));
      repo('.hidden', 'r');
      repo('node_modules', 'pkg');
      repo('src', 'node_modules', 'pkg');
      const kept = repo('kept');
      expect(await discoverRepos([root], 4)).toEqual(found(kept));
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('reports repos under a root given through a symbolic link by their real paths', async () => {
    const one = repo('real', 'one');
    const link = join(root, 'link');
    symlinkSync(join(root, 'real'), link);
    expect(await discoverRepos([link, `${root}/real/.`], 1)).toEqual(found(one));
  });

  it('skips missing roots', async () => {
    const one = repo('one');
    expect(await discoverRepos([join(root, 'missing'), root], 1)).toEqual(found(one));
  });

  it.skipIf(process.getuid?.() === 0)('skips unreadable directories', async () => {
    const one = repo('one');
    repo('locked', 'inside');
    chmodSync(join(root, 'locked'), 0o000);
    try {
      expect(await discoverRepos([root], 3)).toEqual(found(one));
    } finally {
      chmodSync(join(root, 'locked'), 0o700);
    }
  });

  it('returns repositories sorted and without duplicates across overlapping roots', async () => {
    const b = repo('x', 'b');
    const a = repo('x', 'a');
    const c = repo('c');
    expect(await discoverRepos([join(root, 'x'), root], 2)).toEqual(found(...[c, a, b].sort()));
  });

  it('caps the result at the first 4096 repositories in sorted order, deterministically', async () => {
    const names = Array.from({ length: 4100 }, (_, i) => `r${String(i).padStart(4, '0')}`);
    for (const name of shuffled(names)) repo(name);
    const expected = found(...names.slice(0, 4096).map((name) => join(root, name)));
    const first = await discoverRepos([root], 1);
    const second = await discoverRepos([root], 1);
    expect(first).toEqual(expected);
    expect(second).toEqual(expected);
  }, 30_000);

  describe('home-relative roots', () => {
    beforeEach(() => {
      mkdirSync(join(root, 'home'));
      vi.stubEnv('HOME', join(root, 'home'));
    });

    it('expands ~ and ~/… against the home directory and reports each repo once', async () => {
      const app = repo('home', 'GitHub', 'app');
      expect(await discoverRepos(['~', '~/GitHub'], 3)).toEqual(found(app));
    });

    it('counts depth from the expanded root', async () => {
      const near = repo('home', 'near');
      repo('home', 'a', 'b', 'far');
      expect(await discoverRepos(['~'], 2)).toEqual(found(near));
    });

    it('reports repos by their real paths when the home is a symbolic link', async () => {
      const app = repo('realhome', 'src', 'app');
      vi.stubEnv('HOME', join(root, 'linkhome'));
      symlinkSync(join(root, 'realhome'), join(root, 'linkhome'));
      expect(await discoverRepos(['~/src'], 1)).toEqual(found(app));
    });

    it('skips a missing home-relative root', async () => {
      const one = repo('home', 'one');
      expect(await discoverRepos(['~/missing', '~'], 1)).toEqual(found(one));
    });
  });

  describe('origins', () => {
    /** Writes `url` as the `origin` of the repository whose config file is `config`. */
    const setOrigin = (config: string, url: string): void => {
      writeFileSync(config, `[remote "origin"]\n\turl = ${url}\n`);
    };

    it('reports each repository with its origin, null without one', async () => {
      const app = repo('app');
      setOrigin(join(app, '.git', 'config'), 'https://github.com/acme/app.git');
      const plain = repo('plain');
      expect(await discoverRepos([root], 1)).toEqual([
        { path: app, origin: 'github.com/acme/app' },
        { path: plain, origin: null },
      ]);
    });

    it('reads a bare repository origin from its config', async () => {
      const b = bare('b.git');
      setOrigin(join(b, 'config'), 'git@github.com:Acme/B.git');
      expect(await discoverRepos([root], 1)).toEqual([{ path: b, origin: 'github.com/Acme/B' }]);
    });

    it('gives a null origin for a local or unsupported origin URL', async () => {
      const local = repo('local');
      setOrigin(join(local, '.git', 'config'), '/srv/app.git');
      const ftp = repo('ftp');
      setOrigin(join(ftp, '.git', 'config'), 'ftp://host/app');
      expect(await discoverRepos([root], 1)).toEqual([
        { path: ftp, origin: null },
        { path: local, origin: null },
      ]);
    });
  });
});
