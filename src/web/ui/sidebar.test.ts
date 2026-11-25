import { describe, expect, it } from 'vitest';
import type { Terminal, Worktree } from '../../protocol/index.js';
import {
  clampSidebarWidth,
  defaultRow,
  defaultWorktree,
  groupRows,
  isFilterOn,
  keptNote,
  matchesSearch,
  parseSidebarWidth,
  removalReasons,
  rowKey,
  searchOf,
  SIDEBAR_WIDTH,
  sidebarEntries,
  visibleRows,
  visibleWorktrees,
  withFilter,
  withSearch,
  worktreeLabel,
  type SidebarEntry,
  type WorktreeFilter,
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

const terminal = (termId: number, path: string, exit: Terminal['exit'] = null, fields: Partial<Terminal> = {}): Terminal => ({
  termId,
  worktree: path,
  preset: 'shell',
  cols: 80,
  rows: 24,
  exit,
  unseen: false,
  state: 'idle',
  ...fields,
});

const NONE: WorktreeFilter = { checked: false, open: false };
const STARRED: WorktreeFilter = { checked: true, open: false };
const OPEN: WorktreeFilter = { checked: false, open: true };
const STARRED_OPEN: WorktreeFilter = { checked: true, open: true };

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
    hasTerminals: false,
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
      terminals: [terminal(1, vanished), terminal(2, feature.path), terminal(3, vanished, { code: 0, signal: null, oom: false })],
      checked: [vanished],
    });
    expect(entries.map((e) => e.path)).toEqual([main.path, feature.path, vanished]);
    expect(entries[2]).toEqual({ path: vanished, label: 'vanished', prunable: false, gone: true, checked: false, hasTerminals: true });
  });

  it('keeps a vanished worktree while only an exited terminal remains', () => {
    const vanished = '/x/old';
    const entries = sidebarEntries({
      worktrees: [main],
      terminals: [terminal(3, vanished, { code: 1, signal: null, oom: false })],
      checked: [],
    });
    expect(entries.map((e) => e.path)).toEqual([main.path, vanished]);
  });

  it('drops a vanished worktree once its last terminal is closed', () => {
    expect(sidebarEntries({ worktrees: [main], terminals: [], checked: ['/x/old'] }).map((e) => e.path)).toEqual([main.path]);
  });

  const FAILED_EXIT = { code: 1, signal: null, oom: false };

  it.each<[string, Terminal]>([
    ['waiting for input', terminal(1, feature.path, null, { state: 'input' })],
    ['working', terminal(1, feature.path, null, { state: 'working' })],
    ['idle with unseen output', terminal(1, feature.path, null, { unseen: true })],
    ['idle and seen', terminal(1, feature.path)],
    ['exited with an error and unseen', terminal(1, feature.path, FAILED_EXIT, { unseen: true })],
    ['exited with an error and seen', terminal(1, feature.path, FAILED_EXIT)],
  ])('has terminals for a worktree whose only terminal is %s', (_name, term) => {
    const entries = sidebarEntries({ worktrees: [main, feature], terminals: [term], checked: [] });
    expect(entries.map((e) => [e.path, e.hasTerminals])).toEqual([
      [main.path, false],
      [feature.path, true],
    ]);
  });

  it('has terminals for every worktree with some, gone ones included, and none for the others', () => {
    const entries = sidebarEntries({
      worktrees: [main, feature, detached],
      terminals: [terminal(1, detached.path), terminal(2, '/x/gone'), terminal(3, detached.path)],
      checked: [],
    });
    expect(entries.map((e) => [e.path, e.hasTerminals])).toEqual([
      [main.path, false],
      [feature.path, false],
      [detached.path, true],
      ['/x/gone', true],
    ]);
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
    { path: '/a', label: 'a', prunable: false, gone: false, checked: true, hasTerminals: true },
    { path: '/b', label: 'b', prunable: false, gone: false, checked: false, hasTerminals: false },
    { path: '/c', label: 'c', prunable: true, gone: false, checked: true, hasTerminals: false },
    { path: '/d', label: 'd', prunable: false, gone: true, checked: false, hasTerminals: true },
  ];
  const listed = (filter: WorktreeFilter, selected: string | null = null): string[] =>
    visibleWorktrees(entries, filter, '', selected).map((e) => e.path);

  it('lists every entry with both switches off', () => {
    expect(visibleWorktrees(entries, NONE, '', null)).toEqual(entries);
  });

  it('lists only checked entries with "Starred" on', () => {
    expect(visibleWorktrees(entries, STARRED, '', null).map((e) => e.path)).toEqual(['/a', '/c']);
  });

  it('keeps the selected entry listed with "Starred" on', () => {
    expect(visibleWorktrees(entries, STARRED, '', '/b').map((e) => e.path)).toEqual(['/a', '/b', '/c']);
    expect(visibleWorktrees(entries, STARRED, '', '/d').map((e) => e.path)).toEqual(['/a', '/c', '/d']);
  });

  it('lists only entries with terminals, gone ones included, with "Open" on', () => {
    expect(listed(OPEN)).toEqual(['/a', '/d']);
  });

  it('lists only checked entries with terminals with both switches on', () => {
    expect(listed(STARRED_OPEN)).toEqual(['/a']);
  });

  it('keeps the selected entry listed with "Open" on, alone or with "Starred"', () => {
    expect(listed(OPEN, '/b')).toEqual(['/a', '/b', '/d']);
    expect(listed(STARRED_OPEN, '/c')).toEqual(['/a', '/c']);
    expect(listed(STARRED_OPEN, '/b')).toEqual(['/a', '/b']);
  });

  describe('with a name search', () => {
    const named: SidebarEntry[] = [
      { path: '/m', label: 'main', prunable: false, gone: false, checked: false, hasTerminals: false },
      { path: '/f', label: 'feature/Login', prunable: false, gone: false, checked: true, hasTerminals: false },
      { path: '/g', label: 'fix/logout', prunable: false, gone: false, checked: false, hasTerminals: true },
      { path: '/h', label: 'wt2 @ 0123456', prunable: false, gone: false, checked: true, hasTerminals: true },
    ];
    const paths = (filter: WorktreeFilter, search: string, selected: string | null = null): string[] =>
      visibleWorktrees(named, filter, search, selected).map((e) => e.path);

    it('lists the entries whose label contains the search, ignoring case', () => {
      expect(paths(NONE, 'log')).toEqual(['/f', '/g']);
      expect(paths(NONE, 'LOGIN')).toEqual(['/f']);
      expect(paths(NONE, '@ 0123')).toEqual(['/h']);
    });

    it('searches the directory labels of detached and gone worktrees', () => {
      const built = sidebarEntries({ worktrees: [main, detached], terminals: [terminal(1, '/gone/wt3')], checked: [] });
      expect(visibleWorktrees(built, NONE, 'WT2 @', null).map((e) => e.path)).toEqual([detached.path]);
      expect(visibleWorktrees(built, NONE, 'wt3', null).map((e) => e.path)).toEqual(['/gone/wt3']);
    });

    it('ignores surrounding whitespace, and a blank search lists every entry', () => {
      expect(paths(NONE, '  fix ')).toEqual(['/g']);
      expect(paths(NONE, '   ')).toEqual(['/m', '/f', '/g', '/h']);
    });

    it('lists nothing when no label matches', () => {
      expect(paths(NONE, 'nope')).toEqual([]);
    });

    it('applies together with the checked filter', () => {
      expect(paths(STARRED, 'log')).toEqual(['/f']);
    });

    it('keeps the selected entry listed when it does not match', () => {
      expect(paths(NONE, 'log', '/m')).toEqual(['/m', '/f', '/g']);
      expect(paths(STARRED, 'log', '/g')).toEqual(['/f', '/g']);
    });

    it('applies together with "Open", alone or with "Starred"', () => {
      expect(paths(OPEN, 'o')).toEqual(['/g']);
      expect(paths(OPEN, '0123')).toEqual(['/h']);
      expect(paths(STARRED_OPEN, 'log')).toEqual([]);
      expect(paths(STARRED_OPEN, 'log', '/f')).toEqual(['/f']);
      expect(paths(STARRED_OPEN, '')).toEqual(['/h']);
    });
  });
});

