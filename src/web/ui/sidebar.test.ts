import { describe, expect, it } from 'vitest';
import type { Terminal, Worktree } from '../../protocol/index.js';
import {
  clampSidebarWidth,
  defaultWorktree,
  filterOf,
  keptNote,
  parseSidebarWidth,
  removalReasons,
  SIDEBAR_WIDTH,
  sidebarEntries,
  visibleWorktrees,
  withFilter,
  worktreeLabel,
  type SidebarEntry,
} from './sidebar.js';

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

describe('clampSidebarWidth', () => {
  it.each([
    ['keeps a width within bounds', 300, 300],
    ['rounds to a whole pixel', 300.6, 301],
    ['raises a width below the minimum', 20, SIDEBAR_WIDTH.min],
    ['lowers a width above the maximum', 5000, SIDEBAR_WIDTH.max],
    ['raises a negative width', -50, SIDEBAR_WIDTH.min],
  ])('%s', (_name, width, expected) => {
    expect(clampSidebarWidth(width)).toBe(expected);
  });
});

describe('parseSidebarWidth', () => {
  it.each([
    ['a stored width', '320', 320],
    ['the default when nothing is stored', null, SIDEBAR_WIDTH.initial],
    ['the default for an empty value', '', SIDEBAR_WIDTH.initial],
    ['the default for a non-number', 'wide', SIDEBAR_WIDTH.initial],
    ['the default for a fraction', '300.5', SIDEBAR_WIDTH.initial],
    ['the default for a negative number', '-300', SIDEBAR_WIDTH.initial],
    ['the default for an overlong number', '1e999', SIDEBAR_WIDTH.initial],
    ['a stored width held within bounds', '9999', SIDEBAR_WIDTH.max],
  ])('reads %s', (_name, stored, expected) => {
    expect(parseSidebarWidth(stored)).toBe(expected);
  });
});

describe('repo filters', () => {
  it('shows all in a repo without an entry or with an unknown value', () => {
    expect(filterOf({}, '0:/a')).toBe('all');
    expect(filterOf({ '0:/a': 'odd' }, '0:/a')).toBe('all');
  });

  it('sets one repo to checked without touching the others', () => {
    const filters = withFilter({ '0:/b': 'checked' }, '0:/a', 'checked');
    expect(filters).toEqual({ '0:/a': 'checked', '0:/b': 'checked' });
    expect(filterOf(filters, '0:/a')).toBe('checked');
    expect(filterOf(filters, '1:/a')).toBe('all');
  });

  it('drops the entry of a repo set back to all', () => {
    expect(withFilter({ '0:/a': 'checked', '0:/b': 'checked' }, '0:/a', 'all')).toEqual({ '0:/b': 'checked' });
  });
});

describe('removalReasons', () => {
  const safe = { base: 'origin/main', ahead: 0, changes: 0, running: [] };

  it('gives no reason for a merged, clean worktree without running terminals', () => {
    expect(removalReasons(safe)).toEqual([]);
  });

  it('names every reason that applies, in order', () => {
    expect(removalReasons({ base: 'origin/main', ahead: 3, changes: 2, running: ['claude 3', 'shell 4'] })).toEqual([
      'It has 3 commits not in origin/main.',
      'It has 2 uncommitted changes, untracked files included.',
      'Running terminals will be closed: claude 3, shell 4.',
    ]);
  });

  it('uses the singular for one commit or change', () => {
    expect(removalReasons({ ...safe, ahead: 1, changes: 1 })).toEqual([
      'It has 1 commit not in origin/main.',
      'It has 1 uncommitted change, untracked files included.',
    ]);
  });

  it('says when there is no origin/main to compare with', () => {
    expect(removalReasons({ ...safe, base: null, ahead: null })).toEqual(['There is no origin/main to check that its commits are merged.']);
  });
});

describe('keptNote', () => {
  it('says the branch is kept, or that a detached worktree leaves its commits only in the reflog', () => {
    expect(keptNote(false)).toBe('Its branch is kept.');
    expect(keptNote(true)).toContain('reachable only through the reflog');
  });
});
