import { describe, expect, it } from 'vitest';
import { branchCandidate, createdFrom } from './base.js';

describe('createdFrom', () => {
  it.each([
    ['a lone creation entry', 'branch: Created from feature-x\n', 'feature-x'],
    ['the oldest of several entries', 'commit: b\ncommit: a\nbranch: Created from release/1.2\n', 'release/1.2'],
    ['output without a final newline', 'commit: a\nbranch: Created from origin/main', 'origin/main'],
    ['a start point with revision syntax, verbatim', 'branch: Created from HEAD~1\n', 'HEAD~1'],
  ])('gives the start point of %s', (_name, reflog, ref) => {
    expect(createdFrom(reflog)).toBe(ref);
  });

  it.each([
    ['an empty reflog', ''],
    ['a reflog whose oldest entry is not a creation', 'branch: Created from feature-x\ncommit: a\n'],
    ['a rename', 'Branch: renamed refs/heads/a to refs/heads/b\n'],
    ['a reset', 'reset: moving to HEAD\n'],
    ['a creation without a start point', 'branch: Created from \n'],
    ['a message that only contains a creation', 'commit: branch: Created from feature-x\n'],
  ])('gives none for %s', (_name, reflog) => {
    expect(createdFrom(reflog)).toBeNull();
  });
});

describe('branchCandidate', () => {
  it.each([
    ['feature-x', 'feature-x'],
    ['origin/feature-x', 'feature-x'],
    ['refs/remotes/origin/x', 'x'],
    ['refs/heads/x', 'x'],
    ['release/1.2', 'release/1.2'],
    ['origin/release/1.2', 'release/1.2'],
    ['egor/feat.2', 'egor/feat.2'],
    ['upstream/main', 'upstream/main'],
  ])('takes %s as the branch %s', (ref, name) => {
    expect(branchCandidate(ref)).toBe(name);
  });

  it.each([
    ['HEAD'],
    ['origin/HEAD'],
    ['refs/remotes/origin/HEAD'],
    ['HEAD~1'],
    ['a^'],
    ['a^{commit}'],
    ['x:y'],
    ['a..b'],
    ['@{-1}'],
    ['main@{1}'],
    ['@'],
    [''],
    ['origin/'],
    ['refs/heads/'],
    ['a b'],
    ['a\tb'],
    ['a?'],
    ['a*'],
    ['a[b'],
    ['a\\b'],
    ['-x'],
    ['.x'],
    ['x/.y'],
    ['x/'],
    ['x//y'],
    ['x.lock'],
    ['x.'],
    ['a\u0001b'],
    ['a\u007fb'],
  ])('rejects %j', (ref) => {
    expect(branchCandidate(ref)).toBeNull();
  });
});
