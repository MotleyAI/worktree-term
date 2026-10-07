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

describe('discoverRepos', () => {
  it('respects depth, counting the root as level 0', async () => {
    const one = repo('a');
    const two = repo('b', 'c');
    repo('d', 'e', 'f');
    expect(await discoverRepos([root], 2)).toEqual([one, two]);
    expect(await discoverRepos([root], 1)).toEqual([one]);
  });

  it('reports a root that is itself a repository without searching inside it', async () => {
    const top = repo('top');
    repo('top', 'nested');
    expect(await discoverRepos([top], 3)).toEqual([top]);
  });

  it('does not descend into a found repository', async () => {
    const outer = repo('outer');
    repo('outer', 'inner');
    expect(await discoverRepos([root], 3)).toEqual([outer]);
  });

  it('does not report directories holding a .git file', async () => {
    const real = repo('real');
    mkdirSync(join(root, 'linked'));
    writeFileSync(join(root, 'linked', '.git'), 'gitdir: /elsewhere\n');
    expect(await discoverRepos([root], 2)).toEqual([real]);
  });

  it('reports bare repositories', async () => {
    const plain = repo('plain');
    const b = bare('b.git');
    expect(await discoverRepos([root], 2)).toEqual([b, plain].sort());
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
      expect(await discoverRepos([root], 4)).toEqual([kept]);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('reports repos under a root given through a symbolic link by their real paths', async () => {
    const one = repo('real', 'one');
    const link = join(root, 'link');
    symlinkSync(join(root, 'real'), link);
    expect(await discoverRepos([link, `${root}/real/.`], 1)).toEqual([one]);
  });

  it('skips missing roots', async () => {
    const one = repo('one');
    expect(await discoverRepos([join(root, 'missing'), root], 1)).toEqual([one]);
  });

  it.skipIf(process.getuid?.() === 0)('skips unreadable directories', async () => {
    const one = repo('one');
    repo('locked', 'inside');
    chmodSync(join(root, 'locked'), 0o000);
    try {
      expect(await discoverRepos([root], 3)).toEqual([one]);
    } finally {
      chmodSync(join(root, 'locked'), 0o700);
    }
  });

  it('returns repositories sorted and without duplicates across overlapping roots', async () => {
    const b = repo('x', 'b');
    const a = repo('x', 'a');
    const c = repo('c');
    expect(await discoverRepos([join(root, 'x'), root], 2)).toEqual([c, a, b].sort());
  });

  it('caps the result at the first 4096 repositories in sorted order, deterministically', async () => {
    const names = Array.from({ length: 4100 }, (_, i) => `r${String(i).padStart(4, '0')}`);
    for (const name of shuffled(names)) repo(name);
    const expected = names.slice(0, 4096).map((name) => join(root, name));
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
      expect(await discoverRepos(['~', '~/GitHub'], 3)).toEqual([app]);
    });

    it('counts depth from the expanded root', async () => {
      const near = repo('home', 'near');
      repo('home', 'a', 'b', 'far');
      expect(await discoverRepos(['~'], 2)).toEqual([near]);
    });

    it('reports repos by their real paths when the home is a symbolic link', async () => {
      const app = repo('realhome', 'src', 'app');
      vi.stubEnv('HOME', join(root, 'linkhome'));
      symlinkSync(join(root, 'realhome'), join(root, 'linkhome'));
      expect(await discoverRepos(['~/src'], 1)).toEqual([app]);
    });

    it('skips a missing home-relative root', async () => {
      const one = repo('home', 'one');
      expect(await discoverRepos(['~/missing', '~'], 1)).toEqual([one]);
    });
  });
});
