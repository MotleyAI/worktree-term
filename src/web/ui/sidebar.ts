import type { Terminal, Worktree } from '../../protocol/index.js';
import { worktreeLabel } from '../client/index.js';

export { worktreeLabel };

/** One sidebar entry. */
export interface SidebarEntry {
  path: string;
  label: string;
  prunable: boolean;
  /** No longer listed by git, kept while it has terminals. */
  gone: boolean;
  checked: boolean;
}

export type WorktreeFilter = 'all' | 'checked';

/** Each repo's filter by repo key; a repo without an entry shows all. */
export type RepoFilters = Readonly<Record<string, string>>;

/** The filter of the repo `key`. */
export const filterOf = (filters: RepoFilters, key: string): WorktreeFilter => (filters[key] === 'checked' ? 'checked' : 'all');

/** `filters` with the repo `key` set to `filter`; showing all drops its entry. */
export const withFilter = (filters: RepoFilters, key: string, filter: WorktreeFilter): RepoFilters => {
  const rest = Object.fromEntries(Object.entries(filters).filter(([k]) => k !== key));
  return filter === 'all' ? rest : { ...rest, [key]: filter };
};

/** Sidebar width bounds and default, in pixels. */
export const SIDEBAR_WIDTH = { min: 160, max: 640, initial: 260 } as const;

/** `width` rounded and held within the sidebar's bounds. */
export const clampSidebarWidth = (width: number): number => Math.round(Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, width)));

/** A stored sidebar width, or the default when missing or malformed. */
export const parseSidebarWidth = (stored: string | null): number =>
  stored !== null && /^\d{1,5}$/.test(stored) ? clampSidebarWidth(Number(stored)) : SIDEBAR_WIDTH.initial;

const directoryName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** Listed worktrees in the daemon's order without bare ones, then vanished worktrees that still have terminals. */
export const sidebarEntries = (state: {
  worktrees: readonly Worktree[];
  terminals: readonly Terminal[];
  checked: readonly string[];
}): SidebarEntry[] => {
  const checked = new Set(state.checked);
  const entries: SidebarEntry[] = state.worktrees
    .filter((w) => !w.bare)
    .map((w) => ({ path: w.path, label: worktreeLabel(w), prunable: w.prunable, gone: false, checked: checked.has(w.path) }));
  const listed = new Set(state.worktrees.map((w) => w.path));
  for (const terminal of state.terminals) {
    if (listed.has(terminal.worktree)) continue;
    listed.add(terminal.worktree);
    entries.push({ path: terminal.worktree, label: directoryName(terminal.worktree), prunable: false, gone: true, checked: false });
  }
  return entries;
};

/** The entries the filter shows; the selected entry is always shown. */
export const visibleWorktrees = (entries: readonly SidebarEntry[], filter: WorktreeFilter, selected: string | null): SidebarEntry[] =>
  filter === 'all' ? [...entries] : entries.filter((e) => e.checked || e.path === selected);

/** The worktree selected without a stored selection: the first the filter shows, else the first entry. */
export const defaultWorktree = (entries: readonly SidebarEntry[], filter: WorktreeFilter): string | null =>
  (visibleWorktrees(entries, filter, null)[0] ?? entries[0])?.path ?? null;
