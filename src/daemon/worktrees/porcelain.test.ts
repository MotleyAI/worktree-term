import { describe, expect, it } from 'vitest';
import type { Worktree } from '../../protocol/index.js';
import { parsePorcelain } from './porcelain.js';

const SHA = '21b291c738b8fe3a902069e3ed3e9889fa61045c';
const SHA256 = '0123456789abcdef'.repeat(4);

/** `git worktree list --porcelain -z` output for records given as attribute lines. */
const porcelain = (...records: string[][]): string => records.map((lines) => lines.map((line) => `${line}\0`).join('') + '\0').join('');

const entry = (fields: Partial<Worktree> & Pick<Worktree, 'path'>): Worktree => ({
  head: SHA,
  branch: null,
  detached: false,
  locked: false,
  prunable: false,
  bare: false,
  main: false,
  ...fields,
});

describe('parsePorcelain', () => {
  it('reports the main worktree first and marks it main', () => {
    const text = porcelain(['worktree /r', `HEAD ${SHA}`, 'branch refs/heads/main'], ['worktree /w', `HEAD ${SHA}`, 'branch refs/heads/b']);
    expect(parsePorcelain(text)).toEqual([entry({ path: '/r', branch: 'main', main: true }), entry({ path: '/w', branch: 'b' })]);
  });

  it('strips refs/heads/ from branches whose names contain a slash', () => {
    const text = porcelain(['worktree /r', `HEAD ${SHA}`, 'branch refs/heads/feature/x/y']);
    expect(parsePorcelain(text)[0]?.branch).toBe('feature/x/y');
  });

  it('reports a detached worktree without a branch', () => {
    const text = porcelain(['worktree /r', `HEAD ${SHA}`, 'branch refs/heads/main'], ['worktree /d', `HEAD ${SHA}`, 'detached']);
    expect(parsePorcelain(text)[1]).toEqual(entry({ path: '/d', detached: true }));
  });

  it.each([
    ['without a reason', 'locked'],
    ['with a reason', 'locked on usb stick'],
  ])('reports a worktree locked %s', (_name, line) => {
    const text = porcelain(
      ['worktree /r', `HEAD ${SHA}`, 'branch refs/heads/main'],
      ['worktree /l', `HEAD ${SHA}`, 'branch refs/heads/l', line],
    );
    expect(parsePorcelain(text)[1]).toEqual(entry({ path: '/l', branch: 'l', locked: true }));
  });

  it('reports a prunable worktree', () => {
    const text = porcelain(
      ['worktree /r', `HEAD ${SHA}`, 'branch refs/heads/main'],
      ['worktree /p', `HEAD ${SHA}`, 'branch refs/heads/p', 'prunable gitdir file points to non-existent location'],
    );
    expect(parsePorcelain(text)[1]).toEqual(entry({ path: '/p', branch: 'p', prunable: true }));
  });

  it('reports a worktree both locked and prunable', () => {
    const text = porcelain(
      ['worktree /r', `HEAD ${SHA}`, 'branch refs/heads/main'],
      ['worktree /p', `HEAD ${SHA}`, 'detached', 'locked', 'prunable gone'],
    );
    expect(parsePorcelain(text)[1]).toEqual(entry({ path: '/p', detached: true, locked: true, prunable: true }));
  });

  it('reports a bare repository without head or branch', () => {
    expect(parsePorcelain(porcelain(['worktree /r.git', 'bare']))).toEqual([entry({ path: '/r.git', head: null, bare: true, main: true })]);
  });

  it.each([
    ['SHA-1', '0'.repeat(40)],
    ['SHA-256', '0'.repeat(64)],
  ])('reports an unborn %s branch with a null head', (_name, zero) => {
    const text = porcelain(['worktree /r', `HEAD ${zero}`, 'branch refs/heads/main']);
    expect(parsePorcelain(text)).toEqual([entry({ path: '/r', head: null, branch: 'main', main: true })]);
  });

  it('reports a SHA-256 head', () => {
    const text = porcelain(['worktree /r', `HEAD ${SHA256}`, 'branch refs/heads/main']);
    expect(parsePorcelain(text)[0]?.head).toBe(SHA256);
  });

  it.each([
    ['spaces', '/home/u/with space/wt'],
    ['a newline', '/home/u/new\nline'],
    ['a trailing space', '/home/u/wt '],
  ])('reports a path with %s exactly', (_name, path) => {
    const text = porcelain(['worktree /r', `HEAD ${SHA}`, 'branch refs/heads/main'], [`worktree ${path}`, `HEAD ${SHA}`, 'detached']);
    expect(parsePorcelain(text)[1]?.path).toBe(path);
  });

  it('ignores attributes it does not know', () => {
    const text = porcelain(['worktree /r', `HEAD ${SHA}`, 'branch refs/heads/main', 'sparse', 'future-thing with value']);
    expect(parsePorcelain(text)).toEqual([entry({ path: '/r', branch: 'main', main: true })]);
  });

  it('parses empty output as no worktrees', () => {
    expect(parsePorcelain('')).toEqual([]);
  });

  it.each([
    ['a record without a worktree line', porcelain([`HEAD ${SHA}`, 'branch refs/heads/main'])],
    ['a relative worktree path', porcelain(['worktree rel', `HEAD ${SHA}`, 'detached'])],
    ['a malformed head', porcelain(['worktree /r', 'HEAD xyz', 'detached'])],
    ['an unterminated record', 'worktree /r\0HEAD ' + SHA],
  ])('rejects %s', (_name, text) => {
    expect(() => parsePorcelain(text)).toThrow();
  });
});
