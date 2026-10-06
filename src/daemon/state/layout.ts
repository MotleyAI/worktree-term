import type { Layout } from '../../protocol/index.js';

type Pane = Layout['tabs'][number]['root'];

const prunePane = (pane: Pane, live: ReadonlySet<number>): Pane | null => {
  if ('term' in pane) return live.has(pane.term) ? pane : null;
  const a = prunePane(pane.a, live);
  const b = prunePane(pane.b, live);
  if (a === null) return b;
  if (b === null) return a;
  return { ...pane, a, b };
};

/**
 * Removes leaves that are not `live`: a split loses to its remaining child, an empty tab is
 * removed, and `active` keeps its tab, else the nearest preceding remaining tab, else 0.
 */
export const pruneLayout = (layout: Layout, live: ReadonlySet<number>): Layout => {
  const tabs: Layout['tabs'] = [];
  let active = 0;
  layout.tabs.forEach((tab, index) => {
    const root = prunePane(tab.root, live);
    if (root === null) return;
    if (index <= layout.active) active = tabs.length;
    tabs.push({ ...tab, root });
  });
  return { tabs, active };
};