describe('defaultWorktree', () => {
  const entry = (path: string, checked: boolean, hasTerminals = false): SidebarEntry => ({
    path,
    label: path,
    prunable: false,
    gone: false,
    checked,
    hasTerminals,
  });

  it('selects the first entry the filter shows', () => {
    const entries = [entry('/a', false), entry('/b', true)];
    expect(defaultWorktree(entries, NONE)).toBe('/a');
    expect(defaultWorktree(entries, STARRED)).toBe('/b');
  });

  it('selects the first entry when the checked filter shows none', () => {
    expect(defaultWorktree([entry('/a', false), entry('/b', false)], STARRED)).toBe('/a');
  });

  it('selects nothing without entries', () => {
    expect(defaultWorktree([], STARRED)).toBeNull();
  });

  it('selects the first entry with terminals with "Open" on', () => {
    const entries = [entry('/a', true), entry('/b', false, true), entry('/c', true, true)];
    expect(defaultWorktree(entries, OPEN)).toBe('/b');
    expect(defaultWorktree(entries, STARRED_OPEN)).toBe('/c');
  });

  it('selects the first entry when "Open" shows none, alone or with "Starred"', () => {
    const entries = [entry('/a', false), entry('/b', true), entry('/c', false, true)];
    expect(defaultWorktree(entries.slice(0, 2), OPEN)).toBe('/a');
    expect(defaultWorktree(entries, STARRED_OPEN)).toBe('/a');
  });
});

