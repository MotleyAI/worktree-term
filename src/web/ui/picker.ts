import type { HostEntry, Layout } from '../../protocol/index.js';
import { canAddTab, canSplit, type SplitDir } from '../layout/index.js';

export type PickerOp = { t: 'newTab' } | { t: 'split'; dir: SplitDir; target: number };

/** What a picker was opened for. */
export interface PickerContext {
  host: number;
  repo: string;
  worktree: string;
  op: PickerOp;
}

/** The page's current state as far as a picker depends on it. */
export interface PickerWorld {
  host: number | null;
  repo: string | null;
  worktree: string | null;
  hostStatus: HostEntry['status'] | null;
  /** Live terminals of the worktree. */
  live: readonly number[];
  layout: Layout | null;
}

/** Whether the operation `context` names is still possible for the same selection. */
export const pickerValid = (context: PickerContext, world: PickerWorld): boolean => {
  if (context.host !== world.host || context.repo !== world.repo || context.worktree !== world.worktree) return false;
  if (world.hostStatus !== 'connected') return false;
  const { op } = context;
  if (op.t === 'newTab') return canAddTab(world.layout);
  return world.live.includes(op.target) && canSplit(world.layout, op.target);
};

export type PickerKey = { t: 'choose'; index: number } | { t: 'move'; index: number } | { t: 'cancel' };

/** What `key` does in a list of `count` presets whose highlighted one is `index`. */
export const pickerKey = (key: string, index: number, count: number): PickerKey | null => {
  if (/^[1-9]$/.test(key)) {
    const chosen = Number(key) - 1;
    return chosen < count ? { t: 'choose', index: chosen } : null;
  }
  switch (key) {
    case 'ArrowDown':
      return { t: 'move', index: Math.min(count - 1, index + 1) };
    case 'ArrowUp':
      return { t: 'move', index: Math.max(0, index - 1) };
    case 'Enter':
      return { t: 'choose', index };
    case 'Escape':
      return { t: 'cancel' };
    default:
      return null;
  }
};
