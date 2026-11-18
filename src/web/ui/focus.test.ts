import { describe, expect, it } from 'vitest';
import {
  choicesTakeFocus,
  FocusOrigin,
  focusSpot,
  pageTextSelected,
  terminalTakesFocus,
  type ChoicesTrigger,
  type ClaimKey,
  type ClaimTrigger,
  type FocusedElement,
  type FocusSpot,
  type FocusWorld,
  type SelectionFacts,
} from './focus.js';

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

describe('terminalTakesFocus', () => {
  const key = (fields: Partial<ClaimKey> = {}): ClaimKey => ({ key: 'x', ctrlKey: false, metaKey: false, isComposing: false, ...fields });

  const CLICK: ClaimTrigger = { t: 'click' };
  const WINDOW: ClaimTrigger = { t: 'windowFocus' };
  const KEY: ClaimTrigger = { t: 'key', key: key() };
  const TRIGGERS: [string, ClaimTrigger][] = [
    ['click', CLICK],
    ['windowFocus', WINDOW],
    ['key', KEY],
  ];

  /** Nothing holds the keyboard, a current terminal exists, no page text is selected. */
  const world = (fields: Partial<FocusWorld> = {}): FocusWorld => ({
    spot: 'none',
    clicked: false,
    modal: false,
    menuOpen: false,
    currentTerminal: true,
    pageSelection: false,
    ...fields,
  });

  it.each(TRIGGERS)('claims from the page body (%s)', (_name, trigger) => {
    expect(terminalTakesFocus(trigger, world())).toBe(true);
  });

  it.each(TRIGGERS)('claims from a control the user clicked (%s)', (_name, trigger) => {
    expect(terminalTakesFocus(trigger, world({ spot: 'other', clicked: true }))).toBe(true);
  });

  it.each(TRIGGERS)('leaves a control focused from the keyboard or by the page (%s)', (_name, trigger) => {
    expect(terminalTakesFocus(trigger, world({ spot: 'other', clicked: false }))).toBe(false);
  });

  it.each(TRIGGERS)('does nothing while a terminal holds the focus (%s)', (_name, trigger) => {
    expect(terminalTakesFocus(trigger, world({ spot: 'terminal' }))).toBe(false);
    expect(terminalTakesFocus(trigger, world({ spot: 'terminal', clicked: true }))).toBe(false);
  });

  it.each(TRIGGERS)('leaves a text field, even a clicked one (%s)', (_name, trigger) => {
    expect(terminalTakesFocus(trigger, world({ spot: 'textField' }))).toBe(false);
    expect(terminalTakesFocus(trigger, world({ spot: 'textField', clicked: true }))).toBe(false);
  });

  it.each(TRIGGERS)('leaves an open menu holding the focus, even a clicked one (%s)', (_name, trigger) => {
    expect(terminalTakesFocus(trigger, world({ spot: 'menu' }))).toBe(false);
    expect(terminalTakesFocus(trigger, world({ spot: 'menu', clicked: true }))).toBe(false);
  });

  it.each(TRIGGERS)('does nothing while any menu is open on the page, focused or not (%s)', (_name, trigger) => {
    expect(terminalTakesFocus(trigger, world({ menuOpen: true }))).toBe(false);
    expect(terminalTakesFocus(trigger, world({ spot: 'other', clicked: true, menuOpen: true }))).toBe(false);
  });

  it.each(TRIGGERS)('does nothing while a picker or dialog is open (%s)', (_name, trigger) => {
    expect(terminalTakesFocus(trigger, world({ modal: true }))).toBe(false);
    expect(terminalTakesFocus(trigger, world({ spot: 'other', clicked: true, modal: true }))).toBe(false);
  });

  it.each(TRIGGERS)('does nothing without a current terminal (%s)', (_name, trigger) => {
    expect(terminalTakesFocus(trigger, world({ currentTerminal: false }))).toBe(false);
    expect(terminalTakesFocus(trigger, world({ spot: 'other', clicked: true, currentTerminal: false }))).toBe(false);
  });

  it.each(TRIGGERS)('never takes the focus from the preset choices of a worktree without terminals (%s)', (_name, trigger) => {
    // The choices exist only without a current terminal; a clicked or keyboard-focused option keeps the focus.
    for (const clicked of [false, true]) {
      expect(terminalTakesFocus(trigger, world({ spot: 'other', clicked, currentTerminal: false }))).toBe(false);
    }
  });

  describe('with text outside the terminals selected', () => {
    const selected = world({ pageSelection: true });

    it('keeps the selection on a click or window refocus', () => {
      expect(terminalTakesFocus(CLICK, selected)).toBe(false);
      expect(terminalTakesFocus(WINDOW, selected)).toBe(false);
      expect(terminalTakesFocus(CLICK, world({ pageSelection: true, spot: 'other', clicked: true }))).toBe(false);
    });

    it.each<[string, Partial<ClaimKey>]>([
      ['Ctrl+C', { key: 'c', ctrlKey: true }],
      ['Meta+C', { key: 'c', metaKey: true }],
      ['Ctrl alone', { key: 'Control', ctrlKey: true }],
      ['Meta alone', { key: 'Meta', metaKey: true }],
      ['Ctrl+Shift+X', { key: 'X', ctrlKey: true }],
    ])('keeps %s with the page', (_name, fields) => {
      expect(terminalTakesFocus({ t: 'key', key: key(fields) }, selected)).toBe(false);
    });

    it.each(['x', 'A', 'Enter', 'ArrowUp', 'Backspace', 'Shift', 'Alt'])('gives %j to the terminal', (name) => {
      expect(terminalTakesFocus({ t: 'key', key: key({ key: name }) }, selected)).toBe(true);
    });
  });

  it.each<[string, Partial<ClaimKey>]>([
    ['a lower-case letter', { key: 'a' }],
    ['an upper-case letter', { key: 'A' }],
    ['Enter', { key: 'Enter' }],
    ['an arrow', { key: 'ArrowUp' }],
    ['Backspace', { key: 'Backspace' }],
    ['Escape', { key: 'Escape' }],
    ['Tab', { key: 'Tab' }],
    ['Space', { key: ' ' }],
    ['Ctrl+C', { key: 'c', ctrlKey: true }],
    ['Meta+K', { key: 'k', metaKey: true }],
  ])('gives %s to the terminal without a page selection', (_name, fields) => {
    expect(terminalTakesFocus({ t: 'key', key: key(fields) }, world())).toBe(true);
    expect(terminalTakesFocus({ t: 'key', key: key(fields) }, world({ spot: 'other', clicked: true }))).toBe(true);
  });

  it.each<[string, Partial<ClaimKey>]>([
    ['a key being composed', { key: 'a', isComposing: true }],
    ['a Process key', { key: 'Process' }],
    ['a dead key', { key: 'Dead' }],
  ])('never claims for %s', (_name, fields) => {
    expect(terminalTakesFocus({ t: 'key', key: key(fields) }, world())).toBe(false);
    expect(terminalTakesFocus({ t: 'key', key: key(fields) }, world({ spot: 'other', clicked: true }))).toBe(false);
  });

  it('follows the rule over every combination', () => {
    const spots: readonly FocusSpot[] = ['none', 'terminal', 'menu', 'textField', 'other'];
    const bools = [false, true] as const;
    const keys: ClaimKey[] = [
      key(),
      key({ key: 'c', ctrlKey: true }),
      key({ key: 'c', metaKey: true }),
      key({ isComposing: true }),
      key({ key: 'Process' }),
      key({ key: 'Dead' }),
    ];
    const triggers: ClaimTrigger[] = [CLICK, WINDOW, ...keys.map((k): ClaimTrigger => ({ t: 'key', key: k }))];
    for (const trigger of triggers) {
      for (const spot of spots) {
        for (const clicked of bools) {
          for (const modal of bools) {
            for (const menuOpen of bools) {
              for (const currentTerminal of bools) {
                for (const pageSelection of bools) {
                  const w: FocusWorld = { spot, clicked, modal, menuOpen, currentTerminal, pageSelection };
                  const nothingHolds = !modal && !menuOpen && (spot === 'none' || (spot === 'other' && clicked));
                  let expected = nothingHolds && currentTerminal;
                  if (trigger.t === 'key') {
                    const k = trigger.key;
                    const composing = k.isComposing || k.key === 'Process' || k.key === 'Dead';
                    expected &&= !composing && !(pageSelection && (k.ctrlKey || k.metaKey));
                  } else expected &&= !pageSelection;
                  expect(terminalTakesFocus(trigger, w), JSON.stringify({ trigger, w })).toBe(expected);
                }
              }
            }
          }
        }
      }
    }
  });
});

