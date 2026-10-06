import { describe, expect, it } from 'vitest';
import { decodeMessage, encodeMessage, layoutSchema, ProtocolError } from './index.js';
import { fullTabLayout, raw, WT, type Layout, type Pane } from './test-samples.js';

const setLayout = (layout: unknown): string => raw({ t: 'setLayout', req: 1, worktree: WT, layout });

const accepts = (layout: unknown): boolean => {
  try {
    decodeMessage('clientToDaemon', setLayout(layout));
    return true;
  } catch (error) {
    expect(error).toBeInstanceOf(ProtocolError);
    return false;
  }
};

const split = (a: Pane, b: Pane, ratio = 0.5): Pane => ({ split: 'right', ratio, a, b });

/** A pane tree whose deepest path holds `levels` panes. */
const nested = (levels: number): Pane => {
  let pane: Pane = { term: 1 };
  for (let level = 2; level <= levels; level++) {
    pane = split({ term: level }, pane);
  }
  return pane;
};

/** A balanced pane tree over terminals `first`..`last`, alternating right and down splits by level. */
const balanced = (first: number, last: number, dir: 'right' | 'down' = 'right'): Pane => {
  if (first === last) return { term: first };
  const mid = Math.floor((first + last) / 2);
  const next = dir === 'right' ? 'down' : 'right';
  return { split: dir, ratio: 0.5, a: balanced(first, mid, next), b: balanced(mid + 1, last, next) };
};

const oneTab = (root: Pane): Layout => ({ tabs: [{ id: 't', root }], active: 0 });

const tabs = (n: number): Layout['tabs'] => Array.from({ length: n }, (_, i) => ({ id: `t${String(i)}`, root: { term: i + 1 } }));

describe('layout validity', () => {
  it('accepts an empty layout', () => {
    expect(accepts({ tabs: [], active: 0 })).toBe(true);
  });

  it('rejects an empty layout with active 1', () => {
    expect(accepts({ tabs: [], active: 1 })).toBe(false);
  });

  it('rejects a split with the same terminal in both children', () => {
    expect(accepts(oneTab(split({ term: 5 }, { term: 5 })))).toBe(false);
  });

  it('rejects the same terminal in two tabs', () => {
    expect(
      accepts({
        tabs: [
          { id: 'a', root: { term: 5 } },
          { id: 'b', root: { term: 5 } },
        ],
        active: 0,
      }),
    ).toBe(false);
  });

  it('accepts nesting 8 levels deep', () => {
    expect(accepts(oneTab(nested(8)))).toBe(true);
  });

  it('rejects nesting 17 levels deep', () => {
    expect(accepts(oneTab(nested(17)))).toBe(false);
  });

  it('accepts 8 panes in a tab', () => {
    expect(accepts(fullTabLayout)).toBe(true);
    expect(accepts(oneTab(balanced(1, 8)))).toBe(true);
  });

  it('rejects 9 panes in a tab of mixed right and down splits', () => {
    expect(accepts(oneTab(balanced(1, 9)))).toBe(false);
  });

  it('rejects a chain of 9 panes', () => {
    expect(accepts(oneTab(nested(9)))).toBe(false);
  });

  it('limits panes per tab, not per layout', () => {
    expect(
      accepts({
        tabs: [
          { id: 'a', root: balanced(1, 8) },
          { id: 'b', root: balanced(9, 16, 'down') },
        ],
        active: 1,
      }),
    ).toBe(true);
  });

  it('rejects an active index past the last tab', () => {
    expect(accepts({ tabs: tabs(2), active: 2 })).toBe(false);
  });

  it('accepts the last tab as active', () => {
    expect(accepts({ tabs: tabs(2), active: 1 })).toBe(true);
  });

  it('rejects a negative active index', () => {
    expect(accepts({ tabs: tabs(2), active: -1 })).toBe(false);
  });

  it('accepts 64 tabs and rejects 65', () => {
    expect(accepts({ tabs: tabs(64), active: 63 })).toBe(true);
    expect(accepts({ tabs: tabs(65), active: 0 })).toBe(false);
  });

  it('rejects duplicate tab ids', () => {
    expect(
      accepts({
        tabs: [
          { id: 'a', root: { term: 1 } },
          { id: 'a', root: { term: 2 } },
        ],
        active: 0,
      }),
    ).toBe(false);
  });

  it.each([
    ['empty', ''],
    ['65 characters', 'i'.repeat(65)],
  ])('rejects a tab id that is %s', (_name, id) => {
    expect(accepts({ tabs: [{ id, root: { term: 1 } }], active: 0 })).toBe(false);
  });

  it('accepts a 64-character tab id', () => {
    expect(accepts({ tabs: [{ id: 'i'.repeat(64), root: { term: 1 } }], active: 0 })).toBe(true);
  });

  it.each([
    [0.05, true],
    [0.95, true],
    [0.049, false],
    [0.951, false],
  ])('ratio %d accepted: %s', (ratio, ok) => {
    expect(accepts(oneTab(split({ term: 1 }, { term: 2 }, ratio)))).toBe(ok);
  });

  it('accepts a down split', () => {
    expect(accepts(oneTab({ split: 'down', ratio: 0.5, a: { term: 1 }, b: { term: 2 } }))).toBe(true);
  });

  it('rejects an unknown split direction', () => {
    expect(accepts({ tabs: [{ id: 't', root: { split: 'left', ratio: 0.5, a: { term: 1 }, b: { term: 2 } } }], active: 0 })).toBe(false);
  });

  it('rejects a pane that is both a terminal and a split', () => {
    expect(accepts({ tabs: [{ id: 't', root: { term: 1, split: 'right', ratio: 0.5, a: { term: 2 }, b: { term: 3 } } }], active: 0 })).toBe(
      false,
    );
  });

  it('rejects terminal id 0 in a pane', () => {
    expect(accepts(oneTab({ term: 0 }))).toBe(false);
  });

  it('refuses to encode a layout with a duplicate terminal', () => {
    const layout = oneTab(split({ term: 5 }, { term: 5 }));
    expect(() => encodeMessage('clientToDaemon', { t: 'setLayout', req: 1, worktree: WT, layout })).toThrow(ProtocolError);
  });
});

describe('exported layout schema', () => {
  it('accepts what setLayout accepts and rejects what it rejects', () => {
    const valid = oneTab(split({ term: 1 }, { term: 2 }));
    const invalid = oneTab(split({ term: 5 }, { term: 5 }));
    expect(layoutSchema.safeParse(valid).success).toBe(true);
    expect(layoutSchema.safeParse(invalid).success).toBe(false);
  });

  it('enforces the pane limit like setLayout', () => {
    expect(layoutSchema.safeParse(oneTab(balanced(1, 8))).success).toBe(true);
    expect(layoutSchema.safeParse(oneTab(balanced(1, 9))).success).toBe(false);
  });
});