describe('groupRows', () => {
  const SRV = '/srv/app';
  const boxMain = worktree(SRV, { branch: 'main', main: true });
  const boxFix = worktree(`${SRV}.w/fix`, { branch: 'fix' });

  it('lists every member’s worktrees in member order, each row with its host', () => {
    const rows = groupRows([
      { host: 0, state: { worktrees: [main, feature], terminals: [], checked: [] } },
      { host: 1, state: { worktrees: [boxMain, boxFix], terminals: [], checked: [] } },
    ]);
    expect(rows.map((r) => [r.host, r.path, r.label])).toEqual([
      [0, REPO, 'main'],
      [0, feature.path, 'feature/x'],
      [1, SRV, 'main'],
      [1, boxFix.path, 'fix'],
    ]);
  });

  it('keeps the same path on two hosts as two rows, each with its own checked state and terminals', () => {
    const rows = groupRows([
      { host: 0, state: { worktrees: [boxMain], terminals: [], checked: [] } },
      { host: 1, state: { worktrees: [boxMain], terminals: [terminal(4, SRV)], checked: [SRV] } },
    ]);
    expect(rows.map((r) => [r.host, r.path, r.checked, r.hasTerminals])).toEqual([
      [0, SRV, false, false],
      [1, SRV, true, true],
    ]);
  });

  it('lists a member’s gone worktrees after that member’s others', () => {
    const rows = groupRows([
      { host: 0, state: { worktrees: [main], terminals: [terminal(1, '/r/gone')], checked: [] } },
      { host: 1, state: { worktrees: [boxMain], terminals: [], checked: [] } },
    ]);
    expect(rows.map((r) => [r.host, r.path, r.gone])).toEqual([
      [0, REPO, false],
      [0, '/r/gone', true],
      [1, SRV, false],
    ]);
  });
});

