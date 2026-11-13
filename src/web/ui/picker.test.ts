import { describe, expect, it } from 'vitest';
import type { Layout } from '../../protocol/index.js';
import {
  choicesTakeFocus,
  dropPosition,
  focusSpot,
  pickerKey,
  pickerValid,
  presetFromForm,
  type ChoicesTrigger,
  type FocusedElement,
  type FocusSpot,
  type PickerContext,
  type PickerWorld,
} from './picker.js';

type Pane = Layout['tabs'][number]['root'];

const REPO = '/r/app';
const WT = '/r/app.worktrees/feat';

const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);

/** A chain of right splits over `terms`. */
const chain = (terms: readonly number[]): Pane => {
  const [first = 0, ...rest] = terms;
  return rest.length === 0 ? { term: first } : { split: 'right', ratio: 0.5, a: { term: first }, b: chain(rest) };
};

const tabs = (roots: readonly Pane[]): Layout => ({ tabs: roots.map((root, i) => ({ id: `t${String(i)}`, root })), active: 0 });

const newTab: PickerContext = { host: 0, repo: REPO, worktree: WT, op: { t: 'newTab' } };
const splitRight: PickerContext = { host: 0, repo: REPO, worktree: WT, op: { t: 'split', dir: 'right', target: 1 } };

const world = (fields: Partial<PickerWorld> = {}): PickerWorld => ({
  host: 0,
  repo: REPO,
  worktree: WT,
  hostStatus: 'connected',
  live: [1, 2],
  layout: tabs([chain([1, 2])]),
  ...fields,
});

describe('pickerValid', () => {
  it('holds while the selection, host and operation stay as they were', () => {
    expect(pickerValid(newTab, world())).toBe(true);
    expect(pickerValid(splitRight, world())).toBe(true);
    expect(pickerValid({ ...splitRight, op: { t: 'split', dir: 'down', target: 2 } }, world())).toBe(true);
  });

  it.each<[string, Partial<PickerWorld>]>([
    ['another worktree is selected', { worktree: `${REPO}.worktrees/other` }],
    ['no worktree is selected', { worktree: null }],
    ['another repo is selected', { repo: '/r/lib' }],
    ['no repo is selected', { repo: null }],
    ['another host is selected', { host: 1 }],
    ['no host is selected', { host: null }],
    ['the host is reconnecting', { hostStatus: 'reconnecting' }],
    ['the host is down', { hostStatus: 'down' }],
    ['the host is unknown', { hostStatus: null }],
  ])('ends when %s', (_name, fields) => {
    expect(pickerValid(newTab, world(fields))).toBe(false);
    expect(pickerValid(splitRight, world(fields))).toBe(false);
  });

  it('ends a split when its target is no longer live', () => {
    expect(pickerValid(splitRight, world({ live: [2], layout: tabs([{ term: 2 }]) }))).toBe(false);
    expect(pickerValid(newTab, world({ live: [2], layout: tabs([{ term: 2 }]) }))).toBe(true);
  });

  it('ends a split once the target’s tab holds 8 panes', () => {
    expect(pickerValid(splitRight, world({ live: range(1, 7), layout: tabs([chain(range(1, 7))]) }))).toBe(true);
    const full = world({ live: range(1, 8), layout: tabs([chain(range(1, 8))]) });
    expect(pickerValid(splitRight, full)).toBe(false);
    expect(pickerValid(newTab, full)).toBe(true);
  });

  it('ends a new tab once the layout holds 64 tabs', () => {
    expect(pickerValid(newTab, world({ live: range(1, 63), layout: tabs(range(1, 63).map((term) => ({ term }))) }))).toBe(true);
    const full = world({ live: range(1, 64), layout: tabs(range(1, 64).map((term) => ({ term }))) });
    expect(pickerValid(newTab, full)).toBe(false);
    expect(pickerValid(splitRight, full)).toBe(true);
  });

  it('allows splitting a live terminal missing from the layout only while a tab can be added', () => {
    const missing: PickerContext = { ...splitRight, op: { t: 'split', dir: 'down', target: 100 } };
    expect(pickerValid(missing, world({ live: [...range(1, 63), 100], layout: tabs(range(1, 63).map((term) => ({ term }))) }))).toBe(true);
    expect(pickerValid(missing, world({ live: [...range(1, 64), 100], layout: tabs(range(1, 64).map((term) => ({ term }))) }))).toBe(false);
    expect(pickerValid(missing, world({ live: [100], layout: null }))).toBe(true);
  });
});

