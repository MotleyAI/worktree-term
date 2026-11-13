import type { HostEntry, Layout, Preset } from '../../protocol/index.js';
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

/** What `key` does in a list of `count` presets whose highlighted one is `index`; a held key's repeats choose nothing. */
export const pickerKey = (key: string, index: number, count: number, repeat: boolean): PickerKey | null => {
  if (/^[1-9]$/.test(key)) {
    const chosen = Number(key) - 1;
    return chosen < count && !repeat ? { t: 'choose', index: chosen } : null;
  }
  switch (key) {
    case 'ArrowDown':
      return { t: 'move', index: Math.min(count - 1, index + 1) };
    case 'ArrowUp':
      return { t: 'move', index: Math.max(0, index - 1) };
    case 'Enter':
      return repeat ? null : { t: 'choose', index };
    case 'Escape':
      return { t: 'cancel' };
    default:
      return null;
  }
};

/** The focused element as far as the focus policy depends on it. */
export interface FocusedElement {
  /** Lower-case tag name. */
  tag: string;
  /** Lower-case `type` of an input, else empty. */
  type: string;
  /** Inside an editable (contenteditable) element. */
  editable: boolean;
  /** Owned by a terminal. */
  terminal: boolean;
  /** On a control whose menu is open, or inside an open menu. */
  menu: boolean;
}

export type FocusSpot = 'none' | 'terminal' | 'menu' | 'textField' | 'other';

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number']);

/** Where the keyboard focus is: nowhere (the page body), a terminal, an open menu, a text field, or any other element. */
export const focusSpot = (element: FocusedElement | null): FocusSpot => {
  if (element === null) return 'none';
  if (element.terminal) return 'terminal';
  if (element.menu) return 'menu';
  if (element.editable || element.tag === 'textarea') return 'textField';
  if (element.tag === 'input' && TEXT_INPUT_TYPES.has(element.type)) return 'textField';
  return element.tag === 'body' ? 'none' : 'other';
};

/** Why a worktree's preset choices consider taking the focus: just shown, or a picker or dialog over them just closed. */
export type ChoicesTrigger = 'shown' | 'modalClosed';

/** Whether a worktree's preset choices take the keyboard focus from `spot`. */
export const choicesTakeFocus = (trigger: ChoicesTrigger, spot: FocusSpot, modalOpen: boolean): boolean => {
  if (modalOpen) return false;
  return trigger === 'shown' ? spot !== 'textField' && spot !== 'menu' : spot === 'none';
};

const MAX_PRESET_NAME = 64;
const MAX_PRESET_COMMAND = 4096;

/** The preset the add form describes, trimmed, an empty command meaning the login shell; or why it cannot be added. */
export const presetFromForm = (name: string, command: string, presets: readonly Preset[]): { preset: Preset } | { error: string } => {
  const trimmedName = name.trim();
  const trimmedCommand = command.trim();
  if (trimmedName === '') return { error: 'Give the preset a name' };
  if (trimmedName.length > MAX_PRESET_NAME) return { error: `Names are at most ${String(MAX_PRESET_NAME)} characters` };
  if (presets.some((p) => p.name === trimmedName)) return { error: `A preset named ${trimmedName} exists` };
  if (trimmedCommand.length > MAX_PRESET_COMMAND) return { error: `Commands are at most ${String(MAX_PRESET_COMMAND)} characters` };
  return { preset: { name: trimmedName, command: trimmedCommand === '' ? null : trimmedCommand } };
};

/** The position a preset dragged from `from` takes when dropped into gap `slot` (0 = before the first preset). */
export const dropPosition = (from: number, slot: number): number => (slot > from ? slot - 1 : slot);
