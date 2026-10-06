import { describe, expect, it } from 'vitest';
import type { Layout, Terminal, Worktree } from '../../protocol/index.js';
import { HubStore } from './store.js';

const REPO = '/r/app';
const WT = '/r/app.worktrees/feat';

const worktree = (path: string): Worktree => ({
  path,
  head: null,
  branch: 'b',
  detached: false,
  locked: false,
  prunable: false,
  bare: false,
  main: path === REPO,
});

const terminal = (termId: number, path = WT): Terminal => ({
  termId,
  worktree: path,
  preset: 'shell',
  cols: 80,
  rows: 24,
  exit: null,
  unseen: false,
  bell: false,
});

const layout: Layout = { tabs: [{ id: 't1', root: { term: 1 } }], active: 0 };

const watched = (): HubStore => {
  const store = new HubStore();
  store.apply(0, {
    t: 'repoState',
    repo: REPO,
    worktrees: [worktree(REPO), worktree(WT)],
    terminals: [terminal(1)],
    checked: [],
    layouts: [{ worktree: WT, layout }],
  });
  return store;
};

describe('HubStore', () => {
  it('keeps the repo state of a watch', () => {
    const state = watched().repo(0, REPO);
    expect(state?.worktrees.map((w) => w.path)).toEqual([REPO, WT]);
    expect(state?.layouts.get(WT)).toEqual(layout);
    expect(state?.error).toBeNull();
  });

  it('adds a created terminal to the repo of its worktree once', () => {
    const store = watched();
    store.apply(0, { t: 'termCreated', req: null, term: terminal(2) });
    store.apply(0, { t: 'termCreated', req: 7, term: terminal(2) });
    expect(store.terminalIds(0, REPO)).toEqual([1, 2]);
  });

  it('records an exit and drops a closed terminal', () => {
    const store = watched();
    store.apply(0, { t: 'termExited', termId: 1, code: 3, signal: null });
    expect(store.repo(0, REPO)?.terminals[0]?.exit).toEqual({ code: 3, signal: null });
    store.apply(0, { t: 'termClosed', termId: 1 });
    expect(store.terminalIds(0, REPO)).toEqual([]);
  });

  it('follows worktree, checked and layout changes', () => {
    const store = watched();
    store.apply(0, { t: 'worktreesChanged', repo: REPO, worktrees: [worktree(REPO)] });
    expect(store.repo(0, REPO)?.worktrees.map((w) => w.path)).toEqual([REPO]);
    store.apply(0, { t: 'checkedChanged', worktree: REPO, checked: true });
    store.apply(0, { t: 'checkedChanged', worktree: REPO, checked: true });
    expect(store.repo(0, REPO)?.checked).toEqual([REPO]);
    store.apply(0, { t: 'checkedChanged', worktree: REPO, checked: false });
    expect(store.repo(0, REPO)?.checked).toEqual([]);
    const next: Layout = { tabs: [], active: 0 };
    store.apply(0, { t: 'layoutChanged', worktree: WT, layout: next });
    expect(store.repo(0, REPO)?.layouts.get(WT)).toEqual(next);
  });

  it('finds the repo of a vanished worktree through its terminals', () => {
    const store = watched();
    store.apply(0, { t: 'worktreesChanged', repo: REPO, worktrees: [worktree(REPO)] });
    expect(store.repoOf(0, WT)).toBe(REPO);
    expect(store.repoOf(0, '/elsewhere')).toBeNull();
    expect(store.repoOf(1, WT)).toBeNull();
  });

  it('keeps a watch error until the next repo state', () => {
    const store = new HubStore();
    store.repoError(0, '/plain', { code: 'not-a-repo', message: 'no' });
    expect(store.repo(0, '/plain')?.error).toEqual({ code: 'not-a-repo', message: 'no' });
    store.apply(0, { t: 'repoState', repo: '/plain', worktrees: [], terminals: [], checked: [], layouts: [] });
    expect(store.repo(0, '/plain')?.error).toBeNull();
  });

  it('forgets only the repos of a cleared host', () => {
    const store = watched();
    store.apply(1, { t: 'repoState', repo: REPO, worktrees: [], terminals: [], checked: [], layouts: [] });
    store.clearHost(0);
    expect(store.repo(0, REPO)).toBeNull();
    expect(store.repo(1, REPO)).not.toBeNull();
  });
});
