import { batch, computed, effect, signal } from '@preact/signals';
import type { HostEntry, Layout, Preset, Terminal } from '../../protocol/index.js';
import { repoKey, type DaemonEvent, type HubClient, type RepoState } from '../client/index.js';
import {
  canAddTab,
  canSplit,
  dividers,
  neighbour,
  paneRects,
  pruneTo,
  ratioAt,
  selectTab,
  setRatio,
  split,
  successor,
  tabOf,
  terminalTabs,
  termsOf,
  type Divider,
  type Pane,
  type PaneRect,
  type Rect,
  type TerminalTab,
} from '../layout/index.js';
import type { Box, TerminalManager } from '../terminals/index.js';
import { closeTargets, needsConfirm } from './closing.js';
import { keymap, type Action } from './keymap.js';
import { pickerValid, type PickerContext, type PickerOp, type PickerWorld } from './picker.js';
import { repoTabs, type RepoTab } from './repo-tabs.js';
import { defaultWorktree, sidebarEntries, visibleWorktrees, type SidebarEntry, type WorktreeFilter } from './sidebar.js';

/** Performance marks around a worktree switch (design D13). */
export const SWITCH_START = 'wtd:switch-start';
export const SWITCH_END = 'wtd:switch-end';
/** Performance marks around one divider-drag pointer move. */
export const DRAG_MOVE = 'wtd:drag-move';
export const DRAG_PAINT = 'wtd:drag-paint';

/** Height of a pane's header above its terminal, in pixels. */
export const PANE_HEADER = 20;

const REPO_KEY = 'wtd.repo';
const WORKTREES_KEY = 'wtd.worktrees';
const FILTER_KEY = 'wtd.filter';

const load = (key: string): string | null => localStorage.getItem(key);

const loadSelections = (): Readonly<Record<string, string>> => {
  try {
    const value: unknown = JSON.parse(load(WORKTREES_KEY) ?? '{}');
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  } catch (error) {
    if (error instanceof SyntaxError) return {};
    throw error;
  }
};

/** Marks `name` just after the first frame painted from now. */
const markAfterPaint = (name: string): void => {
  requestAnimationFrame(() => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      performance.mark(name);
      channel.port1.close();
    };
    channel.port2.postMessage(null);
  });
};

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The box of a pane's terminal: the pane below its header. */
export const terminalBoxOf = (rect: Rect): Box => ({
  left: rect.left,
  top: rect.top + PANE_HEADER,
  width: rect.width,
  height: Math.max(0, rect.height - PANE_HEADER),
});

/**
 * The focused pane of `tab`: the one last chosen, else the one that took its place, else the first.
 * Records the answer in `records`, so a later close finds its heir.
 */
const resolveFocus = (records: Map<string, { termId: number; root: Pane }>, tab: ShownTab): number | null => {
  const terms = termsOf(tab.root);
  const record = records.get(tab.key);
  let termId = terms[0] ?? null;
  if (record !== undefined) {
    const heir = successor(record.root, record.termId);
    if (terms.includes(record.termId)) termId = record.termId;
    else if (heir !== null && terms.includes(heir)) termId = heir;
  }
  if (termId !== null) records.set(tab.key, { termId, root: tab.root });
  return termId;
};

/** A terminal tab with what its label, marks and panes need. */
export interface ShownTab extends TerminalTab {
  /** The terminal the tab is labelled by. */
  terminal: Terminal | null;
  /** The tab's live terminals in tab order. */
  terminals: Terminal[];
  /** Index of the tab in the layout; null for a terminal the layout misses. */
  index: number | null;
  /** Identifies the tab for its focused pane. */
  key: string;
  root: Pane;
}

/** A pane of the shown tab. */
export interface ShownPane extends PaneRect {
  terminal: Terminal | null;
}

export interface CloseRequest {
  host: number;
  repo: string;
  termIds: readonly number[];
}

interface Drag {
  host: number;
  worktree: string;
  tab: number;
  divider: Divider;
  layout: Layout;
}

interface Picker {
  context: PickerContext;
  index: number;
}

