import type { Terminal, Worktree } from '../../protocol/index.js';

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

const SHORT_HEAD = 7;

const directoryName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** The branch, or `<directory> @ <short head>` when detached, or the directory name. */
export const worktreeLabel = (worktree: Worktree): string => {
  if (worktree.branch !== null) return worktree.branch;
  const dir = directoryName(worktree.path);
  return worktree.detached && worktree.head !== null ? `${dir} @ ${worktree.head.slice(0, SHORT_HEAD)}` : dir;
};

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