describe('visibleRows', () => {
  const row = (host: number, path: string, checked: boolean, label = 'main') => ({
    host,
    path,
    label,
    prunable: false,
    gone: false,
    checked,
    hasTerminals: false,
  });
  const SAME = [row(0, '/srv/app', false), row(1, '/srv/app', false), row(1, '/srv/b', true)];
  const shown = (rows: ReturnType<typeof visibleRows>): [number, string][] => rows.map((r) => [r.host, r.path]);

  it('keeps only the selected host’s row listed when two hosts share its path', () => {
    expect(shown(visibleRows(SAME, STARRED, '', { host: 1, path: '/srv/app' }))).toEqual([
      [1, '/srv/app'],
      [1, '/srv/b'],
    ]);
  });

  it('matches the name search against labels only, never the host', () => {
    expect(shown(visibleRows(SAME, NONE, '1', null))).toEqual([]);
    expect(shown(visibleRows([row(1, '/srv/box', false, 'box')], NONE, 'box', null))).toEqual([[1, '/srv/box']]);
  });
});

describe('rowKey', () => {
  it('keys two rows at the same path on two hosts apart', () => {
    expect(rowKey({ host: 0, path: '/srv/app' })).not.toBe(rowKey({ host: 1, path: '/srv/app' }));
  });

  it('keys a row the same every time', () => {
    expect(rowKey({ host: 1, path: '/srv/app' })).toBe(rowKey({ host: 1, path: '/srv/app' }));
  });
});

describe('defaultRow', () => {
  const row = (host: number, path: string, checked: boolean) => ({
    host,
    path,
    label: path,
    prunable: false,
    gone: false,
    checked,
    hasTerminals: false,
  });

  it('selects the host and path of the first row the switches show, else of the first row', () => {
    const rows = [row(0, '/srv/app', false), row(1, '/srv/app', true)];
    expect(defaultRow(rows, STARRED)).toEqual({ host: 1, path: '/srv/app' });
    expect(defaultRow(rows, NONE)).toEqual({ host: 0, path: '/srv/app' });
    expect(defaultRow([row(1, '/a', false)], STARRED)).toEqual({ host: 1, path: '/a' });
  });

  it('selects nothing without rows', () => {
    expect(defaultRow([], NONE)).toBeNull();
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
    expect(isFilterOn({}, '0:/a', 'checked')).toBe(false);
    expect(isFilterOn({ '0:/a': 'odd' }, '0:/a', 'checked')).toBe(false);
  });

  it('sets one repo to checked without touching the others', () => {
    const filters = withFilter({ '0:/b': 'checked' }, '0:/a', 'checked', true);
    expect(filters).toEqual({ '0:/a': 'checked', '0:/b': 'checked' });
    expect(isFilterOn(filters, '0:/a', 'checked')).toBe(true);
    expect(isFilterOn(filters, '1:/a', 'checked')).toBe(false);
  });

  it('drops the entry of a repo set back to all', () => {
    expect(withFilter({ '0:/a': 'checked', '0:/b': 'checked' }, '0:/a', 'checked', false)).toEqual({ '0:/b': 'checked' });
  });

  describe('"Open"', () => {
    it('reads on only for the stored value "open"', () => {
      expect(isFilterOn({ '0:/a': 'open' }, '0:/a', 'open')).toBe(true);
      for (const value of ['checked', 'on', 'true', 'Open', '']) expect(isFilterOn({ '0:/a': value }, '0:/a', 'open')).toBe(false);
      expect(isFilterOn({}, '0:/a', 'open')).toBe(false);
    });

    it('never reads a stored "Starred" value as on', () => {
      expect(isFilterOn({ '0:/a': 'open' }, '0:/a', 'checked')).toBe(false);
    });

    it('sets one repo on without touching the others, and off drops its entry', () => {
      const filters = withFilter({ '0:/b': 'open' }, '0:/a', 'open', true);
      expect(filters).toEqual({ '0:/a': 'open', '0:/b': 'open' });
      expect(withFilter(filters, '0:/a', 'open', false)).toEqual({ '0:/b': 'open' });
      expect(withFilter({}, '0:/a', 'open', false)).toEqual({});
    });
  });
});