/** The page's selection, stored per browser, and what it shows; keeps the terminal manager in step. */
export class View {
  readonly selectedRepo = signal<string | null>(load(REPO_KEY));
  readonly selections = signal<Readonly<Record<string, string>>>(loadSelections());
  readonly filter = signal<WorktreeFilter>(load(FILTER_KEY) === 'checked' ? 'checked' : 'all');
  /** The terminal area in client coordinates. */
  readonly area = signal<Rect>({ left: 0, top: 0, width: 0, height: 0 });
  readonly picker = signal<Picker | null>(null);
  readonly closing = signal<CloseRequest | null>(null);
  /** A problem of the page itself, such as a failed copy. */
  readonly notice = signal<string | null>(null);
  private readonly drag = signal<Drag | null>(null);
  /** The focused pane per tab key, with the tab's panes when it was last resolved; replaced when the user chooses a pane. */
  private readonly focusRecords = signal(new Map<string, { termId: number; root: Pane }>());
  /** The layout the page last stored per host and worktree, to tell its echo from a change. */
  private readonly stored = new Map<string, string>();

  readonly tabs = computed<RepoTab[]>(() => repoTabs(this.client.store.hosts.value));
  readonly tab = computed<RepoTab | null>(() => {
    const tabs = this.tabs.value;
    return tabs.find((t) => repoKey(t.host, t.repo) === this.selectedRepo.value) ?? tabs[0] ?? null;
  });
  readonly host = computed<HostEntry | null>(() => {
    const tab = this.tab.value;
    return tab === null ? null : (this.client.store.hosts.value.find((h) => h.idx === tab.host) ?? null);
  });
  readonly repo = computed<RepoState | null>(() => {
    const tab = this.tab.value;
    return tab === null ? null : (this.client.store.repos.value.get(repoKey(tab.host, tab.repo)) ?? null);
  });
  readonly entries = computed<SidebarEntry[]>(() => {
    const repo = this.repo.value;
    return repo === null ? [] : sidebarEntries(repo);
  });
  readonly worktree = computed<string | null>(() => {
    const tab = this.tab.value;
    if (tab === null) return null;
    const stored = this.selections.value[repoKey(tab.host, tab.repo)];
    const entries = this.entries.value;
    if (stored !== undefined && entries.some((e) => e.path === stored)) return stored;
    return defaultWorktree(entries, this.filter.value);
  });
  readonly listed = computed<SidebarEntry[]>(() => visibleWorktrees(this.entries.value, this.filter.value, this.worktree.value));
  readonly terminals = computed<Terminal[]>(() => {
    const worktree = this.worktree.value;
    return (this.repo.value?.terminals ?? []).filter((t) => t.worktree === worktree);
  });
  /** The selected worktree's layout as shown: the one being dragged, else the stored one. */
  readonly layout = computed<Layout | null>(() => {
    const tab = this.tab.value;
    const worktree = this.worktree.value;
    if (tab === null || worktree === null) return null;
    const drag = this.drag.value;
    if (drag?.host === tab.host && drag.worktree === worktree) return drag.layout;
    return this.repo.value?.layouts.get(worktree) ?? null;
  });
  readonly termTabs = computed<{ tabs: ShownTab[]; active: number | null }>(() => {
    const tab = this.tab.value;
    const worktree = this.worktree.value ?? '';
    const terminals = this.terminals.value;
    const layout = this.layout.value;
    const live = new Set(terminals.map((t) => t.termId));
    const byId = (termId: number): Terminal | null => terminals.find((t) => t.termId === termId) ?? null;
    const { tabs, active } = terminalTabs(layout, [...live]);
    const prefix = `${String(tab?.host)}:${worktree}:`;
    return {
      tabs: tabs.map((t) => {
        const index = t.inLayout ? tabOf(layout, t.termId) : -1;
        const stored = layout?.tabs[index];
        const root = (stored === undefined ? null : pruneTo(stored.root, live)) ?? { term: t.termId };
        const terminalsOfTab = termsOf(root).flatMap((id) => byId(id) ?? []);
        return {
          ...t,
          terminal: byId(t.termId),
          terminals: terminalsOfTab,
          index: stored === undefined ? null : index,
          key: stored === undefined ? `${prefix}term:${String(t.termId)}` : `${prefix}${stored.id}`,
          root,
        };
      }),
      active,
    };
  });
  readonly activeTab = computed<ShownTab | null>(() => {
    const { tabs, active } = this.termTabs.value;
    return tabs.find((t) => t.termId === active) ?? null;
  });
  /** The local terminal area, the origin of pane rectangles. */
  readonly localArea = computed<Rect>(() => ({ left: 0, top: 0, width: this.area.value.width, height: this.area.value.height }));
  readonly panes = computed<ShownPane[]>(() => {
    const tab = this.activeTab.value;
    if (tab === null) return [];
    return paneRects(tab.root, this.localArea.value).map((p) => ({ ...p, terminal: tab.terminals.find((t) => t.termId === p.termId) ?? null }));
  });
  readonly dividers = computed<Divider[]>(() => {
    const tab = this.activeTab.value;
    return tab === null ? [] : dividers(tab.root, this.localArea.value);
  });
  readonly focused = computed<number | null>(() => {
    const records = this.focusRecords.value;
    const tab = this.activeTab.value;
    return tab === null ? null : resolveFocus(records, tab);
  });
  /** Whether a terminal may be created in the selected worktree now. */
  readonly canCreate = computed<boolean>(() => {
    const entry = this.entries.value.find((e) => e.path === this.worktree.value);
    return (
      entry !== undefined &&
      !entry.prunable &&
      !entry.gone &&
      this.host.value?.status === 'connected' &&
      this.client.store.presets.value !== null
    );
  });
  readonly canNewTab = computed<boolean>(() => this.canCreate.value && canAddTab(this.layout.value));
  readonly canSplit = computed<boolean>(() => {
    const focused = this.focused.value;
    return this.canCreate.value && focused !== null && canSplit(this.layout.value, focused);
  });
  /** Whether a picker or dialog owns the keys. */
  readonly modal = computed<boolean>(() => this.picker.value !== null || this.closing.value !== null);

