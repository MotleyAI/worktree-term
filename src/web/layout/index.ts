import type { Layout } from '../../protocol/index.js';

type Pane = Layout['tabs'][number]['root'];

/** Most tabs a layout holds. */
const MAX_TABS = 64;

/** A terminal tab: the terminal it shows, and whether the layout holds it. */
export interface TerminalTab {
  termId: number;
  inLayout: boolean;
}

const firstTerm = (pane: Pane): number => ('term' in pane ? pane.term : firstTerm(pane.a));

const holds = (pane: Pane, termId: number): boolean =>
  'term' in pane ? pane.term === termId : holds(pane.a, termId) || holds(pane.b, termId);

/** The tabs of a worktree: each layout tab by its first live terminal, then live terminals the layout misses. */
export const terminalTabs = (layout: Layout | null, live: readonly number[]): { tabs: TerminalTab[]; active: number | null } => {
  const alive = new Set(live);
  const tabs: TerminalTab[] = [];
  let active: number | null = null;
  for (const [index, tab] of (layout?.tabs ?? []).entries()) {
    const termId = firstTerm(tab.root);
    if (!alive.has(termId)) continue;
    tabs.push({ termId, inLayout: true });
    if (index === layout?.active) active = termId;
  }
  for (const termId of live) {
    if (!(layout?.tabs ?? []).some((tab) => holds(tab.root, termId))) tabs.push({ termId, inLayout: false });
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

/** The layout with the tab holding `termId` active, appending a tab for a terminal it misses. */
export const selectTab = (layout: Layout | null, termId: number): Layout => {
  const tabs = layout?.tabs ?? [];
  const index = tabs.findIndex((tab) => holds(tab.root, termId));
  if (index >= 0) return { tabs: [...tabs], active: index };
  if (tabs.length >= MAX_TABS) return { tabs: [...tabs], active: layout?.active ?? 0 };
  return { tabs: [...tabs, { id: freeId(layout, termId), root: { term: termId } }], active: tabs.length };
};
