import { describe, expect, it } from 'vitest';
import { layoutSchema, type Layout } from '../../protocol/index.js';
import {
  canAddTab,
  canSplit,
  DIVIDER,
  dividers,
  MAX_DEPTH,
  MAX_PANES,
  MAX_TABS,
  neighbour,
  paneRects,
  ratioAt,
  selectTab,
  setRatio,
  split,
  successor,
  terminalTabs,
  termsOf,
  type Divider,
  type PaneRect,
  type Rect,
} from './index.js';

type Pane = Layout['tabs'][number]['root'];

const tab = (id: string, term: number): Layout['tabs'][number] => ({ id, root: { term } });

const twoTabs: Layout = { tabs: [tab('a', 1), tab('b', 2)], active: 1 };

const leaf = (term: number): Pane => ({ term });
const right = (a: Pane, b: Pane, ratio = 0.5): Pane => ({ split: 'right', ratio, a, b });
const down = (a: Pane, b: Pane, ratio = 0.5): Pane => ({ split: 'down', ratio, a, b });
const oneTab = (root: Pane): Layout => ({ tabs: [{ id: 'a', root }], active: 0 });
const rect = (left: number, top: number, width: number, height: number): Rect => ({ left, top, width, height });

/** A balanced tree of right splits over `terms`. */
const panes = (terms: readonly number[]): Pane => {
  if (terms.length === 1) return leaf(terms[0] ?? 0);
  const half = Math.ceil(terms.length / 2);
  return right(panes(terms.slice(0, half)), panes(terms.slice(half)));
};

const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);

/** `count` single-pane tabs showing terminals 1..count. */
const manyTabs = (count: number): Layout => ({ tabs: range(1, count).map((term) => tab(`t${String(term)}`, term)), active: 0 });

const AREA = rect(0, 0, 804, 604);

/** The spec's pane navigation layout: split right, its right pane split down with ratio 0.3. */
const navigation = right(leaf(1), down(leaf(2), leaf(3), 0.3));

const pane = (termId: number, left: number, top: number, width: number, height: number): PaneRect => ({
  termId,
  rect: rect(left, top, width, height),
});

describe('terminalTabs', () => {
  it('shows each layout tab by its first terminal, with the layout’s active tab', () => {
    const split: Layout = {
      tabs: [
        tab('a', 1),
        { id: 'b', root: { split: 'right', ratio: 0.5, a: { split: 'down', ratio: 0.5, a: { term: 3 }, b: { term: 4 } }, b: { term: 2 } } },
      ],
      active: 1,
    };
    expect(terminalTabs(split, [1, 2, 3, 4])).toEqual({
      tabs: [
        { termId: 1, inLayout: true },
        { termId: 3, inLayout: true },
      ],
      active: 3,
    });
  });

  it('adds live terminals missing from the layout as further tabs', () => {
    expect(terminalTabs(twoTabs, [5, 1, 2, 7])).toEqual({
      tabs: [
        { termId: 1, inLayout: true },
        { termId: 2, inLayout: true },
        { termId: 5, inLayout: false },
        { termId: 7, inLayout: false },
      ],
      active: 2,
    });
  });

  it('shows the first tab of terminals without a layout', () => {
    expect(terminalTabs(null, [4, 9])).toEqual({
      tabs: [
        { termId: 4, inLayout: false },
        { termId: 9, inLayout: false },
      ],
      active: 4,
    });
    expect(terminalTabs({ tabs: [], active: 0 }, [4])).toEqual({ tabs: [{ termId: 4, inLayout: false }], active: 4 });
  });

  it('shows nothing for a worktree without terminals', () => {
    expect(terminalTabs(null, [])).toEqual({ tabs: [], active: null });
    expect(terminalTabs({ tabs: [], active: 0 }, [])).toEqual({ tabs: [], active: null });
  });
});