  private shownKey = '';
  private focusKey = '';

  constructor(
    private readonly client: HubClient,
    private readonly manager: TerminalManager,
  ) {
    effect(() => {
      this.sync();
    });
    effect(() => {
      this.checkPicker();
    });
    effect(() => {
      this.checkClosing();
    });
    client.onEvent((host, m) => {
      this.event(host, m);
    });
    manager.onFocus((host, termId) => {
      if (host === this.tab.peek()?.host) this.focusPane(termId);
    });
  }

  selectRepo(tab: RepoTab): void {
    const key = repoKey(tab.host, tab.repo);
    this.selectedRepo.value = key;
    localStorage.setItem(REPO_KEY, key);
  }

  /** Selects `path` in the current repo, timing the switch. */
  selectWorktree(path: string): void {
    performance.mark(SWITCH_START);
    const tab = this.tab.value;
    if (tab === null) return;
    const selections = { ...this.selections.value, [repoKey(tab.host, tab.repo)]: path };
    this.selections.value = selections;
    localStorage.setItem(WORKTREES_KEY, JSON.stringify(selections));
    markAfterPaint(SWITCH_END);
  }

  setFilter(filter: WorktreeFilter): void {
    this.filter.value = filter;
    localStorage.setItem(FILTER_KEY, filter);
  }

  /** Shows the tab of `termId` at once, then stores it as the worktree's active tab. */
  chooseTab(termId: number): void {
    const tab = this.tab.value;
    const worktree = this.worktree.value;
    if (tab === null || worktree === null) return;
    this.storeLayout(tab.host, worktree, selectTab(this.storedLayout(tab.host, tab.repo, worktree), termId));
  }

  /** Makes the pane of `termId` in the shown tab the focused one. */
  focusPane(termId: number): void {
    const tab = this.activeTab.peek();
    if (tab === null || !termsOf(tab.root).includes(termId)) return;
    this.focusRecords.value = new Map(this.focusRecords.peek()).set(tab.key, { termId, root: tab.root });
  }

  async setChecked(path: string, checked: boolean): Promise<void> {
    const tab = this.tab.value;
    if (tab !== null) await this.client.request(tab.host, { t: 'setChecked', worktree: path, checked });
  }