describe('FocusOrigin', () => {
  const a = { id: 'a' };
  const b = { id: 'b' };

  it('marks the element focused during a pointer interaction as clicked', () => {
    const origin = new FocusOrigin<object>();
    origin.pointerDown();
    origin.focused(a);
    expect(origin.clicked(a)).toBe(true);
    origin.pointerSettled();
    expect(origin.clicked(a)).toBe(true);
  });

  it('marks the last element focused during the interaction, as when a click handler moves the focus', () => {
    const origin = new FocusOrigin<object>();
    origin.pointerDown();
    origin.focused(a);
    origin.focused(b);
    origin.pointerSettled();
    expect(origin.clicked(b)).toBe(true);
    expect(origin.clicked(a)).toBe(false);
  });

  it('does not mark an element focused from the keyboard or by a script', () => {
    const origin = new FocusOrigin<object>();
    origin.focused(a);
    expect(origin.clicked(a)).toBe(false);
  });

  it('does not mark an element focused after the interaction settled', () => {
    const origin = new FocusOrigin<object>();
    origin.pointerDown();
    origin.pointerSettled();
    origin.focused(a);
    expect(origin.clicked(a)).toBe(false);
  });

  it('forgets a click once a later focus from the keyboard or a script lands, even on the clicked element', () => {
    const origin = new FocusOrigin<object>();
    origin.pointerDown();
    origin.focused(a);
    origin.pointerSettled();
    origin.focused(b);
    expect(origin.clicked(b)).toBe(false);
    expect(origin.clicked(a)).toBe(false);
    origin.focused(a);
    expect(origin.clicked(a)).toBe(false);
  });

  it('keeps a click until the focus moves', () => {
    const origin = new FocusOrigin<object>();
    origin.pointerDown();
    origin.focused(a);
    origin.pointerSettled();
    origin.pointerDown();
    origin.pointerSettled();
    expect(origin.clicked(a)).toBe(true);
  });

  it('marks again on a later pointer interaction', () => {
    const origin = new FocusOrigin<object>();
    origin.focused(a);
    origin.pointerDown();
    origin.focused(b);
    origin.pointerSettled();
    expect(origin.clicked(b)).toBe(true);
  });

  it('does not mark an element a key focuses during a pointer interaction', () => {
    const origin = new FocusOrigin<object>();
    origin.pointerDown();
    origin.focused(a);
    origin.keyDown();
    origin.focused(b);
    origin.pointerSettled();
    expect(origin.clicked(b)).toBe(false);
  });

  it('marks the focused element an interaction settles on without moving the focus, even after a key', () => {
    const origin = new FocusOrigin<object>();
    origin.focused(a);
    const id = origin.pointerDown();
    origin.keyDown();
    origin.pointerSettled(id, a);
    expect(origin.clicked(a)).toBe(true);
  });

  it('keeps a focus the page moved after the press when the interaction settles late', () => {
    const origin = new FocusOrigin<object>();
    const id = origin.pointerDown();
    origin.focused(a);
    origin.keyDown();
    origin.focused(a);
    origin.pointerSettled(id, a);
    expect(origin.clicked(a)).toBe(false);
  });

  it('ignores the settling of an earlier interaction once a later one started', () => {
    const origin = new FocusOrigin<object>();
    const first = origin.pointerDown();
    origin.pointerDown();
    origin.pointerSettled(first, a);
    expect(origin.clicked(a)).toBe(false);
    origin.focused(b);
    expect(origin.clicked(b)).toBe(true);
  });

  it('reports nothing focused as not clicked', () => {
    const origin = new FocusOrigin<object>();
    origin.pointerDown();
    origin.focused(a);
    expect(origin.clicked(null)).toBe(false);
  });
});