describe('selectTab', () => {
  it('activates the tab showing a terminal of the layout', () => {
    expect(selectTab(twoTabs, 1)).toEqual({ ...twoTabs, active: 0 });
  });

  it('activates a tab whose split holds the terminal', () => {
    const split: Layout = {
      tabs: [tab('a', 1), { id: 'b', root: { split: 'down', ratio: 0.5, a: { term: 2 }, b: { term: 3 } } }],
      active: 0,
    };
    expect(selectTab(split, 3).active).toBe(1);
  });

  it('appends an active tab for a terminal missing from the layout', () => {
    const next = selectTab(twoTabs, 9);
    expect(next.tabs.slice(0, 2)).toEqual(twoTabs.tabs);
    expect(next.tabs[2]?.root).toEqual({ term: 9 });
    expect(next.active).toBe(2);
    expect(layoutSchema.safeParse(next).success).toBe(true);
  });

  it('creates a layout for the first terminal', () => {
    const next = selectTab(null, 4);
    expect(next.tabs.map((t) => t.root)).toEqual([{ term: 4 }]);
    expect(next.active).toBe(0);
    expect(layoutSchema.safeParse(next).success).toBe(true);
  });

  it('gives new tabs ids unique within the layout', () => {
    let layout: Layout | null = null;
    for (const term of [1, 2, 3, 4, 5]) layout = selectTab(layout, term);
    const ids = layout?.tabs.map((t) => t.id) ?? [];
    expect(new Set(ids).size).toBe(5);
    expect(layoutSchema.safeParse(layout).success).toBe(true);
  });

  it('never reuses an id already in the layout', () => {
    const crowded: Layout = {
      tabs: Array.from({ length: 20 }, (_, i) => tab(selectTab(null, i + 1).tabs[0]?.id ?? 'x', i + 100)),
      active: 0,
    };
    const unique: Layout = { tabs: crowded.tabs.filter((t, i, all) => all.findIndex((u) => u.id === t.id) === i), active: 0 };
    const next = selectTab(unique, 1);
    expect(new Set(next.tabs.map((t) => t.id)).size).toBe(next.tabs.length);
    expect(layoutSchema.safeParse(next).success).toBe(true);
  });

  it('does not change the layout it is given', () => {
    const copy = structuredClone(twoTabs);
    selectTab(twoTabs, 9);
    selectTab(twoTabs, 1);
    expect(twoTabs).toEqual(copy);
  });
});

describe('limits', () => {
  it('holds 8 panes per tab, 16 levels and 64 tabs, with 4 px dividers', () => {
    expect({ MAX_PANES, MAX_DEPTH, MAX_TABS, DIVIDER }).toEqual({ MAX_PANES: 8, MAX_DEPTH: 16, MAX_TABS: 64, DIVIDER: 4 });
  });
});

describe('termsOf', () => {
  it('lists a tab’s terminals in tab order, side a before side b', () => {
    expect(termsOf(leaf(7))).toEqual([7]);
    expect(termsOf(right(down(leaf(3), leaf(4)), down(leaf(1), right(leaf(2), leaf(5)))))).toEqual([3, 4, 1, 2, 5]);
  });
});

describe('canAddTab', () => {
  it('allows tabs up to 64', () => {
    expect(canAddTab(null)).toBe(true);
    expect(canAddTab(manyTabs(63))).toBe(true);
    expect(canAddTab(manyTabs(64))).toBe(false);
  });
});

describe('canSplit', () => {
  it('allows splitting a tab of up to 7 panes', () => {
    const seven = oneTab(panes(range(1, 7)));
    expect(range(1, 7).map((term) => canSplit(seven, term))).toEqual(Array.from({ length: 7 }, () => true));
  });

  it('refuses to split a tab of 8 panes', () => {
    const eight = oneTab(panes(range(1, 8)));
    expect(range(1, 8).map((term) => canSplit(eight, term))).toEqual(Array.from({ length: 8 }, () => false));
  });

  it('judges only the tab holding the terminal', () => {
    const layout: Layout = { tabs: [{ id: 'full', root: panes(range(1, 8)) }, tab('b', 9)], active: 0 };
    expect(canSplit(layout, 1)).toBe(false);
    expect(canSplit(layout, 9)).toBe(true);
  });

  it('allows splitting a terminal missing from the layout only while a tab can be added', () => {
    expect(canSplit(null, 1)).toBe(true);
    expect(canSplit(manyTabs(63), 100)).toBe(true);
    expect(canSplit(manyTabs(64), 100)).toBe(false);
    expect(canSplit(manyTabs(64), 1)).toBe(true);
  });
});