  /** Starts a new terminal for `op` in the selected worktree, through the picker unless there is one preset. */
  startCreate(op: PickerOp): void {
    const tab = this.tab.value;
    const worktree = this.worktree.value;
    const presets = this.client.store.presets.value;
    if (tab === null || worktree === null || presets === null || !this.canCreate.value) return;
    const context: PickerContext = { host: tab.host, repo: tab.repo, worktree, op };
    if (!pickerValid(context, this.world())) return;
    const [only] = presets;
    if (presets.length === 1 && only !== undefined) this.create(context, only);
    else this.picker.value = { context, index: 0 };
  }

  movePicker(index: number): void {
    const picker = this.picker.value;
    if (picker !== null) this.picker.value = { ...picker, index };
  }

  /** Chooses the preset at `index` in the open picker. */
  choosePreset(index: number): void {
    const picker = this.picker.value;
    const preset = this.client.store.presets.value?.[index];
    this.picker.value = null;
    if (picker !== null && preset !== undefined) this.create(picker.context, preset);
  }

  cancelPicker(): void {
    this.picker.value = null;
  }

  /** Runs `preset` as a new tab of the selected worktree, which has no terminals. */
  choose(preset: Preset): void {
    const tab = this.tab.value;
    const worktree = this.worktree.value;
    if (tab === null || worktree === null || !this.canCreate.value) return;
    this.create({ host: tab.host, repo: tab.repo, worktree, op: { t: 'newTab' } }, preset);
  }

  /** Closes `termIds` of the selected repo, asking first when any of them is running. */
  requestClose(termIds: readonly number[]): void {
    const tab = this.tab.value;
    if (tab === null || termIds.length === 0) return;
    const request: CloseRequest = { host: tab.host, repo: tab.repo, termIds };
    if (needsConfirm(this.liveTerminals(request)).length === 0) this.close(request);
    else this.closing.value = request;
  }

  /** The running terminals the close dialog lists. */
  closingTargets(request: CloseRequest): Terminal[] {
    return needsConfirm(this.liveTerminals(request));
  }

  confirmClose(): void {
    const request = this.closing.value;
    this.closing.value = null;
    if (request !== null) this.close(request);
  }

  cancelClose(): void {
    this.closing.value = null;
  }

  /** Starts dragging `divider` of the shown tab. */
  startDrag(divider: Divider): void {
    const tab = this.tab.value;
    const worktree = this.worktree.value;
    const shown = this.activeTab.value;
    const layout = this.layout.value;
    const index = shown?.index ?? null;
    if (tab === null || worktree === null || index === null || layout === null) return;
    this.drag.value = { host: tab.host, worktree, tab: index, divider, layout };
  }

  /** Moves the dragged divider to the client point `x`, `y`. */
  moveDrag(x: number, y: number): void {
    performance.mark(DRAG_MOVE);
    const drag = this.drag.value;
    if (drag === null) return;
    const area = this.area.value;
    const ratio = ratioAt(drag.divider, { x: x - area.left, y: y - area.top });
    this.drag.value = { ...drag, layout: setRatio(drag.layout, drag.tab, drag.divider.path, ratio) };
    markAfterPaint(DRAG_PAINT);
  }

  /** Ends the drag, storing its layout. */
  endDrag(): void {
    const drag = this.drag.value;
    if (drag === null) return;
    this.drag.value = null;
    this.storeLayout(drag.host, drag.worktree, drag.layout);
  }

  /** Handles a key event; true when it is a shortcut, which then reaches nothing else. */
  handleKey(event: KeyboardEvent, inTerminal: boolean): boolean {
    const shortcut = keymap(event);
    if (shortcut === null) return false;
    if (event.type !== 'keydown') return true;
    // A terminal pastes on the browser's own paste event.
    if (!(inTerminal && shortcut.action.t === 'paste')) event.preventDefault();
    if (shortcut.act && !this.modal.peek()) this.act(shortcut.action);
    return true;
  }