describe('pageTextSelected', () => {
  const facts = (fields: Partial<SelectionFacts> = {}): SelectionFacts => ({
    collapsed: false,
    anchorInTerminals: false,
    focusInTerminals: false,
    connected: true,
    ...fields,
  });

  it('is false without a selection or with a collapsed one', () => {
    expect(pageTextSelected(null)).toBe(false);
    expect(pageTextSelected(facts({ collapsed: true }))).toBe(false);
    expect(pageTextSelected(facts({ collapsed: true, anchorInTerminals: true, focusInTerminals: true }))).toBe(false);
  });

  it('is false for a selection wholly inside the terminals', () => {
    expect(pageTextSelected(facts({ anchorInTerminals: true, focusInTerminals: true }))).toBe(false);
  });

  it('is true for a selection of page text', () => {
    expect(pageTextSelected(facts())).toBe(true);
  });

  it('is true for a selection reaching from the page into the terminals, either way', () => {
    expect(pageTextSelected(facts({ anchorInTerminals: true }))).toBe(true);
    expect(pageTextSelected(facts({ focusInTerminals: true }))).toBe(true);
  });

  it('ignores a selection with an endpoint no longer in the document', () => {
    expect(pageTextSelected(facts({ connected: false }))).toBe(false);
    expect(pageTextSelected(facts({ connected: false, anchorInTerminals: true }))).toBe(false);
  });
});