describe('repo searches', () => {
  it('searches nothing in a repo without an entry', () => {
    expect(searchOf({ '0:/b': 'x' }, '0:/a')).toBe('');
  });

  it('sets one repo’s search without touching the others, keeping the text as typed', () => {
    const searches = withSearch({ '0:/b': 'x' }, '0:/a', ' Feat ');
    expect(searches).toEqual({ '0:/a': ' Feat ', '0:/b': 'x' });
    expect(searchOf(searches, '0:/a')).toBe(' Feat ');
    expect(searchOf(searches, '1:/a')).toBe('');
  });

  it('replaces a repo’s search and drops its entry when emptied', () => {
    expect(withSearch({ '0:/a': 'x', '0:/b': 'y' }, '0:/a', 'z')).toEqual({ '0:/a': 'z', '0:/b': 'y' });
    expect(withSearch({ '0:/a': 'x', '0:/b': 'y' }, '0:/a', '')).toEqual({ '0:/b': 'y' });
  });
});

describe('matchesSearch', () => {
  it.each([
    ['a substring', 'feature/login', 'ture/lo', true],
    ['the whole label', 'main', 'main', true],
    ['another case', 'Feature/Login', 'feature/LOGIN', true],
    ['a trimmed search', 'main', ' ain\t', true],
    ['an empty search', 'main', '', true],
    ['a non-substring', 'main', 'mian', false],
    ['a search longer than the label', 'main', 'mains', false],
  ])('%s', (_name, label, search, expected) => {
    expect(matchesSearch(label, search)).toBe(expected);
  });
});

const REASON = 'ssh: connect to host github.com port 22: No route to host';
const FOUR = ['feature-x', 'origin/feature-x', 'main', 'origin/main'];
const BOTH = { bases: ['main', 'origin/main'], fetchFailed: [] };
const LOCAL_ONLY = { bases: ['main'], fetchFailed: [] };
const REMOTE_ONLY = { bases: ['origin/master'], fetchFailed: [] };
const THREE = { bases: ['feature-x', 'main', 'origin/main'], fetchFailed: [] };
const STACKED = { bases: FOUR, fetchFailed: [] };
const NO_BASE = { bases: [], fetchFailed: [] };
const FAILED = { ...BOTH, fetchFailed: [{ ref: 'origin/main', reason: REASON }] };
const FAILED_NO_REMOTE = { ...LOCAL_ONLY, fetchFailed: [{ ref: 'origin/main', reason: REASON }] };
const BASE_FAILED = { bases: FOUR, fetchFailed: [{ ref: 'origin/feature-x', reason: 'r1' }] };
const TWO_FAILED = {
  bases: FOUR,
  fetchFailed: [
    { ref: 'origin/feature-x', reason: 'r1' },
    { ref: 'origin/main', reason: 'r2' },
  ],
};

