import { describe, expect, it } from 'vitest';
import type { Layout } from '../../protocol/index.js';
import { pruneLayout } from './index.js';

type Pane = Layout['tabs'][number]['root'];

const right = (a: Pane, b: Pane, ratio = 0.5): Pane => ({ split: 'right', ratio, a, b });
const down = (a: Pane, b: Pane, ratio = 0.5): Pane => ({ split: 'down', ratio, a, b });
const t = (term: number): Pane => ({ term });

/** One single-pane tab per terminal id, named after it. */
const tabsOf = (...terms: number[]): Layout['tabs'] => terms.map((term) => ({ id: `t${String(term)}`, root: t(term) }));

const live = (...terms: number[]): ReadonlySet<number> => new Set(terms);

describe('pruneLayout', () => {
  it('keeps a layout whose terminals are all live', () => {
    const layout: Layout = { tabs: [{ id: 'a', root: right(t(1), down(t(2), t(3), 0.3), 0.7) }, ...tabsOf(4)], active: 1 };
    expect(pruneLayout(layout, live(1, 2, 3, 4))).toEqual(layout);
  });

  it('replaces a split by its remaining child', () => {
    const layout: Layout = { tabs: [{ id: 'a', root: right(t(1), t(2)) }], active: 0 };
    expect(pruneLayout(layout, live(2))).toEqual({ tabs: [{ id: 'a', root: t(2) }], active: 0 });
  });

  it('collapses only the split that lost a child, keeping direction and ratio elsewhere', () => {
    const layout: Layout = { tabs: [{ id: 'a', root: right(t(1), down(t(2), t(3), 0.3), 0.7) }], active: 0 };
    expect(pruneLayout(layout, live(1, 3))).toEqual({ tabs: [{ id: 'a', root: right(t(1), t(3), 0.7) }], active: 0 });
  });

  it('replaces a split by a remaining subtree', () => {
    const layout: Layout = { tabs: [{ id: 'a', root: right(t(1), down(t(2), t(3), 0.3), 0.7) }], active: 0 };
    expect(pruneLayout(layout, live(2, 3))).toEqual({ tabs: [{ id: 'a', root: down(t(2), t(3), 0.3) }], active: 0 });
  });

  it('removes a tab left empty', () => {
    const layout: Layout = { tabs: [{ id: 'a', root: right(t(1), t(2)) }, ...tabsOf(3)], active: 1 };
    expect(pruneLayout(layout, live(3))).toEqual({ tabs: tabsOf(3), active: 0 });
  });

  it('keeps the active tab when it remains, at its new index', () => {
    expect(pruneLayout({ tabs: tabsOf(1, 2, 3), active: 2 }, live(2, 3))).toEqual({ tabs: tabsOf(2, 3), active: 1 });
  });

  it('moves active to the preceding tab when the active tab is removed', () => {
    expect(pruneLayout({ tabs: tabsOf(1, 2, 3), active: 2 }, live(1, 2))).toEqual({ tabs: tabsOf(1, 2), active: 1 });
  });

  it('moves active to the nearest preceding remaining tab', () => {
    expect(pruneLayout({ tabs: tabsOf(1, 2, 3, 4), active: 2 }, live(1, 4))).toEqual({ tabs: tabsOf(1, 4), active: 0 });
  });

  it('sets active to 0 when no preceding tab remains', () => {
    expect(pruneLayout({ tabs: tabsOf(1, 2, 3), active: 1 }, live(3))).toEqual({ tabs: tabsOf(3), active: 0 });
  });

  it('sets active to 0 when the first tab was active and is removed', () => {
    expect(pruneLayout({ tabs: tabsOf(1, 2, 3), active: 0 }, live(2, 3))).toEqual({ tabs: tabsOf(2, 3), active: 0 });
  });

  it('empties a layout without live terminals', () => {
    const layout: Layout = { tabs: [{ id: 'a', root: right(t(1), t(2)) }, ...tabsOf(3)], active: 1 };
    expect(pruneLayout(layout, live())).toEqual({ tabs: [], active: 0 });
  });

  it('keeps an empty layout empty', () => {
    expect(pruneLayout({ tabs: [], active: 0 }, live(1))).toEqual({ tabs: [], active: 0 });
  });
});
