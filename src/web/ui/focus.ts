import type { TerminalManager } from '../terminals/index.js';

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

/** The parts of a key event the claim rule reads. */
export interface ClaimKey {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  isComposing: boolean;
}

/** What makes the current terminal consider taking the keyboard focus. */
export type ClaimTrigger = { t: 'click' } | { t: 'windowFocus' } | { t: 'key'; key: ClaimKey };

/** The page's keyboard focus as the claim rule reads it from the DOM. */
export interface PageFocus {
  spot: FocusSpot;
  /** The focused element got the focus from a pointer interaction. */
  clicked: boolean;
  /** A menu is open somewhere on the page. */
  menuOpen: boolean;
  /** Text outside the terminals is selected. */
  pageSelection: boolean;
}

export interface FocusWorld extends PageFocus {
  /** A picker or dialog is open. */
  modal: boolean;
  /** A current terminal exists. */
  currentTerminal: boolean;
}

const composing = (key: ClaimKey): boolean => key.isComposing || key.key === 'Process' || key.key === 'Dead';

/** Whether `trigger` gives the keyboard focus (and, for a key, the key) to the current terminal. */
export const terminalTakesFocus = (trigger: ClaimTrigger, world: FocusWorld): boolean => {
  const nothingHolds = world.spot === 'none' || (world.spot === 'other' && world.clicked);
  if (!world.currentTerminal || world.modal || world.menuOpen || !nothingHolds) return false;
  if (trigger.t !== 'key') return !world.pageSelection;
  const { key } = trigger;
  return !composing(key) && !(world.pageSelection && (key.ctrlKey || key.metaKey));
};

/** Remembers whether the focused element got the focus during a pointer interaction. */
export class FocusOrigin<T> {
  private pointing = false;
  private interaction = 0;
  /** The focus moved since the latest interaction started. */
  private moved = false;
  private clickedElement: T | null = null;

  /** A pointer interaction starts; returns its id. */
  pointerDown(): number {
    this.pointing = true;
    this.moved = false;
    this.interaction += 1;
    return this.interaction;
  }

  /** A key is pressed: later focus changes are not the pointer's. */
  keyDown(): void {
    this.pointing = false;
  }

  /**
   * Interaction `id` (default: the latest), its click included, is over; `stayed` is the focused element it pressed,
   * which counts as clicked unless the focus moved since the press. An earlier interaction's id changes nothing.
   */
  pointerSettled(id = this.interaction, stayed: T | null = null): void {
    if (id !== this.interaction) return;
    if (stayed !== null && !this.moved) this.clickedElement = stayed;
    this.pointing = false;
  }

  /** `element` received the focus. */
  focused(element: T): void {
    this.moved = true;
    this.clickedElement = this.pointing ? element : null;
  }

  clicked(element: T | null): boolean {
    return element !== null && element === this.clickedElement;
  }
}

/** The document selection as far as `pageTextSelected` depends on it. */
export interface SelectionFacts {
  collapsed: boolean;
  anchorInTerminals: boolean;
  focusInTerminals: boolean;
  /** Both endpoints are still in the document. */
  connected: boolean;
}

/** Whether a selection covers text outside the terminals. */
export const pageTextSelected = (facts: SelectionFacts | null): boolean =>
  facts !== null && facts.connected && !facts.collapsed && !(facts.anchorInTerminals && facts.focusInTerminals);

type Owner = Pick<TerminalManager, 'owns'>;

/** Where the page's keyboard focus is. */
export const activeSpot = (manager: Owner): FocusSpot => {
  const active = document.activeElement;
  return focusSpot(
    active === null
      ? null
      : {
          tag: active.tagName.toLowerCase(),
          type: active instanceof HTMLInputElement ? active.type : '',
          editable: active instanceof HTMLElement && active.isContentEditable,
          terminal: manager.owns(active),
          menu: active.getAttribute('aria-expanded') === 'true' || active.closest('[role="menu"]') !== null,
        },
  );
};

const selectionFacts = (manager: Owner): SelectionFacts | null => {
  const selection = document.getSelection();
  if (selection === null || selection.rangeCount === 0) return null;
  const { anchorNode, focusNode } = selection;
  return {
    collapsed: selection.isCollapsed,
    anchorInTerminals: manager.owns(anchorNode),
    focusInTerminals: manager.owns(focusNode),
    connected: anchorNode?.isConnected === true && focusNode?.isConnected === true,
  };
};

/** The page's keyboard focus, read from the DOM. */
export const readPageFocus = (manager: Owner, origin: FocusOrigin<Element>): PageFocus => ({
  spot: activeSpot(manager),
  clicked: origin.clicked(document.activeElement),
  menuOpen: document.querySelector('[aria-expanded="true"], [role="menu"]') !== null,
  pageSelection: pageTextSelected(selectionFacts(manager)),
});

/** Feeds `origin` the page's pointer interactions and focus changes. */
export const trackFocusOrigin = (origin: FocusOrigin<Element>): void => {
  let pressed: { id: number; target: Node | null } = { id: 0, target: null };
  const settleLater = (): void => {
    const { id, target } = pressed;
    // After the click this interaction dispatches and the renders it causes.
    setTimeout(() => {
      // A click on the already focused control does not move the focus, but still makes it clicked.
      const active = document.activeElement;
      origin.pointerSettled(id, active !== null && target !== null && active.contains(target) ? active : null);
    });
  };
  window.addEventListener(
    'pointerdown',
    (event) => {
      pressed = { id: origin.pointerDown(), target: event.target instanceof Node ? event.target : null };
    },
    true,
  );
  for (const type of ['pointerup', 'pointercancel', 'contextmenu'] as const) window.addEventListener(type, settleLater, true);
  window.addEventListener(
    'keydown',
    () => {
      origin.keyDown();
    },
    true,
  );
  window.addEventListener('blur', () => {
    origin.pointerSettled();
  });
  document.addEventListener(
    'focusin',
    (event) => {
      if (event.target instanceof Element) origin.focused(event.target);
    },
    true,
  );
};
