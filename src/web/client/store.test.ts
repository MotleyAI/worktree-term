import { describe, expect, it } from 'vitest';
import type { Layout, Preset, Terminal, Worktree } from '../../protocol/index.js';
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
  state: 'idle',
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

  it('applies activity to the terminal', () => {
    const store = watched();
    store.apply(0, { t: 'activity', termId: 1, unseen: true, state: 'input' });
    expect(store.repo(0, REPO)?.terminals[0]).toEqual({ ...terminal(1), unseen: true, state: 'input' });
    store.apply(0, { t: 'activity', termId: 1, unseen: false, state: 'working' });
    expect(store.repo(0, REPO)?.terminals[0]).toEqual({ ...terminal(1), unseen: false, state: 'working' });
  });

  it('shows a local layout at once and reverts to the one reported by repoState', () => {
    const store = watched();
    const local: Layout = { tabs: [{ id: 't1', root: { split: 'right', ratio: 0.5, a: { term: 1 }, b: { term: 2 } } }], active: 0 };
    store.writeLayout(0, WT, local);
    expect(store.repo(0, REPO)?.layouts.get(WT)).toEqual(local);
    store.layoutWritten(0, WT);
    expect(store.repo(0, REPO)?.layouts.get(WT)).toEqual(layout);
  });

  it('reverts to the layout last reported by layoutChanged', () => {
    const store = watched();
    const reported: Layout = { tabs: [{ id: 't2', root: { term: 2 } }], active: 0 };
    store.apply(0, { t: 'layoutChanged', worktree: WT, layout: reported });
    store.writeLayout(0, WT, layout);
    store.writeLayout(0, WT, { tabs: [], active: 0 });
    store.layoutWritten(0, WT);
    store.layoutWritten(0, WT);
    expect(store.repo(0, REPO)?.layouts.get(WT)).toEqual(reported);
  });

  it('removes a local layout when the daemon reported none', () => {
    const store = watched();
    store.writeLayout(0, REPO, layout);
    store.layoutWritten(0, REPO);
    expect(store.repo(0, REPO)?.layouts.has(REPO)).toBe(false);
    expect(store.repo(0, REPO)?.layouts.get(WT)).toEqual(layout);
  });

  it('forgets a reported layout that a later repoState no longer lists', () => {
    const store = watched();
    store.apply(0, {
      t: 'repoState',
      repo: REPO,
      worktrees: [worktree(REPO), worktree(WT)],
      terminals: [terminal(1)],
      checked: [],
      layouts: [],
    });
    store.writeLayout(0, WT, layout);
    store.layoutWritten(0, WT);
    expect(store.repo(0, REPO)?.layouts.has(WT)).toBe(false);
  });

  it('keeps its newest layout while echoes of its earlier writes arrive', () => {
    const store = watched();
    const first: Layout = { tabs: [{ id: 't1', root: { term: 1 } }], active: 0 };
    const second: Layout = {
      tabs: [
        { id: 't1', root: { term: 1 } },
        { id: 't2', root: { term: 2 } },
      ],
      active: 1,
    };
    store.writeLayout(0, WT, first);
    store.writeLayout(0, WT, second);
    store.apply(0, { t: 'layoutChanged', worktree: WT, layout: first });
    expect(store.repo(0, REPO)?.layouts.get(WT)).toEqual(second);
    store.layoutWritten(0, WT);
    expect(store.repo(0, REPO)?.layouts.get(WT)).toEqual(second);
    store.apply(0, { t: 'layoutChanged', worktree: WT, layout: second });
    store.layoutWritten(0, WT);
    expect(store.repo(0, REPO)?.layouts.get(WT)).toEqual(second);
  });

  it('shows a layout another page stored meanwhile once its own writes are answered', () => {
    const store = watched();
    const ours: Layout = { tabs: [{ id: 't1', root: { term: 1 } }], active: 0 };
    const theirs: Layout = { tabs: [{ id: 't9', root: { term: 9 } }], active: 0 };
    store.writeLayout(0, WT, ours);
    store.apply(0, { t: 'layoutChanged', worktree: WT, layout: ours });
    store.apply(0, { t: 'layoutChanged', worktree: WT, layout: theirs });
    expect(store.repo(0, REPO)?.layouts.get(WT)).toEqual(ours);
    store.layoutWritten(0, WT);
    expect(store.repo(0, REPO)?.layouts.get(WT)).toEqual(theirs);
    const next: Layout = { tabs: [], active: 0 };
    store.apply(0, { t: 'layoutChanged', worktree: WT, layout: next });
    expect(store.repo(0, REPO)?.layouts.get(WT)).toEqual(next);
  });

  it('forgets writes under way when the host is cleared', () => {
    const store = watched();
    store.writeLayout(0, WT, { tabs: [], active: 0 });
    store.clearHost(0);
    store.apply(0, {
      t: 'repoState',
      repo: REPO,
      worktrees: [worktree(REPO), worktree(WT)],
      terminals: [terminal(1)],
      checked: [],
      layouts: [],
    });
    store.apply(0, { t: 'layoutChanged', worktree: WT, layout });
    expect(store.repo(0, REPO)?.layouts.get(WT)).toEqual(layout);
  });

  it('keeps the session’s presets until the session closes', () => {
    const store = new HubStore();
    expect(store.presets.value).toBeNull();
    const presets: Preset[] = [
      { name: 'shell', command: null },
      { name: 'claude', command: 'claude' },
    ];
    store.setPresets(presets);
    expect(store.presets.value).toEqual(presets);
    store.apply(0, { t: 'repoState', repo: REPO, worktrees: [], terminals: [], checked: [], layouts: [] });
    expect(store.presets.value).toEqual(presets);
    store.sessionClosed();
    expect(store.presets.value).toBeNull();
  });

  it('forgets only the repos of a cleared host', () => {
    const store = watched();
    store.apply(1, { t: 'repoState', repo: REPO, worktrees: [], terminals: [], checked: [], layouts: [] });
    store.clearHost(0);
    expect(store.repo(0, REPO)).toBeNull();
    expect(store.repo(1, REPO)).not.toBeNull();
  });

  it('tells whether a repo has a terminal whose process runs', () => {
    const store = watched();
    expect(store.hasRunning(0, REPO)).toBe(true);
    store.apply(0, { t: 'termExited', termId: 1, code: 0, signal: null });
    expect(store.hasRunning(0, REPO)).toBe(false);
    expect(store.hasRunning(0, '/r/other')).toBe(false);
  });

  it('lists the running terminals of a host with their worktree labels', () => {
    const store = new HubStore();
    const gone = '/r/app.worktrees/gone';
    const terminals = [terminal(1), { ...terminal(2, REPO), preset: 'claude' }, terminal(3, gone)];
    store.apply(0, { t: 'repoState', repo: REPO, worktrees: [worktree(REPO), worktree(WT)], terminals, checked: [], layouts: [] });
    store.apply(0, { t: 'termExited', termId: 1, code: 0, signal: null });
    expect(store.running(0)).toEqual([
      { worktree: 'b', preset: 'claude' },
      { worktree: 'gone', preset: 'shell' },
    ]);
    expect(store.running(1)).toEqual([]);
  });

  it('keeps repos per host until told otherwise, and forgets them with the host', () => {
    const store = watched();
    store.keep(0, REPO, true);
    store.keep(0, REPO, true);
    store.keep(1, '/x', true);
    expect(store.kept.value.get(0)).toEqual([REPO]);
    store.keep(0, REPO, false);
    expect(store.kept.value.get(0)).toEqual([]);
    store.keep(0, REPO, true);
    store.clearHost(0);
    expect(store.kept.value.has(0)).toBe(false);
    expect(store.kept.value.get(1)).toEqual(['/x']);
  });

  it('drops one repo’s state and stops keeping it', () => {
    const store = watched();
    store.apply(0, { t: 'repoState', repo: '/r/b', worktrees: [], terminals: [], checked: [], layouts: [] });
    store.keep(0, REPO, true);
    store.dropRepo(0, REPO);
    expect(store.repo(0, REPO)).toBeNull();
    expect(store.repo(0, '/r/b')).not.toBeNull();
    expect(store.kept.value.get(0)).toEqual([]);
  });
});