describe('pickerKey', () => {
  it('chooses the preset at a digit’s position', () => {
    expect(pickerKey('1', 0, 3, false)).toEqual({ t: 'choose', index: 0 });
    expect(pickerKey('3', 0, 3, false)).toEqual({ t: 'choose', index: 2 });
    expect(pickerKey('9', 4, 9, false)).toEqual({ t: 'choose', index: 8 });
  });

  it('ignores a digit beyond the list and zero', () => {
    expect(pickerKey('4', 0, 3, false)).toBeNull();
    expect(pickerKey('9', 0, 8, false)).toBeNull();
    expect(pickerKey('0', 0, 3, false)).toBeNull();
  });

  it('moves with the arrow keys within the list', () => {
    expect(pickerKey('ArrowDown', 0, 3, false)).toEqual({ t: 'move', index: 1 });
    expect(pickerKey('ArrowDown', 2, 3, false)).toEqual({ t: 'move', index: 2 });
    expect(pickerKey('ArrowUp', 2, 3, false)).toEqual({ t: 'move', index: 1 });
    expect(pickerKey('ArrowUp', 0, 3, false)).toEqual({ t: 'move', index: 0 });
  });

  it('chooses the current preset with Enter and cancels with Escape', () => {
    expect(pickerKey('Enter', 1, 3, false)).toEqual({ t: 'choose', index: 1 });
    expect(pickerKey('Escape', 1, 3, false)).toEqual({ t: 'cancel' });
  });

  it.each(['a', 'Tab', ' ', 'ArrowLeft', 'ArrowRight', 'Shift'])('ignores %j', (key) => {
    expect(pickerKey(key, 0, 3, false)).toBeNull();
  });

  it.each(['1', '2', '3', 'Enter'])('chooses nothing on a repeated %j', (key) => {
    expect(pickerKey(key, 1, 3, true)).toBeNull();
  });

  it('keeps moving on repeated arrow keys', () => {
    expect(pickerKey('ArrowDown', 0, 3, true)).toEqual({ t: 'move', index: 1 });
    expect(pickerKey('ArrowDown', 2, 3, true)).toEqual({ t: 'move', index: 2 });
    expect(pickerKey('ArrowUp', 2, 3, true)).toEqual({ t: 'move', index: 1 });
    expect(pickerKey('ArrowUp', 0, 3, true)).toEqual({ t: 'move', index: 0 });
  });
});

describe('focusSpot', () => {
  const element = (fields: Partial<FocusedElement> = {}): FocusedElement => ({
    tag: 'div',
    type: '',
    editable: false,
    terminal: false,
    menu: false,
    ...fields,
  });

  it('is none without a focused element or on the page body', () => {
    expect(focusSpot(null)).toBe('none');
    expect(focusSpot(element({ tag: 'body' }))).toBe('none');
  });

  it.each(['text', 'search', 'email', 'url', 'tel', 'password', 'number'])('is a text field for an input of type %j', (type) => {
    expect(focusSpot(element({ tag: 'input', type }))).toBe('textField');
  });

  it('is a text field for a textarea and inside an editable element', () => {
    expect(focusSpot(element({ tag: 'textarea' }))).toBe('textField');
    expect(focusSpot(element({ tag: 'div', editable: true }))).toBe('textField');
    expect(focusSpot(element({ tag: 'span', editable: true }))).toBe('textField');
  });

  it.each(['checkbox', 'radio', 'button', 'submit', 'range', 'color', 'file'])('is other for an input of type %j', (type) => {
    expect(focusSpot(element({ tag: 'input', type }))).toBe('other');
  });

  it('is other for buttons, options and plain elements', () => {
    expect(focusSpot(element({ tag: 'button' }))).toBe('other');
    expect(focusSpot(element({ tag: 'div' }))).toBe('other');
    expect(focusSpot(element({ tag: 'dialog' }))).toBe('other');
  });

  it('is a menu on a control whose menu is open or inside an open menu, even a text field', () => {
    expect(focusSpot(element({ tag: 'button', menu: true }))).toBe('menu');
    expect(focusSpot(element({ tag: 'input', type: 'text', menu: true }))).toBe('menu');
  });

  it('is a terminal for an element the terminal manager owns, even a textarea', () => {
    expect(focusSpot(element({ tag: 'textarea', terminal: true }))).toBe('terminal');
    expect(focusSpot(element({ tag: 'div', terminal: true }))).toBe('terminal');
    expect(focusSpot(element({ tag: 'div', editable: true, terminal: true }))).toBe('terminal');
    expect(focusSpot(element({ tag: 'div', terminal: true, menu: true }))).toBe('terminal');
  });
});

