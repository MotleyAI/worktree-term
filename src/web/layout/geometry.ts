import { clampRatio, type Pane, type PanePath, type SplitDir } from './tree.js';

/** Width of the divider between a split's sides, in pixels. */
export const DIVIDER = 4;

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PaneRect {
  termId: number;
  rect: Rect;
}

/** A split's draggable divider, and the area the split divides. */
export interface Divider {
  path: PanePath;
  split: SplitDir;
  rect: Rect;
  area: Rect;
}

export type Direction = 'left' | 'right' | 'up' | 'down';

interface Sides {
  a: Rect;
  divider: Rect;
  b: Rect;
}

const sides = (dir: SplitDir, ratio: number, area: Rect): Sides => {
  if (dir === 'right') {
    const width = Math.round((area.width - DIVIDER) * ratio);
    return {
      a: { ...area, width },
      divider: { ...area, left: area.left + width, width: DIVIDER },
      b: { ...area, left: area.left + width + DIVIDER, width: area.width - DIVIDER - width },
    };
  }
  const height = Math.round((area.height - DIVIDER) * ratio);
  return {
    a: { ...area, height },
    divider: { ...area, top: area.top + height, height: DIVIDER },
    b: { ...area, top: area.top + height + DIVIDER, height: area.height - DIVIDER - height },
  };
};

/** Each terminal pane's rectangle within `area`, in tab order. */
export const paneRects = (root: Pane, area: Rect): PaneRect[] => {
  if ('term' in root) return [{ termId: root.term, rect: area }];
  const { a, b } = sides(root.split, root.ratio, area);
  return [...paneRects(root.a, a), ...paneRects(root.b, b)];
};

/** Each split's divider within `area`: a split before its sides, side a's before side b's. */
export const dividers = (root: Pane, area: Rect, path: PanePath = []): Divider[] => {
  if ('term' in root) return [];
  const { a, divider, b } = sides(root.split, root.ratio, area);
  return [{ path, split: root.split, rect: divider, area }, ...dividers(root.a, a, [...path, 'a']), ...dividers(root.b, b, [...path, 'b'])];
};

/** The ratio, kept from 0.05 to 0.95, that puts `divider`'s centre at `point`. */
export const ratioAt = (divider: Divider, point: { x: number; y: number }): number => {
  const { area } = divider;
  return divider.split === 'right'
    ? clampRatio((point.x - area.left - DIVIDER / 2) / (area.width - DIVIDER))
    : clampRatio((point.y - area.top - DIVIDER / 2) / (area.height - DIVIDER));
};

const right = (r: Rect): number => r.left + r.width;
const bottom = (r: Rect): number => r.top + r.height;
const overlap = (from: number, to: number, otherFrom: number, otherTo: number): number =>
  Math.max(0, Math.min(to, otherTo) - Math.max(from, otherFrom));

/** How far `c` lies beyond `f`'s edge in direction `dir`, or null when it does not lie wholly beyond it. */
const gap = (f: Rect, c: Rect, dir: Direction): number | null => {
  const distance = {
    left: f.left - right(c),
    right: c.left - right(f),
    up: f.top - bottom(c),
    down: c.top - bottom(f),
  }[dir];
  return distance >= 0 ? distance : null;
};

/**
 * The pane to focus from `termId` in direction `dir`: among panes wholly beyond its edge, the one
 * overlapping it most along the other axis, then the nearest, then the first in `rects`' order.
 */
export const neighbour = (rects: readonly PaneRect[], termId: number, dir: Direction): number | null => {
  const focused = rects.find((p) => p.termId === termId)?.rect;
  if (focused === undefined) return null;
  let best: { termId: number; overlap: number; gap: number } | null = null;
  for (const { termId: candidate, rect } of rects) {
    if (candidate === termId) continue;
    const distance = gap(focused, rect, dir);
    if (distance === null) continue;
    const shared =
      dir === 'left' || dir === 'right'
        ? overlap(focused.top, bottom(focused), rect.top, bottom(rect))
        : overlap(focused.left, right(focused), rect.left, right(rect));
    if (best === null || shared > best.overlap || (shared === best.overlap && distance < best.gap)) {
      best = { termId: candidate, overlap: shared, gap: distance };
    }
  }
  return best?.termId ?? null;
};