describe('split', () => {
  it('splits a pane right, keeping it as side a and the new terminal as side b', () => {
    expect(split(oneTab(leaf(1)), 1, 'right', 5)).toEqual(oneTab(right(leaf(1), leaf(5))));
  });

  it('splits a pane down', () => {
    expect(split(oneTab(leaf(1)), 1, 'down', 5)).toEqual(oneTab(down(leaf(1), leaf(5))));
  });

  it('splits a pane inside an existing split, keeping the outer ratio', () => {
    const layout = oneTab(right(leaf(1), leaf(2), 0.3));
    expect(split(layout, 2, 'down', 3)).toEqual(oneTab(right(leaf(1), down(leaf(2), leaf(3)), 0.3)));
    expect(split(layout, 1, 'right', 3)).toEqual(oneTab(right(right(leaf(1), leaf(3)), leaf(2), 0.3)));
  });

  it('makes the tab holding the split active and leaves the other tabs alone', () => {
    const next = split(twoTabs, 1, 'down', 5);
    expect(next).toEqual({ tabs: [{ id: 'a', root: down(leaf(1), leaf(5)) }, tab('b', 2)], active: 0 });
  });

  it('gives a terminal missing from the layout its own tab first', () => {
    const next = split(twoTabs, 9, 'right', 10);
    expect(next.tabs.slice(0, 2)).toEqual(twoTabs.tabs);
    expect(next.tabs[2]?.root).toEqual(right(leaf(9), leaf(10)));
    expect(next.active).toBe(2);
    expect(layoutSchema.safeParse(next).success).toBe(true);
  });

  it('creates a layout when there is none', () => {
    const next = split(null, 4, 'down', 5);
    expect(next.tabs.map((t) => t.root)).toEqual([down(leaf(4), leaf(5))]);
    expect(next.active).toBe(0);
    expect(layoutSchema.safeParse(next).success).toBe(true);
  });

  it('throws when the split is not possible', () => {
    expect(split(oneTab(panes(range(1, 7))), 1, 'right', 99).tabs[0]?.root).toBeDefined();
    expect(() => split(oneTab(panes(range(1, 8))), 1, 'right', 99)).toThrow(Error);
    expect(() => split(manyTabs(64), 100, 'down', 101)).toThrow(Error);
  });

  it('does not change the layout it is given', () => {
    const layout = oneTab(right(leaf(1), leaf(2)));
    const copy = structuredClone(layout);
    split(layout, 2, 'down', 3);
    split(layout, 9, 'down', 10);
    expect(layout).toEqual(copy);
  });
});

describe('setRatio', () => {
  const layout: Layout = {
    tabs: [
      { id: 'a', root: right(leaf(1), leaf(5)) },
      { id: 'b', root: right(leaf(2), down(leaf(3), leaf(4), 0.3)) },
    ],
    active: 0,
  };

  it('sets the ratio of the split the path addresses', () => {
    expect(setRatio(layout, 1, ['b'], 0.6)).toEqual({
      ...layout,
      tabs: [layout.tabs[0], { id: 'b', root: right(leaf(2), down(leaf(3), leaf(4), 0.6)) }],
    });
    expect(setRatio(layout, 1, [], 0.25).tabs[1]?.root).toEqual(right(leaf(2), down(leaf(3), leaf(4), 0.3), 0.25));
    expect(setRatio(layout, 0, [], 0.7).tabs).toEqual([{ id: 'a', root: right(leaf(1), leaf(5), 0.7) }, layout.tabs[1]]);
  });

  it('keeps the ratio from 0.05 to 0.95', () => {
    expect(setRatio(layout, 1, ['b'], 0.01).tabs[1]?.root).toEqual(right(leaf(2), down(leaf(3), leaf(4), 0.05)));
    expect(setRatio(layout, 1, ['b'], 0.99).tabs[1]?.root).toEqual(right(leaf(2), down(leaf(3), leaf(4), 0.95)));
    expect(setRatio(layout, 1, [], -1).tabs[1]?.root).toEqual(right(leaf(2), down(leaf(3), leaf(4), 0.3), 0.05));
  });

  it('does not change the layout it is given', () => {
    const copy = structuredClone(layout);
    setRatio(layout, 1, ['b'], 0.6);
    expect(layout).toEqual(copy);
  });
});

