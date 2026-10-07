import { describe, expect, it } from 'vitest';
import { keymap, type Action, type KeyLike } from './keymap.js';

type Modifiers = Partial<Pick<KeyLike, 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey' | 'repeat' | 'isComposing'>>;

const ALT: Modifiers = { altKey: true };
const ALT_SHIFT: Modifiers = { altKey: true, shiftKey: true };
const CTRL_SHIFT: Modifiers = { ctrlKey: true, shiftKey: true };

const press = (code: string, modifiers: Modifiers = {}, key = code.startsWith('Key') ? code.slice(3) : code): KeyLike => ({
  key,
  code,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  repeat: false,
  isComposing: false,
  ...modifiers,
});

const navigation: [string, Modifiers, string, Action][] = [
  ['Alt+Up', ALT, 'ArrowUp', { t: 'worktree', dir: -1 }],
  ['Alt+Down', ALT, 'ArrowDown', { t: 'worktree', dir: 1 }],
  ['Alt+Left', ALT, 'ArrowLeft', { t: 'tab', dir: -1 }],
  ['Alt+Right', ALT, 'ArrowRight', { t: 'tab', dir: 1 }],
  ['Alt+Shift+Left', ALT_SHIFT, 'ArrowLeft', { t: 'pane', dir: 'left' }],
  ['Alt+Shift+Right', ALT_SHIFT, 'ArrowRight', { t: 'pane', dir: 'right' }],
  ['Alt+Shift+Up', ALT_SHIFT, 'ArrowUp', { t: 'pane', dir: 'up' }],
  ['Alt+Shift+Down', ALT_SHIFT, 'ArrowDown', { t: 'pane', dir: 'down' }],
];

const others: [string, Modifiers, string, Action][] = [
  ['Ctrl+Shift+T', CTRL_SHIFT, 'KeyT', { t: 'newTab' }],
  ['Ctrl+Shift+D', CTRL_SHIFT, 'KeyD', { t: 'split', dir: 'right' }],
  ['Ctrl+Shift+E', CTRL_SHIFT, 'KeyE', { t: 'split', dir: 'down' }],
  ['Ctrl+Shift+W', CTRL_SHIFT, 'KeyW', { t: 'close' }],
  ['Ctrl+Shift+C', CTRL_SHIFT, 'KeyC', { t: 'copy' }],
  ['Ctrl+Shift+V', CTRL_SHIFT, 'KeyV', { t: 'paste' }],
];

describe('keymap', () => {
  it.each([...navigation, ...others])('maps %s', (_name, modifiers, code, action) => {
    expect(keymap(press(code, modifiers))).toEqual({ action, act: true });
  });

  it.each(navigation)('repeats %s while held', (_name, modifiers, code, action) => {
    expect(keymap(press(code, { ...modifiers, repeat: true }))).toEqual({ action, act: true });
  });

  it.each(others)('consumes a held %s without acting again', (_name, modifiers, code, action) => {
    expect(keymap(press(code, { ...modifiers, repeat: true }))).toEqual({ action, act: false });
  });

  it.each([...navigation, ...others])('ignores %s while composing', (_name, modifiers, code) => {
    expect(keymap(press(code, { ...modifiers, isComposing: true }))).toBeNull();
  });

  it.each<[string, Modifiers, string]>([
    ['Ctrl+Alt+T', { ctrlKey: true, altKey: true }, 'KeyT'],
    ['Ctrl+T', { ctrlKey: true }, 'KeyT'],
    ['Shift+T', { shiftKey: true }, 'KeyT'],
    ['Alt+T', ALT, 'KeyT'],
    ['Ctrl+Alt+Shift+T', { ...CTRL_SHIFT, altKey: true }, 'KeyT'],
    ['Ctrl+Shift+Meta+T', { ...CTRL_SHIFT, metaKey: true }, 'KeyT'],
    ['Ctrl+V', { ctrlKey: true }, 'KeyV'],
    ['Ctrl+C', { ctrlKey: true }, 'KeyC'],
    ['Ctrl+Shift+X', CTRL_SHIFT, 'KeyX'],
    ['Alt+Ctrl+Up', { altKey: true, ctrlKey: true }, 'ArrowUp'],
    ['Alt+Meta+Up', { altKey: true, metaKey: true }, 'ArrowUp'],
    ['Alt+Shift+Meta+Left', { ...ALT_SHIFT, metaKey: true }, 'ArrowLeft'],
    ['Alt+Shift+Ctrl+Left', { ...ALT_SHIFT, ctrlKey: true }, 'ArrowLeft'],
    ['Ctrl+Up', { ctrlKey: true }, 'ArrowUp'],
    ['Shift+Up', { shiftKey: true }, 'ArrowUp'],
    ['Ctrl+Shift+Left', CTRL_SHIFT, 'ArrowLeft'],
    ['Meta+Up', { metaKey: true }, 'ArrowUp'],
    ['Alt+Enter', ALT, 'Enter'],
  ])('ignores %s', (_name, modifiers, code) => {
    expect(keymap(press(code, modifiers))).toBeNull();
  });

  it.each(['ArrowUp', 'ArrowLeft', 'KeyT', 'KeyV', 'Enter', 'Escape'])('ignores plain %s', (code) => {
    expect(keymap(press(code))).toBeNull();
  });

  it('matches the physical key, not the character it produces', () => {
    expect(keymap(press('KeyT', CTRL_SHIFT, 'Е'))).toEqual({ action: { t: 'newTab' }, act: true });
    expect(keymap(press('KeyY', CTRL_SHIFT, 'T'))).toBeNull();
  });
});