  private act(action: Action): void {
    switch (action.t) {
      case 'worktree':
        this.stepWorktree(action.dir);
        return;
      case 'tab':
        this.stepTab(action.dir);
        return;
      case 'pane':
        this.stepPane(action.dir);
        return;
      case 'newTab':
        if (this.canNewTab.value) this.startCreate({ t: 'newTab' });
        return;
      case 'split': {
        const target = this.focused.value;
        if (this.canSplit.value && target !== null) this.startCreate({ t: 'split', dir: action.dir, target });
        return;
      }
      case 'close': {
        const focused = this.focused.value;
        if (focused !== null) this.requestClose([focused]);
        return;
      }
      case 'copy':
        this.copy();
        return;
      case 'paste':
        this.paste();
        return;
    }
  }

  private stepWorktree(dir: -1 | 1): void {
    const listed = this.listed.value;
    const next = listed[listed.findIndex((e) => e.path === this.worktree.value) + dir];
    if (next !== undefined && next.path !== this.worktree.value) this.selectWorktree(next.path);
  }

  private stepTab(dir: -1 | 1): void {
    const { tabs, active } = this.termTabs.value;
    const index = tabs.findIndex((t) => t.termId === active);
    const next = index < 0 ? undefined : tabs[index + dir];
    if (next !== undefined) this.chooseTab(next.termId);
  }

  private stepPane(dir: Parameters<typeof neighbour>[2]): void {
    const focused = this.focused.value;
    if (focused === null) return;
    const next = neighbour(this.panes.value, focused, dir);
    if (next !== null) this.focusPane(next);
  }

  private copy(): void {
    const host = this.tab.value?.host;
    const focused = this.focused.value;
    if (host === undefined || focused === null) return;
    const text = this.manager.selection(host, focused);
    if (text === '') return;
    navigator.clipboard.writeText(text).catch((error: unknown) => {
      this.notice.value = `Copying failed: ${message(error)}`;
    });
  }

  private paste(): void {
    const host = this.tab.value?.host;
    const focused = this.focused.value;
    if (host === undefined || focused === null) return;
    navigator.clipboard
      .readText()
      .then((text) => {
        this.manager.paste(host, focused, text);
      })
      .catch((error: unknown) => {
        this.notice.value = `Pasting failed: ${message(error)}`;
      });
  }

  private world(): PickerWorld {
    const tab = this.tab.value;
    return {
      host: tab?.host ?? null,
      repo: tab?.repo ?? null,
      worktree: this.worktree.value,
      hostStatus: this.host.value?.status ?? null,
      live: this.terminals.value.map((t) => t.termId),
      layout: this.layout.value,
    };
  }

  /** Closes the picker once its operation is no longer possible. */
  private checkPicker(): void {
    const picker = this.picker.value;
    if (picker === null) return;
    if (this.client.store.presets.value === null || !pickerValid(picker.context, this.world())) this.picker.value = null;
  }

  /** Closes the close dialog once all its targets are gone. */
  private checkClosing(): void {
    const request = this.closing.value;
    if (request !== null && this.liveTerminals(request).length === 0) this.closing.value = null;
  }

  private liveTerminals(request: CloseRequest): Terminal[] {
    const terminals = this.client.store.repo(request.host, request.repo)?.terminals ?? [];
    return request.termIds.flatMap((id) => terminals.find((t) => t.termId === id) ?? []);
  }

  private close(request: CloseRequest): void {
    const live = this.liveTerminals(request).map((t) => t.termId);
    closeTargets(request.termIds, live, async (termId) => {
      await this.client.request(request.host, { t: 'closeTerm', termId });
    }).catch((error: unknown) => {
      this.notice.value = `Closing failed: ${message(error)}`;
    });
  }

  private create(context: PickerContext, preset: Preset): void {
    if (!pickerValid(context, this.world())) return;
    const { host, repo, worktree, op } = context;
    const { cols, rows } = this.manager.sizeFor(this.newPaneBox(op));
    this.client
      .request(host, { t: 'createTerm', worktree, preset: preset.name, command: preset.command, cols, rows })
      .then((reply) => {
        if (reply.t === 'termCreated') this.place(host, repo, worktree, op, reply.term.termId);
      })
      .catch((error: unknown) => {
        this.notice.value = `Creating a terminal failed: ${message(error)}`;
      });
  }