describe('paneRects', () => {
  it('gives a single pane the whole area', () => {
    expect(paneRects(leaf(1), rect(10, 20, 804, 604))).toEqual([pane(1, 10, 20, 804, 604)]);
  });

  it('places side a left of a right split’s divider and side b after it', () => {
    expect(paneRects(right(leaf(1), leaf(2)), rect(10, 20, 804, 604))).toEqual([pane(1, 10, 20, 400, 604), pane(2, 414, 20, 400, 604)]);
  });

  it('places side a above a down split’s divider and side b below it', () => {
    expect(paneRects(down(leaf(1), leaf(2)), rect(10, 20, 804, 604))).toEqual([pane(1, 10, 20, 804, 300), pane(2, 10, 324, 804, 300)]);
  });

  it('rounds side a’s size and gives side b the rest', () => {
    expect(paneRects(right(leaf(1), leaf(2)), rect(0, 0, 805, 100))).toEqual([pane(1, 0, 0, 401, 100), pane(2, 405, 0, 400, 100)]);
    expect(paneRects(down(leaf(1), leaf(2), 0.3), AREA)).toEqual([pane(1, 0, 0, 804, 180), pane(2, 0, 184, 804, 420)]);
  });

  it('places nested splits within their side, in tab order', () => {
    expect(paneRects(navigation, AREA)).toEqual([pane(1, 0, 0, 400, 604), pane(2, 404, 0, 400, 180), pane(3, 404, 184, 400, 420)]);
    expect(paneRects(right(down(leaf(1), right(leaf(2), leaf(3))), leaf(4)), AREA)).toEqual([
      pane(1, 0, 0, 400, 300),
      pane(2, 0, 304, 198, 300),
      pane(3, 202, 304, 198, 300),
      pane(4, 404, 0, 400, 604),
    ]);
  });
});

describe('dividers', () => {
  it('has none for a single pane', () => {
    expect(dividers(leaf(1), AREA)).toEqual([]);
  });

  it('places each split’s divider between its sides, root split first', () => {
    expect(dividers(navigation, rect(10, 20, 804, 604))).toEqual([
      { path: [], split: 'right', rect: rect(410, 20, 4, 604), area: rect(10, 20, 804, 604) },
      { path: ['b'], split: 'down', rect: rect(414, 200, 400, 4), area: rect(414, 20, 400, 604) },
    ]);
  });

  it('lists side a’s dividers before side b’s, addressed by path', () => {
    expect(dividers(down(right(leaf(1), leaf(2)), right(leaf(3), leaf(4), 0.25)), AREA)).toEqual([
      { path: [], split: 'down', rect: rect(0, 300, 804, 4), area: AREA },
      { path: ['a'], split: 'right', rect: rect(400, 0, 4, 300), area: rect(0, 0, 804, 300) },
      { path: ['b'], split: 'right', rect: rect(200, 304, 4, 300), area: rect(0, 304, 804, 300) },
    ]);
    expect(dividers(right(down(leaf(1), right(leaf(2), leaf(3))), leaf(4)), AREA)).toEqual([
      { path: [], split: 'right', rect: rect(400, 0, 4, 604), area: AREA },
      { path: ['a'], split: 'down', rect: rect(0, 300, 400, 4), area: rect(0, 0, 400, 604) },
      { path: ['a', 'b'], split: 'right', rect: rect(198, 304, 4, 300), area: rect(0, 304, 400, 300) },
    ]);
  });
});

describe('ratioAt', () => {
  const area = rect(10, 20, 804, 604);

  /** The root divider of a two-pane split over `area`. */
  const divider = (root: Pane): Divider => {
    const [first] = dividers(root, area);
    if (first === undefined) throw new Error('no divider');
    return first;
  };

  it('gives the ratio that puts the divider’s centre at the point', () => {
    expect(ratioAt(divider(right(leaf(1), leaf(2))), { x: 412, y: 0 })).toBe(0.5);
    expect(ratioAt(divider(down(leaf(1), leaf(2))), { x: 0, y: 322 })).toBe(0.5);
  });

  it('follows x for a right split and y for a down split', () => {
    expect(ratioAt(divider(right(leaf(1), leaf(2))), { x: 212, y: 472 })).toBe(0.25);
    expect(ratioAt(divider(down(leaf(1), leaf(2))), { x: 212, y: 472 })).toBe(0.75);
  });

  it('keeps the ratio from 0.05 to 0.95', () => {
    const vertical = divider(right(leaf(1), leaf(2)));
    const horizontal = divider(down(leaf(1), leaf(2)));
    expect(ratioAt(vertical, { x: 10, y: 0 })).toBe(0.05);
    expect(ratioAt(vertical, { x: 2000, y: 0 })).toBe(0.95);
    expect(ratioAt(horizontal, { x: 0, y: -50 })).toBe(0.05);
    expect(ratioAt(horizontal, { x: 0, y: 624 })).toBe(0.95);
  });
});