describe('choicesTakeFocus', () => {
  const spots: readonly FocusSpot[] = ['none', 'terminal', 'other', 'textField', 'menu'];

  it.each<[FocusSpot, boolean]>([
    ['none', true],
    ['terminal', true],
    ['other', true],
    ['textField', false],
    ['menu', false],
  ])('when shown, takes the focus from %s: %s', (spot, takes) => {
    expect(choicesTakeFocus('shown', spot, false)).toBe(takes);
  });

  it.each<[FocusSpot, boolean]>([
    ['none', true],
    ['terminal', false],
    ['other', false],
    ['textField', false],
    ['menu', false],
  ])('after a picker or dialog closed, takes the focus from %s: %s', (spot, takes) => {
    expect(choicesTakeFocus('modalClosed', spot, false)).toBe(takes);
  });

  it.each<ChoicesTrigger>(['shown', 'modalClosed'])('never takes the focus while a picker or dialog is open (%s)', (trigger) => {
    for (const spot of spots) expect(choicesTakeFocus(trigger, spot, true)).toBe(false);
  });
});

describe('presetFromForm', () => {
  const presets = [
    { name: 'shell', command: null },
    { name: 'claude', command: 'claude' },
  ];

  it('trims the name and the command', () => {
    expect(presetFromForm('  htop ', ' htop -d 5 ', presets)).toEqual({ preset: { name: 'htop', command: 'htop -d 5' } });
  });

  it('makes an empty or blank command the login shell', () => {
    expect(presetFromForm('zsh', '', presets)).toEqual({ preset: { name: 'zsh', command: null } });
    expect(presetFromForm('zsh', '   ', presets)).toEqual({ preset: { name: 'zsh', command: null } });
  });

  it.each([
    ['an empty name', '', 'x', 'Give the preset a name'],
    ['a blank name', '  \t', 'x', 'Give the preset a name'],
    ['a taken name', ' claude ', 'x', 'A preset named claude exists'],
    ['a 65-character name', 'n'.repeat(65), 'x', 'Names are at most 64 characters'],
    ['a 4097-character command', 'n', 'c'.repeat(4097), 'Commands are at most 4096 characters'],
  ])('refuses %s', (_case, name, command, error) => {
    expect(presetFromForm(name, command, presets)).toEqual({ error });
  });

  it('accepts a name differing from a taken one by case', () => {
    expect(presetFromForm('Claude', 'claude', presets)).toEqual({ preset: { name: 'Claude', command: 'claude' } });
  });
});

describe('dropPosition', () => {
  it.each([
    ['before the first preset', 2, 0, 0],
    ['into its own gap above', 2, 2, 2],
    ['into its own gap below', 2, 3, 2],
    ['after the last of four', 0, 4, 3],
    ['between two later presets', 0, 2, 1],
    ['between two earlier presets', 3, 1, 1],
  ])('places a preset dropped %s', (_case, from, slot, position) => {
    expect(dropPosition(from, slot)).toBe(position);
  });
});
