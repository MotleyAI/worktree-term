import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostEntry, Layout, Terminal, Worktree } from '../../protocol/index.js';
import { HubClient } from '../client/index.js';
import type { TerminalManager } from '../terminals/index.js';
import type { PageFocus } from './focus.js';
import { View } from './view.js';

/** A `KeyboardEvent` built without a DOM; `preventDefault` sets `defaultPrevented`. */
class TestKey extends Event implements KeyboardEvent {
  readonly DOM_KEY_LOCATION_STANDARD = 0;
  readonly DOM_KEY_LOCATION_LEFT = 1;
  readonly DOM_KEY_LOCATION_RIGHT = 2;
  readonly DOM_KEY_LOCATION_NUMPAD = 3;
  readonly charCode = 0;
  readonly keyCode = 0;
  readonly location = 0;
  readonly detail = 0;
  readonly view = null;
  readonly which = 0;
  readonly key: string;
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly repeat = false;
  readonly isComposing = false;

  constructor(key: string, code: string, modifiers: { ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; metaKey?: boolean } = {}) {
    super('keydown', { bubbles: true, cancelable: true });
    this.key = key;
    this.code = code;
    this.ctrlKey = modifiers.ctrlKey ?? false;
    this.shiftKey = modifiers.shiftKey ?? false;
    this.altKey = modifiers.altKey ?? false;
    this.metaKey = modifiers.metaKey ?? false;
  }

  getModifierState(): boolean {
    throw new Error('not used');
  }

  initKeyboardEvent(): void {
    throw new Error('not used');
  }

  initUIEvent(): void {
    throw new Error('not used');
  }
}

type Manager = Pick<TerminalManager, 'has' | 'open' | 'focus' | 'forwardKey' | 'show' | 'sizeFor' | 'selection' | 'paste' | 'onFocus'>;

/** Records what the view asks of the terminals; View takes any object with the manager methods it calls. */
class FakeTerminals implements Manager {
  readonly opened = new Set<string>();
  focused: [number, number][] = [];
  forwarded: [number, number, KeyboardEvent][] = [];

  has(host: number, termId: number): boolean {
    return this.opened.has(`${String(host)}:${String(termId)}`);
  }

  open(host: number, termId: number): void {
    this.opened.add(`${String(host)}:${String(termId)}`);
  }

  focus(host: number, termId: number): void {
    this.focused.push([host, termId]);
  }

  forwardKey(host: number, termId: number, event: KeyboardEvent): void {
    this.forwarded.push([host, termId, event]);
  }

  show(): void {
    // Nothing to show without a DOM.
  }

  sizeFor(): { cols: number; rows: number } {
    return { cols: 80, rows: 24 };
  }

  selection(): string {
    return '';
  }

  paste(): void {
    throw new Error('not used');
  }

  onFocus(): void {
    // The view's focus listener is not exercised here.
  }

  clear(): void {
    this.focused = [];
    this.forwarded = [];
  }
}

class MemoryStorage implements Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  private readonly items = new Map<string, string>();

  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }

  removeItem(key: string): void {
    this.items.delete(key);
  }
}

const worktree = (path: string, main: boolean): Worktree => ({
  path,
  head: null,
  branch: 'b',
  detached: false,
  locked: false,
  prunable: false,
  bare: false,
  main,
});

const terminal = (termId: number, path: string): Terminal => ({
  termId,
  worktree: path,
  preset: 'shell',
  cols: 80,
  rows: 24,
  exit: null,
  unseen: false,
  state: 'idle',
});

const host = (idx: number, repos: readonly string[]): HostEntry => ({
  idx,
  name: idx === 0 ? 'local' : `h${String(idx)}`,
  remote: idx !== 0,
  status: 'connected',
  reason: null,
  daemonVersion: null,
  instance: null,
  login: null,
  repos: [...repos],
});

/** Reports `repo` with only its main worktree, holding `terms` as one tab split right (none for no terminals). */
const report = (client: HubClient, hostIdx: number, repo: string, terms: readonly number[]): void => {
  const [first, second] = terms;
  const root =
    second === undefined ? { term: first ?? 0 } : { split: 'right' as const, ratio: 0.5, a: { term: first ?? 0 }, b: { term: second } };
  const layout: Layout = { tabs: [{ id: 't1', root }], active: 0 };
  client.store.apply(hostIdx, {
    t: 'repoState',
    repo,
    origin: null,
    worktrees: [worktree(repo, true)],
    terminals: terms.map((id) => terminal(id, repo)),
    checked: [],
    layouts: terms.length === 0 ? [] : [{ worktree: repo, layout }],
  });
};

/** Opens the remove-repo confirmation for the shown repo tab. */
const openDialog = (view: View): void => {
  const tab = view.tab.value;
  if (tab === null) throw new Error('no repo tab is shown');
  view.requestRemoveRepo(tab);
  expect(view.modal.value).toBe(true);
};

const NOTHING_HOLDS: PageFocus = { spot: 'none', clicked: false, menuOpen: false, pageSelection: false };