describe('neighbour', () => {
  it('moves left and then right as in the pane navigation scenario', () => {
    const rects = paneRects(navigation, AREA);
    expect(neighbour(rects, 2, 'left')).toBe(1);
    expect(neighbour(rects, 1, 'right')).toBe(3);
  });

  it('moves up and down within a column', () => {
    const rects = paneRects(navigation, AREA);
    expect(neighbour(rects, 2, 'down')).toBe(3);
    expect(neighbour(rects, 3, 'up')).toBe(2);
    expect(neighbour(rects, 3, 'left')).toBe(1);
  });

  it('finds nothing at an edge', () => {
    const rects = paneRects(navigation, AREA);
    expect(neighbour(rects, 1, 'left')).toBeNull();
    expect(neighbour(rects, 1, 'up')).toBeNull();
    expect(neighbour(rects, 1, 'down')).toBeNull();
    expect(neighbour(rects, 2, 'right')).toBeNull();
    expect(neighbour(rects, 3, 'down')).toBeNull();
    expect(neighbour(paneRects(leaf(1), AREA), 1, 'right')).toBeNull();
  });

  it('prefers the pane overlapping most among unequal panes', () => {
    const rects = paneRects(right(down(leaf(1), leaf(2), 0.3), leaf(3)), AREA);
    expect(neighbour(rects, 3, 'left')).toBe(2);
    expect(neighbour([pane(1, 0, 0, 100, 100), pane(2, 110, 0, 50, 10), pane(3, 300, 0, 50, 100)], 1, 'right')).toBe(3);
  });

  it('breaks ties in overlap by the nearest pane, then by tab order', () => {
    const rects = paneRects(right(down(leaf(1), right(leaf(2), leaf(3))), leaf(4)), AREA);
    expect(neighbour(rects, 2, 'right')).toBe(3);
    expect(neighbour(rects, 4, 'left')).toBe(1);
    expect(neighbour(rects, 1, 'down')).toBe(2);
    expect(neighbour(rects, 3, 'up')).toBe(1);
    expect(neighbour(rects, 3, 'right')).toBe(4);
  });

  it('takes the nearest and then the first pane in the given order', () => {
    const focused = pane(1, 0, 100, 100, 100);
    expect(neighbour([focused, pane(2, 400, 100, 100, 100), pane(3, 200, 100, 100, 100)], 1, 'right')).toBe(3);
    const above = pane(2, 200, 0, 100, 150);
    const below = pane(3, 200, 150, 100, 150);
    expect(neighbour([focused, above, below], 1, 'right')).toBe(2);
    expect(neighbour([focused, below, above], 1, 'right')).toBe(3);
  });

  it('considers only panes lying wholly beyond the edge', () => {
    const focused = pane(1, 100, 100, 100, 100);
    const straddling = pane(2, 100, 0, 100, 150);
    const beyond = pane(3, 150, 0, 50, 90);
    expect(neighbour([focused, straddling, beyond], 1, 'up')).toBe(3);
    expect(neighbour([focused, straddling], 1, 'up')).toBeNull();
  });
});

describe('successor', () => {
  it('gives the first terminal of the sibling that takes the pane’s place', () => {
    const root = right(leaf(1), down(leaf(2), leaf(3)));
    expect(successor(root, 1)).toBe(2);
    expect(successor(root, 2)).toBe(3);
    expect(successor(root, 3)).toBe(2);
  });

  it('gives the first terminal of a nested sibling subtree', () => {
    expect(successor(right(down(right(leaf(4), leaf(7)), leaf(5)), leaf(6)), 6)).toBe(4);
  });

  it('gives nothing for a tab’s only pane or a terminal it does not hold', () => {
    expect(successor(leaf(1), 1)).toBeNull();
    expect(successor(right(leaf(1), leaf(2)), 9)).toBeNull();
  });
});