describe('removalReasons', () => {
  const safe = { ...BOTH, ahead: 0, changes: 0, running: [] };

  it('gives no reason for a merged, clean worktree without running terminals', () => {
    expect(removalReasons(safe)).toEqual([]);
  });

  it('names every reason that applies, in order', () => {
    expect(removalReasons({ ...BOTH, ahead: 3, changes: 2, running: ['claude 3', 'shell 4'] })).toEqual([
      'It has 3 commits not in main or origin/main.',
      'It has 2 uncommitted changes, untracked files included.',
      'Running terminals will be closed: claude 3, shell 4.',
    ]);
  });

  it('uses the singular for one commit or change', () => {
    expect(removalReasons({ ...safe, ahead: 1, changes: 1 })).toEqual([
      'It has 1 commit not in main or origin/main.',
      'It has 1 uncommitted change, untracked files included.',
    ]);
  });

  it.each([
    ['the local branch', LOCAL_ONLY, 'It has 2 commits not in main.'],
    ['the remote-tracking ref', REMOTE_ONLY, 'It has 2 commits not in origin/master.'],
  ])('names only %s when it is the only base', (_name, bases, reason) => {
    expect(removalReasons({ ...safe, ...bases, ahead: 2 })).toEqual([reason]);
  });

  it.each([
    ['three bases', THREE, 'It has 3 commits not in feature-x, main or origin/main.'],
    ['four bases', STACKED, 'It has 3 commits not in feature-x, origin/feature-x, main or origin/main.'],
  ])('joins %s with commas and a final "or"', (_name, bases, reason) => {
    expect(removalReasons({ ...safe, ...bases, ahead: 3 })).toEqual([reason]);
  });

  it('says the remote is as last fetched and why the fetch failed', () => {
    expect(removalReasons({ ...safe, ...FAILED, ahead: 1 })).toEqual([
      `It has 1 commit not in main or origin/main as last fetched; couldn't compare with a fresh origin/main because the fetch failed: ${REASON}.`,
    ]);
  });

  it('names the ref it failed to fetch when there was none before', () => {
    expect(removalReasons({ ...safe, ...FAILED_NO_REMOTE, ahead: 1 })).toEqual([
      `It has 1 commit not in main; couldn't compare with a fresh origin/main because the fetch failed: ${REASON}.`,
    ]);
  });

  it("marks only the base's remote as last fetched when only its fetch failed", () => {
    expect(removalReasons({ ...safe, ...BASE_FAILED, ahead: 2 })).toEqual([
      "It has 2 commits not in feature-x, origin/feature-x as last fetched, main or origin/main; couldn't compare with a fresh origin/feature-x because the fetch failed: r1.",
    ]);
  });

  it('gives one clause per failed fetch, in order', () => {
    expect(removalReasons({ ...safe, ...TWO_FAILED, ahead: 1 })).toEqual([
      "It has 1 commit not in feature-x, origin/feature-x as last fetched, main or origin/main as last fetched; couldn't compare with a fresh origin/feature-x because the fetch failed: r1; couldn't compare with a fresh origin/main because the fetch failed: r2.",
    ]);
  });

  it('says when there is no base branch to compare with', () => {
    expect(removalReasons({ ...safe, ...NO_BASE, ahead: null })).toEqual(['There is no base branch to check that its commits are merged.']);
  });

  it('keeps the no-base sentence before the other reasons', () => {
    expect(removalReasons({ ...NO_BASE, ahead: null, changes: 1, running: ['shell 1'] })).toEqual([
      'There is no base branch to check that its commits are merged.',
      'It has 1 uncommitted change, untracked files included.',
      'Running terminals will be closed: shell 1.',
    ]);
  });
});

describe('keptNote', () => {
  const HEAD = '0123456789abcdef0123456789abcdef01234567';
  const detached = { detached: true, head: HEAD };

  it('says the branch is kept', () => {
    expect(keptNote({ detached: false, head: HEAD }, BOTH)).toBe('Its branch is kept.');
    expect(keptNote({ detached: false, head: HEAD }, NO_BASE)).toBe('Its branch is kept.');
  });

  it.each([
    ['both bases', BOTH, 'its commits not in main or origin/main become unreachable'],
    ['only the local branch', LOCAL_ONLY, 'its commits not in main become unreachable'],
    ['only the remote-tracking ref', REMOTE_ONLY, 'its commits not in origin/master become unreachable'],
    ['three bases', THREE, 'its commits not in feature-x, main or origin/main become unreachable'],
    ['four bases', STACKED, 'its commits not in feature-x, origin/feature-x, main or origin/main become unreachable'],
    ['a failed fetch', FAILED, 'its commits not in main or origin/main as last fetched become unreachable'],
    ['a failed fetch without a remote-tracking ref', FAILED_NO_REMOTE, 'its commits not in main become unreachable'],
    [
      'two failed fetches',
      TWO_FAILED,
      'its commits not in feature-x, origin/feature-x as last fetched, main or origin/main as last fetched become unreachable',
    ],
    ['no base', NO_BASE, 'its commits become unreachable'],
  ])('says a detached worktree leaves its commits unreachable, naming its head, with %s', (_name, bases, lost) => {
    expect(keptNote(detached, bases)).toBe(`It has no branch: once it is deleted, ${lost}; its head is 0123456.`);
  });

  it('ends the note without a head', () => {
    expect(keptNote({ detached: true, head: null }, NO_BASE)).toBe('It has no branch: once it is deleted, its commits become unreachable.');
  });
});