describe('View', () => {
  let client: HubClient;
  let manager: FakeTerminals;
  let view: View;

  beforeEach(() => {
    vi.stubGlobal('localStorage', new MemoryStorage());
    client = new HubClient('test');
    manager = new FakeTerminals();
    view = new View(client, manager);
    client.store.status.value = 'open';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('claiming the keyboard focus', () => {
    beforeEach(() => {
      client.store.hosts.value = [host(0, ['/r/app', '/r/empty'])];
      report(client, 0, '/r/app', [1, 2]);
      report(client, 0, '/r/empty', []);
      view.focusPane(2);
      manager.clear();
    });

    it.each(['click', 'windowFocus'] as const)('focuses the focused pane on a %s while nothing holds the keyboard', (trigger) => {
      view.claimFocus(trigger, NOTHING_HOLDS);
      expect(manager.focused).toEqual([[0, 2]]);
      expect(manager.forwarded).toEqual([]);
    });

    it.each(['click', 'windowFocus'] as const)('focuses it on a %s from a control the user clicked', (trigger) => {
      view.claimFocus(trigger, { ...NOTHING_HOLDS, spot: 'other', clicked: true });
      expect(manager.focused).toEqual([[0, 2]]);
    });

    it.each<[string, PageFocus]>([
      ['a control focused from the keyboard', { ...NOTHING_HOLDS, spot: 'other' }],
      ['a text field', { ...NOTHING_HOLDS, spot: 'textField', clicked: true }],
      ['a terminal', { ...NOTHING_HOLDS, spot: 'terminal' }],
      ['an open menu', { ...NOTHING_HOLDS, menuOpen: true }],
      ['selected page text', { ...NOTHING_HOLDS, pageSelection: true }],
    ])('leaves the focus with %s', (_name, page) => {
      view.claimFocus('click', page);
      view.claimFocus('windowFocus', page);
      view.claimKey(new TestKey('c', 'KeyC', { ctrlKey: true }), page);
      expect(manager.focused).toEqual([]);
      expect(manager.forwarded).toEqual([]);
    });

    it('leaves the focus while a picker or dialog is open', () => {
      openDialog(view);
      manager.clear();
      view.claimFocus('click', NOTHING_HOLDS);
      view.claimFocus('windowFocus', NOTHING_HOLDS);
      view.claimKey(new TestKey('a', 'KeyA'), NOTHING_HOLDS);
      expect(manager.focused).toEqual([]);
      expect(manager.forwarded).toEqual([]);
    });

    it('does nothing without a current terminal', () => {
      const empty = view.tabs.value.find((t) => t.repo === '/r/empty');
      if (empty === undefined) throw new Error('no tab /r/empty');
      view.selectRepo(empty);
      manager.clear();
      view.claimFocus('click', NOTHING_HOLDS);
      view.claimFocus('windowFocus', NOTHING_HOLDS);
      view.claimKey(new TestKey('a', 'KeyA'), NOTHING_HOLDS);
      expect(manager.focused).toEqual([]);
      expect(manager.forwarded).toEqual([]);
    });

    it('forwards a key pressed while nothing holds the keyboard to the focused pane only', () => {
      const event = new TestKey('a', 'KeyA');
      view.claimKey(event, NOTHING_HOLDS);
      expect(manager.forwarded).toEqual([[0, 2, event]]);
    });

    it('forwards a key pressed on a control the user clicked', () => {
      const event = new TestKey('Enter', 'Enter');
      view.claimKey(event, { ...NOTHING_HOLDS, spot: 'other', clicked: true });
      expect(manager.forwarded).toEqual([[0, 2, event]]);
    });

    it('forwards a plain key while page text is selected, but not a Ctrl key', () => {
      const selected = { ...NOTHING_HOLDS, pageSelection: true };
      view.claimKey(new TestKey('c', 'KeyC', { ctrlKey: true }), selected);
      expect(manager.forwarded).toEqual([]);
      const event = new TestKey('x', 'KeyX');
      view.claimKey(event, selected);
      expect(manager.forwarded).toEqual([[0, 2, event]]);
    });

    it('never forwards a key whose default was prevented', () => {
      const event = new TestKey('Enter', 'Enter');
      event.preventDefault();
      view.claimKey(event, NOTHING_HOLDS);
      expect(manager.forwarded).toEqual([]);
      expect(manager.focused).toEqual([]);
    });

    it('never forwards a shortcut the view handled', () => {
      const event = new TestKey('ArrowDown', 'ArrowDown', { altKey: true });
      expect(view.handleKey(event, false)).toBe(true);
      view.claimKey(event, NOTHING_HOLDS);
      expect(manager.forwarded).toEqual([]);
    });
  });

  describe('repo tab navigation', () => {
    beforeEach(() => {
      client.store.hosts.value = [host(0, ['/r/a', '/r/b']), host(1, ['/r/c'])];
      report(client, 0, '/r/a', [1]);
      report(client, 0, '/r/b', [2]);
      report(client, 1, '/r/c', [3]);
      manager.clear();
    });

    const shown = (): string | undefined => view.tab.value?.repo;
    const press = (code: 'ArrowLeft' | 'ArrowRight'): boolean => view.handleKey(new TestKey(code, code, { altKey: true }), false);

    it('steps through the repo tabs in their shown order across hosts, stopping at either end', () => {
      expect(shown()).toBe('/r/a');
      expect(press('ArrowRight')).toBe(true);
      expect(shown()).toBe('/r/b');
      press('ArrowRight');
      expect(shown()).toBe('/r/c');
      press('ArrowRight');
      expect(shown()).toBe('/r/c');
      press('ArrowLeft');
      expect(shown()).toBe('/r/b');
      press('ArrowLeft');
      press('ArrowLeft');
      expect(shown()).toBe('/r/a');
    });

    it('focuses the current terminal of the repo it steps to', () => {
      press('ArrowRight');
      expect(manager.focused.at(-1)).toEqual([0, 2]);
      press('ArrowRight');
      expect(manager.focused.at(-1)).toEqual([1, 3]);
    });

    it('does nothing while a picker or dialog is open', () => {
      openDialog(view);
      press('ArrowRight');
      expect(shown()).toBe('/r/a');
    });

    it('chooses terminal tabs with Ctrl+Shift+arrows instead', () => {
      client.store.apply(0, {
        t: 'repoState',
        repo: '/r/a',
        origin: null,
        worktrees: [worktree('/r/a', true)],
        terminals: [terminal(1, '/r/a'), terminal(4, '/r/a')],
        checked: [],
        layouts: [
          {
            worktree: '/r/a',
            layout: {
              tabs: [
                { id: 't1', root: { term: 1 } },
                { id: 't2', root: { term: 4 } },
              ],
              active: 0,
            },
          },
        ],
      });
      expect(view.termTabs.value.active).toBe(1);
      expect(view.handleKey(new TestKey('ArrowRight', 'ArrowRight', { ctrlKey: true, shiftKey: true }), false)).toBe(true);
      expect(view.termTabs.value.active).toBe(4);
      expect(shown()).toBe('/r/a');
    });
  });

  describe('worktree filters and the default selection', () => {
    const APP = '/r/app';
    const B = '/r/app.w/b';
    const C = '/r/app.w/c';
    const D = '/r/app.w/d';
    const GONE = '/r/app.w/gone';
    const OTHER = '/r/other';
    const KEY = `local:${APP}`;
    const OTHER_KEY = `local:${OTHER}`;
    const OPEN_KEY = 'wtd.openFilters';
    const FILTERS_KEY = 'wtd.filters';

    /** Reports `repo` with worktrees `<repo>`, then `<repo>.w/b`, `c` and `d`. */
    const state = (terminals: readonly Terminal[], checked: readonly string[] = [], repo = APP): void => {
      client.store.apply(0, {
        t: 'repoState',
        repo,
        origin: null,
        worktrees: [worktree(repo, true), ...['b', 'c', 'd'].map((w) => worktree(`${repo}.w/${w}`, false))],
        terminals: [...terminals],
        checked: [...checked],
        layouts: [],
      });
    };
    const closed = (termId: number): void => {
      client.store.apply(0, { t: 'termClosed', termId });
    };
    const created = (termId: number, path: string): void => {
      client.store.apply(0, { t: 'termCreated', req: null, term: terminal(termId, path) });
    };
    const unchecked = (path: string): void => {
      client.store.apply(0, { t: 'checkedChanged', worktree: path, checked: false });
    };
    const stored = (key: string): unknown => JSON.parse(localStorage.getItem(key) ?? 'null');
    const listed = (): string[] => view.listed.value.map((e) => e.path);
    const tabOf = (repo: string): (typeof view.tabs.value)[number] => {
      const tab = view.tabs.value.find((t) => t.repo === repo);
      if (tab === undefined) throw new Error(`no tab ${repo}`);
      return tab;
    };
    /** A fresh page's view, reading what storage holds now. */
    const reopen = (): void => {
      view = new View(client, manager);
    };

    beforeEach(() => {
      client.store.hosts.value = [host(0, [APP, OTHER])];
    });

    describe('storing the switches', () => {
      beforeEach(() => {
        state([terminal(1, C)], [D]);
        state([], [], OTHER);
      });

      it('stores "Open" per repo under its own key, apart from "Starred"', () => {
        view.setFilter('open', true);
        expect(view.filter.value).toEqual({ checked: false, open: true });
        expect(stored(OPEN_KEY)).toEqual({ [KEY]: 'open' });
        expect(stored(FILTERS_KEY)).toBeNull();

        view.setFilter('checked', true);
        expect(view.filter.value).toEqual({ checked: true, open: true });
        expect(stored(FILTERS_KEY)).toEqual({ [KEY]: 'checked' });
        expect(stored(OPEN_KEY)).toEqual({ [KEY]: 'open' });

        view.setFilter('open', false);
        expect(view.filter.value).toEqual({ checked: true, open: false });
        expect(stored(OPEN_KEY)).toEqual({});
        expect(stored(FILTERS_KEY)).toEqual({ [KEY]: 'checked' });
      });

      it('keeps each repo’s switches apart', () => {
        view.setFilter('open', true);
        view.selectRepo(tabOf(OTHER));
        expect(view.filter.value).toEqual({ checked: false, open: false });
        view.setFilter('open', true);
        view.setFilter('open', false);
        view.selectRepo(tabOf(APP));
        expect(view.filter.value).toEqual({ checked: false, open: true });
        expect(stored(OPEN_KEY)).toEqual({ [KEY]: 'open' });
      });

      it('restores both switches of each repo on a new page', () => {
        localStorage.setItem(FILTERS_KEY, JSON.stringify({ [KEY]: 'checked' }));
        localStorage.setItem(OPEN_KEY, JSON.stringify({ [KEY]: 'open', [OTHER_KEY]: 'open' }));
        reopen();
        expect(view.filter.value).toEqual({ checked: true, open: true });
        view.selectRepo(tabOf(OTHER));
        expect(view.filter.value).toEqual({ checked: false, open: true });
      });

      it('keeps a "Starred" setting stored before "Open" existed, with "Open" off', () => {
        localStorage.setItem(FILTERS_KEY, JSON.stringify({ [KEY]: 'checked' }));
        reopen();
        expect(view.filter.value).toEqual({ checked: true, open: false });
        expect(view.worktree.value).toEqual({ host: 0, path: D });
        expect(listed()).toEqual([D]);
      });

      it.each(['not json', '["open"]', 'null', '"open"', `{"${KEY}":"on"}`, `{"${KEY}":true}`, `{"${KEY}":"checked"}`])(
        'reads "Open" as off from a stored %s, leaving "Starred" alone',
        (value) => {
          localStorage.setItem(FILTERS_KEY, JSON.stringify({ [KEY]: 'checked' }));
          localStorage.setItem(OPEN_KEY, value);
          reopen();
          expect(view.filter.value).toEqual({ checked: true, open: false });
        },
      );

      it('applies "Open" and reports the failure when the browser refuses to store it', () => {
        const memory = new MemoryStorage();
        vi.stubGlobal('localStorage', {
          getItem: (key: string) => memory.getItem(key),
          removeItem: (key: string) => {
            memory.removeItem(key);
          },
          setItem: (key: string, value: string) => {
            if (key === OPEN_KEY) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
            memory.setItem(key, value);
          },
        });
        reopen();
        view.setFilter('open', true);
        expect(view.filter.value).toEqual({ checked: false, open: true });
        expect(listed()).toEqual([C]);
        expect(view.notice.value).toBe("Saving the page's settings failed: The quota has been exceeded.");
      });
    });

    describe('the default selection', () => {
      it('is the first worktree the switches show when the repo is first shown', () => {
        localStorage.setItem(OPEN_KEY, JSON.stringify({ [KEY]: 'open' }));
        reopen();
        expect(view.worktree.value).toBeNull();
        state([terminal(1, C), terminal(2, D)]);
        expect(view.worktree.value).toEqual({ host: 0, path: C });
        expect(listed()).toEqual([C, D]);
      });

      it('stays when its last terminal closes or a worktree before it gains one', () => {
        state([terminal(1, C)]);
        view.setFilter('open', true);
        expect(view.worktree.value).toEqual({ host: 0, path: C });
        closed(1);
        expect(view.worktree.value).toEqual({ host: 0, path: C });
        expect(listed()).toEqual([C]);
        expect(view.terminals.value).toEqual([]);
        created(2, B);
        expect(view.worktree.value).toEqual({ host: 0, path: C });
        expect(listed()).toEqual([B, C]);
      });

      it('stays when it is unchecked', () => {
        state([], [B, C]);
        view.setFilter('checked', true);
        expect(view.worktree.value).toEqual({ host: 0, path: B });
        unchecked(B);
        expect(view.worktree.value).toEqual({ host: 0, path: B });
        expect(listed()).toEqual([B, C]);
      });

      it('is derived again whenever the user toggles a switch', () => {
        state([terminal(1, C)], [D]);
        expect(view.worktree.value).toEqual({ host: 0, path: APP });
        view.setFilter('open', true);
        expect(view.worktree.value).toEqual({ host: 0, path: C });
        view.setFilter('checked', true);
        expect(view.worktree.value).toEqual({ host: 0, path: APP });
        view.setFilter('open', false);
        expect(view.worktree.value).toEqual({ host: 0, path: D });
        view.setFilter('checked', false);
        expect(view.worktree.value).toEqual({ host: 0, path: APP });
      });

      it('is derived again on a toggle after it was kept', () => {
        state([terminal(1, C)]);
        view.setFilter('open', true);
        closed(1);
        expect(view.worktree.value).toEqual({ host: 0, path: C });
        view.setFilter('checked', true);
        view.setFilter('checked', false);
        expect(view.worktree.value).toEqual({ host: 0, path: APP });
        expect(listed()).toEqual([APP]);
      });

      it('is derived again once it is no longer a worktree of the repo', () => {
        state([terminal(1, GONE)]);
        view.setFilter('open', true);
        expect(view.worktree.value).toEqual({ host: 0, path: GONE });
        created(2, B);
        expect(view.worktree.value).toEqual({ host: 0, path: GONE });
        closed(1);
        expect(view.worktree.value).toEqual({ host: 0, path: B });
        expect(listed()).toEqual([B]);
      });

      it('falls back to the first worktree once a gone default leaves and the switches show none', () => {
        state([terminal(1, GONE)]);
        view.setFilter('open', true);
        closed(1);
        expect(view.worktree.value).toEqual({ host: 0, path: APP });
        expect(listed()).toEqual([APP]);
      });

      it('is kept per repo while another repo is shown and its switches change', () => {
        state([terminal(1, C)]);
        state([], [], OTHER);
        view.setFilter('open', true);
        expect(view.worktree.value).toEqual({ host: 0, path: C });
        view.selectRepo(tabOf(OTHER));
        closed(1);
        view.setFilter('open', true);
        view.setFilter('checked', true);
        view.selectRepo(tabOf(APP));
        expect(view.worktree.value).toEqual({ host: 0, path: C });
        expect(listed()).toEqual([C]);
      });

      it('never replaces a selection the user made', () => {
        vi.stubGlobal('requestAnimationFrame', () => 0);
        state([terminal(1, C)], [B]);
        view.selectWorktree({ host: 0, path: D });
        view.setFilter('open', true);
        expect(view.worktree.value).toEqual({ host: 0, path: D });
        expect(listed()).toEqual([C, D]);
        view.setFilter('checked', true);
        closed(1);
        expect(view.worktree.value).toEqual({ host: 0, path: D });
        expect(listed()).toEqual([D]);
      });

      it('is derived afresh, not restored, once a selection the user made leaves', () => {
        vi.stubGlobal('requestAnimationFrame', () => 0);
        state([terminal(1, B), terminal(2, GONE), terminal(3, D)]);
        view.setFilter('open', true);
        expect(view.worktree.value).toEqual({ host: 0, path: B });
        view.selectWorktree({ host: 0, path: GONE });
        closed(1);
        closed(2);
        expect(view.worktree.value).toEqual({ host: 0, path: D });
        expect(listed()).toEqual([D]);
      });

      it('stays when a selection the user made leaves and comes back, which a new page restores', () => {
        vi.stubGlobal('requestAnimationFrame', () => 0);
        const worktreesChanged = (paths: readonly string[]): void => {
          client.store.apply(0, {
            t: 'worktreesChanged',
            repo: APP,
            worktrees: [worktree(APP, true), ...paths.map((p) => worktree(p, false))],
          });
        };
        state([]);
        view.selectWorktree({ host: 0, path: B });
        worktreesChanged([C, D]);
        expect(view.worktree.value).toEqual({ host: 0, path: APP });
        worktreesChanged([B, C, D]);
        expect(view.worktree.value).toEqual({ host: 0, path: APP });
        reopen();
        expect(view.worktree.value).toEqual({ host: 0, path: B });
      });
    });
  });

  describe('repo groups across hosts', () => {
    const APP = 'github.com/acme/app';
    const REPO_KEY = 'wtd.repo';
    const FILTERS_KEY = 'wtd.filters';
    const OPEN_KEY = 'wtd.openFilters';
    const SEARCHES_KEY = 'wtd.searches';
    const WORKTREES_KEY = 'wtd.worktrees';
    const GROUP_KEY = `origin:${APP}`;

    const named = (idx: number, name: string, repos: readonly string[], status: HostEntry['status'] = 'connected'): HostEntry => ({
      ...host(idx, repos),
      name,
      status,
    });
    /** Reports `repo` of `hostIdx` with `origin`, its main worktree, then `others`. */
    const stated = (
      hostIdx: number,
      repo: string,
      origin: string | null,
      others: readonly string[] = [],
      terminals: readonly Terminal[] = [],
    ): void => {
      client.store.apply(hostIdx, {
        t: 'repoState',
        repo,
        origin,
        worktrees: [worktree(repo, true), ...others.map((p) => worktree(p, false))],
        terminals: [...terminals],
        checked: [],
        layouts: [],
      });
    };
    const labels = (): string[] => view.tabs.value.map((t) => t.label);
    const rows = (): [number, string][] => view.listed.value.map((e) => [e.host, e.path]);
    const stored = (key: string): unknown => JSON.parse(localStorage.getItem(key) ?? 'null');
    const reopen = (): void => {
      view = new View(client, manager);
    };
    const tabLabelled = (label: string): (typeof view.tabs.value)[number] => {
      const tab = view.tabs.value.find((t) => t.label === label);
      if (tab === undefined) throw new Error(`no tab ${label}`);
      return tab;
    };
    const flush = (): Promise<void> =>
      new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    /** This machine listing `/r/app` and `box` listing `/srv/app`, both of origin APP, `box` with a worktree `fix`. */
    const sameOrigin = (): void => {
      client.store.hosts.value = [named(0, 'laptop', ['/r/app']), named(1, 'box', ['/srv/app'])];
      stated(0, '/r/app', APP, ['/r/app.w/feat']);
      stated(1, '/srv/app', APP, ['/srv/app.w/fix']);
    };

    beforeEach(() => {
      vi.stubGlobal('requestAnimationFrame', () => 0);
    });

    it('lists the worktrees of every clone of one origin in one tab, this machine’s first', () => {
      sameOrigin();
      expect(labels()).toEqual(['app']);
      expect(rows()).toEqual([
        [0, '/r/app'],
        [0, '/r/app.w/feat'],
        [1, '/srv/app'],
        [1, '/srv/app.w/fix'],
      ]);
    });

    it('shows only the selected host’s row and its terminals when two hosts share a path', () => {
      client.store.hosts.value = [named(0, 'laptop', ['/srv/app']), named(1, 'box', ['/srv/app'])];
      stated(0, '/srv/app', APP, [], [terminal(1, '/srv/app')]);
      stated(1, '/srv/app', APP, [], [terminal(2, '/srv/app')]);
      view.selectWorktree({ host: 1, path: '/srv/app' });
      expect(view.worktree.value).toEqual({ host: 1, path: '/srv/app' });
      expect(view.terminals.value.map((t) => t.termId)).toEqual([2]);
      expect(manager.has(1, 2)).toBe(true);
      view.setFilter('checked', true);
      expect(rows()).toEqual([[1, '/srv/app']]);
    });

    it('selects the tab that now holds the selected worktree when its repo joins another tab', () => {
      client.store.hosts.value = [named(0, 'laptop', ['/r/app']), named(1, 'box', ['/srv/app'])];
      stated(1, '/srv/app', APP, ['/srv/app.w/fix']);
      expect(labels()).toEqual(['app', 'box:app']);
      view.selectRepo(tabLabelled('box:app'));
      view.selectWorktree({ host: 1, path: '/srv/app.w/fix' });
      stated(0, '/r/app', APP);
      expect(labels()).toEqual(['app']);
      expect(view.tab.value?.label).toBe('app');
      expect(view.worktree.value).toEqual({ host: 1, path: '/srv/app.w/fix' });
    });

    it('follows the selected worktree to its new tab when its repo leaves the selected group, storing that tab', () => {
      sameOrigin();
      view.selectRepo(tabLabelled('app'));
      view.selectWorktree({ host: 1, path: '/srv/app.w/fix' });
      stated(1, '/srv/app', 'github.com/acme/fork', ['/srv/app.w/fix']);
      expect(labels()).toEqual(['app', 'box:app']);
      expect(view.tab.value?.label).toBe('box:app');
      expect(view.worktree.value).toEqual({ host: 1, path: '/srv/app.w/fix' });
      expect(localStorage.getItem(REPO_KEY)).toBe('origin:github.com/acme/fork');
      view.selectRepo(tabLabelled('app'));
      expect(view.tab.value?.label).toBe('app');
    });

    it('keeps the selected worktree when its repo joins a tab holding a default selection', () => {
      client.store.hosts.value = [named(0, 'laptop', ['/r/app']), named(1, 'box', ['/srv/app'])];
      stated(0, '/r/app', APP, ['/r/app.w/feat']);
      stated(1, '/srv/app', null, ['/srv/app.w/fix']);
      view.selectRepo(tabLabelled('app'));
      expect(view.worktree.value).toEqual({ host: 0, path: '/r/app' });
      view.selectRepo(tabLabelled('box:app'));
      view.selectWorktree({ host: 1, path: '/srv/app.w/fix' });
      stated(1, '/srv/app', APP, ['/srv/app.w/fix']);
      expect(labels()).toEqual(['app']);
      expect(view.worktree.value).toEqual({ host: 1, path: '/srv/app.w/fix' });
      stated(0, '/r/app', APP, ['/r/app.w/feat', '/r/app.w/new']);
      expect(view.worktree.value).toEqual({ host: 1, path: '/srv/app.w/fix' });
    });

    it('restores a stored repo of its own once its origin puts it in an origin tab, storing that tab', () => {
      localStorage.setItem(REPO_KEY, 'box:/srv/new');
      reopen();
      client.store.hosts.value = [named(0, 'laptop', ['/r/app']), named(1, 'box', ['/srv/new'])];
      stated(0, '/r/app', APP);
      stated(1, '/srv/new', 'github.com/acme/new');
      expect(labels()).toEqual(['app', 'box:new']);
      expect(view.tab.value?.label).toBe('box:new');
      expect(localStorage.getItem(REPO_KEY)).toBe('origin:github.com/acme/new');
    });

    it('shows a down host’s repo in a tab of its own until it joins its origin’s tab, and keeps it there while reconnecting', () => {
      client.store.hosts.value = [named(0, 'laptop', ['/r/app']), named(1, 'box', ['/srv/app'], 'down')];
      stated(0, '/r/app', APP);
      expect(labels()).toEqual(['app', 'box:app']);
      client.store.hosts.value = [named(0, 'laptop', ['/r/app']), named(1, 'box', ['/srv/app'])];
      stated(1, '/srv/app', APP);
      expect(labels()).toEqual(['app']);
      client.store.hosts.value = [named(0, 'laptop', ['/r/app']), named(1, 'box', ['/srv/app'], 'reconnecting')];
      client.store.clearHost(1);
      expect(labels()).toEqual(['app']);
    });

    it('stores a tab’s switches, search and selection under its origin group’s key, and restores them', () => {
      sameOrigin();
      view.selectRepo(tabLabelled('app'));
      view.setFilter('checked', true);
      view.setFilter('open', true);
      view.setSearch('fix');
      view.selectWorktree({ host: 1, path: '/srv/app.w/fix' });
      expect(localStorage.getItem(REPO_KEY)).toBe(GROUP_KEY);
      expect(stored(FILTERS_KEY)).toEqual({ [GROUP_KEY]: 'checked' });
      expect(stored(OPEN_KEY)).toEqual({ [GROUP_KEY]: 'open' });
      expect(stored(SEARCHES_KEY)).toEqual({ [GROUP_KEY]: 'fix' });
      expect(Object.keys(stored(WORKTREES_KEY) ?? {})).toEqual([GROUP_KEY]);
      reopen();
      expect(view.worktree.value).toEqual({ host: 1, path: '/srv/app.w/fix' });
    });

    it('restores a stored row of a host whose worktrees arrive after this machine’s', () => {
      sameOrigin();
      view.selectRepo(tabLabelled('app'));
      view.selectWorktree({ host: 1, path: '/srv/app.w/fix' });
      client.store.clearHost(0);
      client.store.clearHost(1);
      reopen();
      stated(0, '/r/app', APP, ['/r/app.w/feat']);
      expect(view.worktree.value).toEqual({ host: 0, path: '/r/app' });
      stated(1, '/srv/app', APP, ['/srv/app.w/fix']);
      expect(view.worktree.value).toEqual({ host: 1, path: '/srv/app.w/fix' });
    });

    it('stores an origin-less repo’s preferences under its host’s name and path', () => {
      client.store.hosts.value = [named(1, 'box', ['/srv/x'])];
      stated(1, '/srv/x', null);
      view.setFilter('open', true);
      expect(stored(OPEN_KEY)).toEqual({ 'box:/srv/x': 'open' });
    });

    it('keeps a tab’s preferences when the config lists another clone of its origin first', () => {
      localStorage.setItem(FILTERS_KEY, JSON.stringify({ [GROUP_KEY]: 'checked' }));
      reopen();
      client.store.hosts.value = [named(0, 'laptop', ['/r/app-2', '/r/app'])];
      stated(0, '/r/app-2', APP);
      stated(0, '/r/app', APP);
      expect(labels()).toEqual(['app-2']);
      expect(view.filter.value).toEqual({ checked: true, open: false });
    });

    it('ignores preferences stored under the old host-index keys', () => {
      localStorage.setItem(REPO_KEY, '0:/r/lib');
      localStorage.setItem(FILTERS_KEY, JSON.stringify({ '0:/r/app': 'checked' }));
      localStorage.setItem(OPEN_KEY, JSON.stringify({ '0:/r/app': 'open' }));
      localStorage.setItem(WORKTREES_KEY, JSON.stringify({ '0:/r/app': '/r/app.w/b' }));
      reopen();
      client.store.hosts.value = [named(0, 'laptop', ['/r/app', '/r/lib'])];
      stated(0, '/r/app', null, ['/r/app.w/b']);
      stated(0, '/r/lib', null);
      expect(view.tab.value?.label).toBe('app');
      expect(view.filter.value).toEqual({ checked: false, open: false });
      expect(view.worktree.value).toEqual({ host: 0, path: '/r/app' });
    });

    it('sends a row’s checkbox toggle to the row’s host', async () => {
      const request = vi.spyOn(client, 'request').mockResolvedValue({ t: 'done', req: 1 });
      sameOrigin();
      await view.setChecked({ host: 1, path: '/srv/app.w/fix' }, true);
      expect(request).toHaveBeenCalledWith(1, { t: 'setChecked', worktree: '/srv/app.w/fix', checked: true });
    });

    it('asks to remove every listed repo of the group, naming each, and removes them in one request', () => {
      sameOrigin();
      view.requestRemoveRepo(tabLabelled('app'));
      expect(view.confirmation.value).toMatchObject({ t: 'removeRepo', names: ['/r/app', 'box:/srv/app'] });
      const removeRepos = vi.spyOn(client, 'removeRepos').mockResolvedValue(undefined);
      view.confirm();
      expect(removeRepos).toHaveBeenCalledWith([
        { host: 0, repo: '/r/app' },
        { host: 1, repo: '/srv/app' },
      ]);
    });

    it('leaves a repo the hub no longer lists out of the removal, sending nothing for a tab of only such repos', () => {
      sameOrigin();
      client.store.hosts.value = [named(0, 'laptop', ['/r/app']), named(1, 'box', ['/srv/old'])];
      client.store.keep(1, '/srv/app', true);
      stated(1, '/srv/old', null);
      client.store.keep(1, '/srv/gone', true);
      const removeRepos = vi.spyOn(client, 'removeRepos').mockResolvedValue(undefined);
      view.requestRemoveRepo(tabLabelled('app'));
      expect(view.confirmation.value).toMatchObject({ t: 'removeRepo', names: ['/r/app'] });
      view.confirm();
      expect(removeRepos).toHaveBeenCalledWith([{ host: 0, repo: '/r/app' }]);
      view.requestRemoveRepo(tabLabelled('box:gone'));
      view.confirm();
      expect(removeRepos).toHaveBeenCalledTimes(1);
    });

    describe('rows at the same path on two hosts', () => {
      const SAME = '/w/fix';

      /** This machine's `/r/app` and `box`'s `/srv/app`, both of origin APP, each with a worktree at SAME; `box`'s is locked. */
      beforeEach(() => {
        client.store.hosts.value = [named(0, 'laptop', ['/r/app']), named(1, 'box', ['/srv/app'])];
        for (const [hostIdx, repo, locked] of [
          [0, '/r/app', false],
          [1, '/srv/app', true],
        ] as const) {
          client.store.apply(hostIdx, {
            t: 'repoState',
            repo,
            origin: APP,
            worktrees: [worktree(repo, true), { ...worktree(SAME, false), locked }],
            terminals: [],
            checked: [],
            layouts: [],
          });
        }
      });

      it('opens the worktree menu on the right host’s row and checks deletion against that row', () => {
        view.openWorktreeMenu({ host: 1, path: SAME }, 5, 6);
        expect(view.worktreeMenu.value).toEqual({ host: 1, worktree: SAME, x: 5, y: 6 });
        expect(view.deleteBlocker({ host: 0, path: SAME })).toBeNull();
        expect(view.deleteBlocker({ host: 1, path: SAME })).toBe('It is locked');
      });

      it('deletes the worktree on the row’s host', () => {
        const request = vi.spyOn(client, 'request').mockResolvedValue({ t: 'done', req: 1 });
        view.deleteWorktree({ host: 0, path: SAME });
        expect(request).toHaveBeenCalledWith(0, { t: 'removeWorktree', worktree: SAME, force: false });
        expect(request).not.toHaveBeenCalledWith(1, expect.anything());
      });

      it('steps through the rows in sidebar order with Alt+Up and Alt+Down, telling the two apart', () => {
        const press = (code: 'ArrowUp' | 'ArrowDown'): boolean => view.handleKey(new TestKey(code, code, { altKey: true }), false);
        view.selectWorktree({ host: 0, path: SAME });
        press('ArrowDown');
        expect(view.worktree.value).toEqual({ host: 1, path: '/srv/app' });
        press('ArrowDown');
        expect(view.worktree.value).toEqual({ host: 1, path: SAME });
        press('ArrowDown');
        expect(view.worktree.value).toEqual({ host: 1, path: SAME });
        press('ArrowUp');
        press('ArrowUp');
        expect(view.worktree.value).toEqual({ host: 0, path: SAME });
      });
    });

    it('watches a local clone its session discovery finds, while the add-repo dialog shows only its own reply', async () => {
      const replies: ((repos: readonly { path: string; origin: string | null }[]) => void)[] = [];
      const discover = vi.spyOn(client, 'discoverRepos').mockImplementation(
        () =>
          new Promise((resolve) => {
            replies.push(resolve);
          }),
      );
      const request = vi.spyOn(client, 'request').mockResolvedValue({ t: 'done', req: 1 });
      client.store.hosts.value = [named(0, 'laptop', ['/r/app'])];
      stated(0, '/r/app', APP);
      view.openAddRepo();
      expect(discover.mock.calls).toEqual([[0], [0]]);
      const [session, dialog] = replies;
      dialog?.([{ path: '/r/other', origin: null }]);
      session?.([
        { path: '/r/app', origin: APP },
        { path: '/r/app-2', origin: APP },
        { path: '/r/other', origin: null },
      ]);
      await flush();
      expect(view.offered.value).toEqual(['/r/other']);
      expect(request.mock.calls.filter(([, body]) => body.t === 'watchRepo')).toEqual([[0, { t: 'watchRepo', repo: '/r/app-2' }]]);
      stated(0, '/r/app-2', APP, ['/r/app-2.w/x']);
      expect(labels()).toEqual(['app']);
      expect(rows()).toEqual([
        [0, '/r/app'],
        [0, '/r/app-2'],
        [0, '/r/app-2.w/x'],
      ]);
    });

    it('keeps watching a discovered clone when the config stops listing its path', () => {
      const request = vi.spyOn(client, 'request').mockResolvedValue({ t: 'done', req: 1 });
      const laptop = (repos: readonly string[]): HostEntry => ({ ...named(0, 'laptop', repos), instance: 'i' });
      const hosts = (entries: HostEntry[]): void => {
        const receive: unknown = Reflect.get(client, 'message');
        if (typeof receive !== 'function') throw new Error('no message handler');
        Reflect.apply(receive, client, [{ t: 'hosts', hosts: entries }]);
      };
      hosts([laptop(['/r/app', '/r/app-2'])]);
      client.store.addClone(0, '/r/app-2', APP);
      stated(0, '/r/app', APP);
      stated(0, '/r/app-2', APP);
      hosts([laptop(['/r/app'])]);
      expect(request.mock.calls.filter(([, body]) => body.t === 'unwatchRepo')).toEqual([]);
      expect(client.store.repo(0, '/r/app-2')).not.toBeNull();
      expect(rows()).toEqual([
        [0, '/r/app'],
        [0, '/r/app-2'],
      ]);
    });
  });
});