  /** The box the terminal `op` creates will have. */
  private newPaneBox(op: PickerOp): Box {
    const area = this.localArea.value;
    if (op.t === 'newTab') return terminalBoxOf(area);
    const layout = split(this.layout.value, op.target, op.dir, 0);
    const root = layout.tabs[layout.active]?.root;
    const rect = root === undefined ? undefined : paneRects(root, area).find((p) => p.termId === 0)?.rect;
    return terminalBoxOf(rect ?? area);
  }

  /** Adds the created terminal `termId` to the latest layout, as `op` asked if still possible, and focuses it. */
  private place(host: number, repo: string, worktree: string, op: PickerOp, termId: number): void {
    const latest = this.storedLayout(host, repo, worktree);
    const terminals = this.client.store.repo(host, repo)?.terminals ?? [];
    let next: Layout;
    if (op.t === 'split' && terminals.some((t) => t.termId === op.target) && canSplit(latest, op.target)) {
      next = split(latest, op.target, op.dir, termId);
    }
    else if (canAddTab(latest)) next = selectTab(latest, termId);
    else return;
    const tab = next.tabs[next.active];
    batch(() => {
      if (tab !== undefined) {
        this.focusRecords.value = new Map(this.focusRecords.peek()).set(`${String(host)}:${worktree}:${tab.id}`, { termId, root: tab.root });
      }
      this.storeLayout(host, worktree, next);
    });
  }

  private storedLayout(host: number, repo: string, worktree: string): Layout | null {
    return this.client.store.repo(host, repo)?.layouts.get(worktree) ?? null;
  }

  private storeLayout(host: number, worktree: string, layout: Layout): void {
    this.stored.set(`${String(host)}:${worktree}`, JSON.stringify(layout));
    this.client.store.setLayout(host, worktree, layout);
    this.client.request(host, { t: 'setLayout', worktree, layout }).catch((error: unknown) => {
      this.client.store.revertLayout(host, worktree);
      console.warn('storing the layout failed', error);
    });
  }

  private event(host: number, m: DaemonEvent): void {
    const drag = this.drag.peek();
    if (m.t !== 'layoutChanged' || drag?.host !== host || drag.worktree !== m.worktree) return;
    // Our own layout coming back is no change.
    if (JSON.stringify(m.layout) !== this.stored.get(`${String(host)}:${m.worktree}`)) this.drag.value = null;
  }

  /** Opens the selected worktree's terminals on their first view, shows the panes of its active tab and focuses one. */
  private sync(): void {
    const status = this.client.store.status.value;
    const tab = this.tab.value;
    const worktree = this.worktree.value;
    const terminals = this.terminals.value;
    const panes = this.panes.value;
    const focused = this.focused.value;
    const modal = this.modal.value;
    if ((status !== 'open' && status !== 'reconnecting') || tab === null || worktree === null) {
      this.showOnly(null, []);
      return;
    }
    if (this.host.value?.status === 'connected' && status === 'open') {
      for (const t of terminals) {
        if (!this.manager.has(tab.host, t.termId)) this.manager.open(tab.host, t.termId, tab.repo, { cols: t.cols, rows: t.rows });
      }
    }
    const shown = panes.filter((p) => this.manager.has(tab.host, p.termId));
    this.showOnly(tab.host, shown);
    const focusKey = `${String(tab.host)}:${shown.map((p) => p.termId).join(',')}:${String(focused)}:${String(modal)}`;
    if (focusKey === this.focusKey) return;
    this.focusKey = focusKey;
    if (!modal && focused !== null && this.manager.has(tab.host, focused)) this.manager.focus(tab.host, focused);
  }

  private showOnly(host: number | null, panes: readonly PaneRect[]): void {
    const key = `${String(host)}:${JSON.stringify(panes.map((p) => [p.termId, p.rect]))}`;
    if (key === this.shownKey) return;
    this.shownKey = key;
    this.manager.show(
      host,
      panes.map((p) => ({ termId: p.termId, box: terminalBoxOf(p.rect) })),
    );
  }
}
