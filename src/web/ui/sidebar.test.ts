import { describe, expect, it } from 'vitest';
import type { Terminal, Worktree } from '../../protocol/index.js';
import { defaultWorktree, sidebarEntries, visibleWorktrees, worktreeLabel, type SidebarEntry } from './sidebar.js';

const REPO = '/home/u/repo';
const HEAD = '0123456789abcdef0123456789abcdef01234567';

const worktree = (path: string, fields: Partial<Worktree> = {}): Worktree => ({
  path,
  head: HEAD,
  branch: null,
  detached: false,
  locked: false,
  prunable: false,
  bare: false,
  main: false,
  ...fields,
});

const terminal = (termId: number, path: string, exit: Terminal['exit'] = null): Terminal => ({
  termId,
  worktree: path,
  preset: 'shell',
  cols: 80,
  rows: 24,
  exit,
  unseen: false,
  state: 'idle',
});

const main = worktree(REPO, { branch: 'main', main: true });
const feature = worktree(`${REPO}.worktrees/x`, { branch: 'feature/x' });
const detached = worktree(`${REPO}.worktrees/wt2`, { detached: true });
const prunable = worktree('/gone/wt3', { branch: 'old', prunable: true });

describe('worktreeLabel', () => {
  it.each([
    ['its branch', feature, 'feature/x'],
    ['its directory and short head when detached', detached, 'wt2 @ 0123456'],
    ['its directory without a head', worktree(`${REPO}.worktrees/new`, { head: null }), 'new'],
    ['its directory when detached without a head', worktree(`${REPO}.worktrees/odd`, { head: null, detached: true }), 'odd'],
  ])('labels a worktree by %s', (_name, w, label) => {
    expect(worktreeLabel(w)).toBe(label);
  });
});

describe('sidebarEntries', () => {
  const entry = (w: Worktree, fields: Partial<SidebarEntry> = {}): SidebarEntry => ({
    path: w.path,
    label: worktreeLabel(w),
    prunable: w.prunable,
    gone: false,
    checked: false,
    ...fields,
  });

  it('lists worktrees in the daemon’s order without bare entries', () => {
    const bare = worktree('/srv/repo.git', { bare: true, head: null });
    expect(sidebarEntries({ worktrees: [main, bare, feature, detached], terminals: [], checked: [] })).toEqual([
      entry(main),
      entry(feature),
      entry(detached),
    ]);
  });

  it('reflects the checked state and marks prunable worktrees', () => {
    expect(sidebarEntries({ worktrees: [main, prunable], terminals: [], checked: [prunable.path] })).toEqual([
      entry(main),
      entry(prunable, { prunable: true, checked: true }),
    ]);
  });

  it('lists a vanished worktree with live terminals after the others, as gone and unchecked', () => {
    const vanished = `${REPO}.worktrees/vanished`;
    const entries = sidebarEntries({
      worktrees: [main, feature],
      terminals: [terminal(1, vanished), terminal(2, feature.path), terminal(3, vanished, { code: 0, signal: null })],
      checked: [vanished],
    });
    expect(entries.map((e) => e.path)).toEqual([main.path, feature.path, vanished]);
    expect(entries[2]).toEqual({ path: vanished, label: 'vanished', prunable: false, gone: true, checked: false });
  });

  it('keeps a vanished worktree while only an exited terminal remains', () => {
    const vanished = '/x/old';
    const entries = sidebarEntries({ worktrees: [main], terminals: [terminal(3, vanished, { code: 1, signal: null })], checked: [] });
    expect(entries.map((e) => e.path)).toEqual([main.path, vanished]);
  });

  it('drops a vanished worktree once its last terminal is closed', () => {
    expect(sidebarEntries({ worktrees: [main], terminals: [], checked: ['/x/old'] }).map((e) => e.path)).toEqual([main.path]);
  });

  it('lists each vanished worktree once', () => {
    const entries = sidebarEntries({
      worktrees: [],
      terminals: [terminal(1, '/x/a'), terminal(2, '/x/a'), terminal(3, '/x/b')],
      checked: [],
    });
    expect(entries.map((e) => e.path).sort()).toEqual(['/x/a', '/x/b']);
  });
});

describe('visibleWorktrees', () => {
  const entries: SidebarEntry[] = [
    { path: '/a', label: 'a', prunable: false, gone: false, checked: true },
    { path: '/b', label: 'b', prunable: false, gone: false, checked: false },
    { path: '/c', label: 'c', prunable: true, gone: false, checked: true },
    { path: '/d', label: 'd', prunable: false, gone: true, checked: false },
  ];

  it('lists every entry with the all filter', () => {
    expect(visibleWorktrees(entries, 'all', null)).toEqual(entries);
  });

  it('lists only checked entries with the checked filter', () => {
    expect(visibleWorktrees(entries, 'checked', null).map((e) => e.path)).toEqual(['/a', '/c']);
  });

  it('keeps the selected entry listed with the checked filter', () => {
    expect(visibleWorktrees(entries, 'checked', '/b').map((e) => e.path)).toEqual(['/a', '/b', '/c']);
    expect(visibleWorktrees(entries, 'checked', '/d').map((e) => e.path)).toEqual(['/a', '/c', '/d']);
  });
});

describe('defaultWorktree', () => {
  const entry = (path: string, checked: boolean): SidebarEntry => ({ path, label: path, prunable: false, gone: false, checked });

  it('selects the first entry the filter shows', () => {
    const entries = [entry('/a', false), entry('/b', true)];
    expect(defaultWorktree(entries, 'all')).toBe('/a');
    expect(defaultWorktree(entries, 'checked')).toBe('/b');
  });

  it('selects the first entry when the checked filter shows none', () => {
    expect(defaultWorktree([entry('/a', false), entry('/b', false)], 'checked')).toBe('/a');
  });

  it('selects nothing without entries', () => {
    expect(defaultWorktree([], 'checked')).toBeNull();
  });
});
