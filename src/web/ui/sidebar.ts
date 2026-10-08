import type { Terminal, Worktree } from '../../protocol/index.js';
import { SHORT_HEAD, worktreeLabel } from '../client/index.js';

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

/** Each repo's name search by repo key; a repo without an entry searches nothing. */
export type RepoSearches = Readonly<Record<string, string>>;

/** `record` with the repo `key` set to `value`; null drops its entry. */
const withEntry = (record: Readonly<Record<string, string>>, key: string, value: string | null): Readonly<Record<string, string>> => {
  const rest = Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));
  return value === null ? rest : { ...rest, [key]: value };
};

/** The filter of the repo `key`. */
export const filterOf = (filters: RepoFilters, key: string): WorktreeFilter => (filters[key] === 'checked' ? 'checked' : 'all');

/** `filters` with the repo `key` set to `filter`; showing all drops its entry. */
export const withFilter = (filters: RepoFilters, key: string, filter: WorktreeFilter): RepoFilters =>
  withEntry(filters, key, filter === 'all' ? null : filter);

/** The name search of the repo `key`. */
export const searchOf = (searches: RepoSearches, key: string): string => searches[key] ?? '';

/** `searches` with the repo `key` set to `search`; an empty search drops its entry. */
export const withSearch = (searches: RepoSearches, key: string, search: string): RepoSearches =>
  withEntry(searches, key, search === '' ? null : search);

/** Whether `label` contains `search`, trimmed, ignoring case; a blank search matches every label. */
export const matchesSearch = (label: string, search: string): boolean => label.toLowerCase().includes(search.trim().toLowerCase());

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

/** The entries the filter and the name search show; the selected entry is always shown. */
export const visibleWorktrees = (
  entries: readonly SidebarEntry[],
  filter: WorktreeFilter,
  search: string,
  selected: string | null,
): SidebarEntry[] => entries.filter((e) => e.path === selected || ((filter === 'all' || e.checked) && matchesSearch(e.label, search)));

/** The worktree selected without a stored selection: the first the filter shows, else the first entry; the search plays no part. */
export const defaultWorktree = (entries: readonly SidebarEntry[], filter: WorktreeFilter): string | null =>
  (visibleWorktrees(entries, filter, '', null)[0] ?? entries[0])?.path ?? null;

/** What the daemon reported deleting a worktree would lose. */
export interface RemovalRisks {
  base: string | null;
  ahead: number | null;
  changes: number;
  /** Labels of the running terminals that would be closed. */
  running: readonly string[];
}

const plural = (n: number, one: string, many: string): string => `${String(n)} ${n === 1 ? one : many}`;

/** Every reason to confirm deleting a worktree, one sentence each. */
export const removalReasons = (risks: RemovalRisks): string[] => {
  const reasons: string[] = [];
  if (risks.ahead === null) reasons.push('There is no origin/main to check that its commits are merged.');
  else if (risks.ahead > 0) reasons.push(`It has ${plural(risks.ahead, 'commit', 'commits')} not in ${risks.base ?? 'origin/main'}.`);
  if (risks.changes > 0)
    reasons.push(`It has ${plural(risks.changes, 'uncommitted change', 'uncommitted changes')}, untracked files included.`);
  if (risks.running.length > 0) reasons.push(`Running terminals will be closed: ${risks.running.join(', ')}.`);
  return reasons;
};

/** What happens to a deleted worktree's commits: kept on its branch, or, detached, unreachable. */
export const keptNote = (worktree: Pick<Worktree, 'detached' | 'head'>, base: string | null): string => {
  if (!worktree.detached) return 'Its branch is kept.';
  const lost = `It has no branch: once it is deleted, its commits not in ${base ?? 'origin/main'} become unreachable`;
  return worktree.head === null ? `${lost}.` : `${lost}; its head is ${worktree.head.slice(0, SHORT_HEAD)}.`;
};
