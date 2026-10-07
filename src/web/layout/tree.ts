import type { Layout } from '../../protocol/index.js';

export type Pane = Layout['tabs'][number]['root'];
export type SplitDir = 'right' | 'down';
/** Steps from a tab's root to one of its splits. */
export type PanePath = readonly ('a' | 'b')[];

/** Most terminal panes a tab holds. */
export const MAX_PANES = 8;
/** Deepest pane nesting, a lone terminal pane counting as one level. */
export const MAX_DEPTH = 16;
/** Most tabs a layout holds. */
export const MAX_TABS = 64;

const MIN_RATIO = 0.05;
const MAX_RATIO = 0.95;

/** A terminal tab: the terminal it shows, and whether the layout holds it. */
export interface TerminalTab {
  termId: number;
  inLayout: boolean;
}

/** A tab's terminals in tab order, side a before side b. */
export const termsOf = (pane: Pane): number[] => ('term' in pane ? [pane.term] : [...termsOf(pane.a), ...termsOf(pane.b)]);

const depthOf = (pane: Pane): number => ('term' in pane ? 1 : 1 + Math.max(depthOf(pane.a), depthOf(pane.b)));

const holds = (pane: Pane, termId: number): boolean =>
  'term' in pane ? pane.term === termId : holds(pane.a, termId) || holds(pane.b, termId);

export const clampRatio = (ratio: number): number => Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));

/** Index of the tab holding `termId`, or -1. */
export const tabOf = (layout: Layout | null, termId: number): number => (layout?.tabs ?? []).findIndex((tab) => holds(tab.root, termId));

/** The tabs of a worktree: each layout tab by its first live terminal, then live terminals the layout misses. */
export const terminalTabs = (layout: Layout | null, live: readonly number[]): { tabs: TerminalTab[]; active: number | null } => {
  const alive = new Set(live);
  const tabs: TerminalTab[] = [];
  let active: number | null = null;
  for (const [index, tab] of (layout?.tabs ?? []).entries()) {
    const termId = termsOf(tab.root).find((t) => alive.has(t));
    if (termId === undefined) continue;
    tabs.push({ termId, inLayout: true });
    if (index === layout?.active) active = termId;
  }
  for (const termId of live) {
    if (tabOf(layout, termId) < 0) tabs.push({ termId, inLayout: false });
  }
  return { tabs, active: active ?? tabs[0]?.termId ?? null };
};

const freeId = (layout: Layout | null, termId: number): string => {
  const taken = new Set(layout?.tabs.map((tab) => tab.id));
  const base = `t${String(termId)}`;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const id = `${base}-${String(n)}`;
    if (!taken.has(id)) return id;
  }
};

/** Whether the layout can take another tab. */
export const canAddTab = (layout: Layout | null): boolean => (layout?.tabs.length ?? 0) < MAX_TABS;

/** The layout with the tab holding `termId` active, appending a tab for a terminal it misses. */
export const selectTab = (layout: Layout | null, termId: number): Layout => {
  const tabs = layout?.tabs ?? [];
  const index = tabOf(layout, termId);
  if (index >= 0) return { tabs: [...tabs], active: index };
  if (!canAddTab(layout)) return { tabs: [...tabs], active: layout?.active ?? 0 };
  return { tabs: [...tabs, { id: freeId(layout, termId), root: { term: termId } }], active: tabs.length };
};

/** Whether the pane of `termId` can be split, giving it its own tab first when the layout misses it. */
export const canSplit = (layout: Layout | null, termId: number): boolean => {
  const tab = layout?.tabs[tabOf(layout, termId)];
  if (tab === undefined) return canAddTab(layout);
  return termsOf(tab.root).length < MAX_PANES && depthOf(tab.root) < MAX_DEPTH;
};

const replaceLeaf = (pane: Pane, termId: number, by: Pane): Pane => {
  if ('term' in pane) return pane.term === termId ? by : pane;
  return { ...pane, a: replaceLeaf(pane.a, termId, by), b: replaceLeaf(pane.b, termId, by) };
};

/** Splits the pane of `termId` in direction `dir`, `newTerm` taking side b; throws when it cannot be split. */
export const split = (layout: Layout | null, termId: number, dir: SplitDir, newTerm: number): Layout => {
  if (!canSplit(layout, termId)) throw new Error(`the pane of terminal ${String(termId)} cannot be split`);
  const selected = selectTab(layout, termId);
  const index = selected.active;
  return {
    tabs: selected.tabs.map((tab, i) =>
      i === index
        ? { ...tab, root: replaceLeaf(tab.root, termId, { split: dir, ratio: 0.5, a: { term: termId }, b: { term: newTerm } }) }
        : tab,
    ),
    active: index,
  };
};

const withRatio = (pane: Pane, path: PanePath, ratio: number): Pane => {
  if ('term' in pane) return pane;
  const [step, ...rest] = path;
  if (step === undefined) return { ...pane, ratio };
  return step === 'a' ? { ...pane, a: withRatio(pane.a, rest, ratio) } : { ...pane, b: withRatio(pane.b, rest, ratio) };
};

/** Sets the ratio, kept from 0.05 to 0.95, of the split at `path` in tab `tab`. */
export const setRatio = (layout: Layout, tab: number, path: PanePath, ratio: number): Layout => ({
  ...layout,
  tabs: layout.tabs.map((t, i) => (i === tab ? { ...t, root: withRatio(t.root, path, clampRatio(ratio)) } : t)),
});

/** `pane` without the terminals that are not `live`: a split gives way to its remaining side; null when none is live. */
export const pruneTo = (pane: Pane, live: ReadonlySet<number>): Pane | null => {
  if ('term' in pane) return live.has(pane.term) ? pane : null;
  const a = pruneTo(pane.a, live);
  const b = pruneTo(pane.b, live);
  if (a === null || b === null) return a ?? b;
  return a === pane.a && b === pane.b ? pane : { ...pane, a, b };
};

/** The terminal whose pane takes the place of `termId`'s when it closes, or null. */
export const successor = (root: Pane, termId: number): number | null => {
  if ('term' in root) return null;
  if ('term' in root.a && root.a.term === termId) return termsOf(root.b)[0] ?? null;
  if ('term' in root.b && root.b.term === termId) return termsOf(root.a)[0] ?? null;
  return successor(root.a, termId) ?? successor(root.b, termId);
};
