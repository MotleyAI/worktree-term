import type { Direction, SplitDir } from '../layout/index.js';

/** The parts of a keyboard event the keymap reads. */
export interface KeyLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  repeat: boolean;
  isComposing: boolean;
}

export type Action =
  | { t: 'worktree'; dir: -1 | 1 }
  | { t: 'tab'; dir: -1 | 1 }
  | { t: 'pane'; dir: Direction }
  | { t: 'newTab' }
  | { t: 'split'; dir: SplitDir }
  | { t: 'close' }
  | { t: 'copy' }
  | { t: 'paste' };

/** A shortcut: its action, and whether this key press acts (a held shortcut acts again only for navigation). */
export interface Shortcut {
  action: Action;
  act: boolean;
}

const ARROWS: Readonly<Record<string, Direction>> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };

const CTRL_SHIFT: Readonly<Record<string, Action>> = {
  KeyT: { t: 'newTab' },
  KeyD: { t: 'split', dir: 'right' },
  KeyE: { t: 'split', dir: 'down' },
  KeyW: { t: 'close' },
  KeyC: { t: 'copy' },
  KeyV: { t: 'paste' },
};

const altArrow = (dir: Direction): Action => {
  switch (dir) {
    case 'up':
      return { t: 'worktree', dir: -1 };
    case 'down':
      return { t: 'worktree', dir: 1 };
    case 'left':
      return { t: 'tab', dir: -1 };
    case 'right':
      return { t: 'tab', dir: 1 };
  }
};

const actionOf = (e: KeyLike): { action: Action; navigation: boolean } | null => {
  if (e.metaKey) return null;
  const arrow = ARROWS[e.code];
  if (arrow !== undefined && e.altKey && !e.ctrlKey) {
    return { action: e.shiftKey ? { t: 'pane', dir: arrow } : altArrow(arrow), navigation: true };
  }
  const action = CTRL_SHIFT[e.code];
  if (action !== undefined && e.ctrlKey && e.shiftKey && !e.altKey) return { action, navigation: false };
  return null;
};

/** The shortcut a key press is, by physical key; null for any other key or while composing. */
export const keymap = (e: KeyLike): Shortcut | null => {
  if (e.isComposing) return null;
  const found = actionOf(e);
  return found === null ? null : { action: found.action, act: found.navigation || !e.repeat };
};
