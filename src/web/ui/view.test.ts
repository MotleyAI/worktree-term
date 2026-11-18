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
      view.selectRepo({ host: 0, repo: '/r/empty', label: 'empty' });
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
      expect(view.handleKey(new TestKey('ArrowRight', 'ArrowRight', { ctrlKey: true, shiftKey: true }), false)).toBe(true);
      expect(shown()).toBe('/r/a');
    });
  });
});
