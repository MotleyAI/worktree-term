import { describe, expect, it } from 'vitest';
import { layoutSchema, type Layout } from '../../protocol/index.js';
import { selectTab, terminalTabs } from './index.js';

const tab = (id: string, term: number): Layout['tabs'][number] => ({ id, root: { term } });

const twoTabs: Layout = { tabs: [tab('a', 1), tab('b', 2)], active: 1 };

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

  it('shows a split tab by its first live terminal when its first terminal is gone', () => {
    const split: Layout = {
      tabs: [
        { id: 'a', root: { split: 'right', ratio: 0.5, a: { split: 'down', ratio: 0.5, a: { term: 3 }, b: { term: 4 } }, b: { term: 2 } } },
      ],
      active: 0,
    };
    expect(terminalTabs(split, [2, 4])).toEqual({ tabs: [{ termId: 4, inLayout: true }], active: 4 });
    expect(terminalTabs(split, [2])).toEqual({ tabs: [{ termId: 2, inLayout: true }], active: 2 });
    expect(terminalTabs(split, [])).toEqual({ tabs: [], active: null });
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
