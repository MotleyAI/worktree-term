import { computed, effect, signal } from '@preact/signals';
import type { Layout, Terminal } from '../../protocol/index.js';
import { repoKey, type HubClient, type RepoState } from '../client/index.js';
import { selectTab, terminalTabs, type TerminalTab } from '../layout/index.js';
import type { TerminalManager } from '../terminals/index.js';
import { repoTabs, type RepoTab } from './repo-tabs.js';
import { defaultWorktree, sidebarEntries, visibleWorktrees, type SidebarEntry, type WorktreeFilter } from './sidebar.js';

/** Performance marks around a worktree switch (design D13). */
export const SWITCH_START = 'wtd:switch-start';
export const SWITCH_END = 'wtd:switch-end';

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

/** Marks the end of a switch just after the first frame painted with it applied. */
const markSwitchEnd = (): void => {
  requestAnimationFrame(() => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      performance.mark(SWITCH_END);
      channel.port1.close();
    };
    channel.port2.postMessage(null);
  });
};

/** A terminal tab with what its label needs. */
export interface ShownTab extends TerminalTab {
  terminal: Terminal | null;
}

/** The page's selection, stored per browser, and what it shows; keeps the terminal manager in step. */
export class View {
  readonly selectedRepo = signal<string | null>(load(REPO_KEY));
  readonly selections = signal<Readonly<Record<string, string>>>(loadSelections());
  readonly filter = signal<WorktreeFilter>(load(FILTER_KEY) === 'checked' ? 'checked' : 'all');

  readonly tabs = computed<RepoTab[]>(() => repoTabs(this.client.store.hosts.value));
  readonly tab = computed<RepoTab | null>(() => {
    const tabs = this.tabs.value;
    return tabs.find((t) => repoKey(t.host, t.repo) === this.selectedRepo.value) ?? tabs[0] ?? null;
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
  readonly termTabs = computed<{ tabs: ShownTab[]; active: number | null }>(() => {
    const worktree = this.worktree.value;
    const terminals = this.terminals.value;
    const layout = worktree === null ? null : (this.repo.value?.layouts.get(worktree) ?? null);
    const { tabs, active } = terminalTabs(
      layout,
      terminals.map((t) => t.termId),
    );
    return { tabs: tabs.map((tab) => ({ ...tab, terminal: terminals.find((t) => t.termId === tab.termId) ?? null })), active };
  });

  private shownKey = '';

  constructor(
    private readonly client: HubClient,
    private readonly manager: TerminalManager,
  ) {
    effect(() => {
      this.sync();
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
    markSwitchEnd();
  }

  setFilter(filter: WorktreeFilter): void {
    this.filter.value = filter;
    localStorage.setItem(FILTER_KEY, filter);
  }

  /** Shows the terminal of tab `termId` at once, then stores it as the worktree's active tab. */
  chooseTab(termId: number): void {
    const tab = this.tab.value;
    const worktree = this.worktree.value;
    if (tab === null || worktree === null) return;
    this.storeLayout(tab.host, worktree, selectTab(this.repo.value?.layouts.get(worktree) ?? null, termId));
  }

  /** Creates a shell in the selected worktree and makes it the active tab. */
  async newTerminal(): Promise<void> {
    const tab = this.tab.value;
    const worktree = this.worktree.value;
    if (tab === null || worktree === null) return;
    const { cols, rows } = this.manager.areaSize();
    const reply = await this.client.request(tab.host, { t: 'createTerm', worktree, preset: 'shell', command: null, cols, rows });
    if (reply.t !== 'termCreated') return;
    this.storeLayout(
      tab.host,
      worktree,
      selectTab(this.client.store.repo(tab.host, tab.repo)?.layouts.get(worktree) ?? null, reply.term.termId),
    );
  }

  async closeTerminal(termId: number): Promise<void> {
    const tab = this.tab.value;
    if (tab !== null) await this.client.request(tab.host, { t: 'closeTerm', termId });
  }

  async setChecked(path: string, checked: boolean): Promise<void> {
    const tab = this.tab.value;
    if (tab !== null) await this.client.request(tab.host, { t: 'setChecked', worktree: path, checked });
  }

  private storeLayout(host: number, worktree: string, layout: Layout): void {
    this.client.store.setLayout(host, worktree, layout);
    this.client.request(host, { t: 'setLayout', worktree, layout }).catch((error: unknown) => {
      console.warn('storing the layout failed', error);
    });
  }

  /** Opens the selected worktree's terminals on its first view and shows its active one. */
  private sync(): void {
    const status = this.client.store.status.value;
    const tab = this.tab.value;
    const worktree = this.worktree.value;
    const terminals = this.terminals.value;
    const { active } = this.termTabs.value;
    const host = tab === null ? undefined : this.client.store.hosts.value.find((h) => h.idx === tab.host);
    if ((status !== 'open' && status !== 'reconnecting') || tab === null || worktree === null) {
      this.showOnly(null, []);
      return;
    }
    if (host?.status === 'connected' && status === 'open') {
      for (const t of terminals) {
        if (!this.manager.has(tab.host, t.termId)) this.manager.open(tab.host, t.termId, tab.repo, { cols: t.cols, rows: t.rows });
      }
    }
    this.showOnly(tab.host, active !== null && this.manager.has(tab.host, active) ? [active] : []);
  }

  private showOnly(host: number | null, termIds: number[]): void {
    const key = `${String(host)}:${termIds.join(',')}`;
    if (key === this.shownKey) return;
    this.shownKey = key;
    this.manager.show(host, termIds);
  }
}
