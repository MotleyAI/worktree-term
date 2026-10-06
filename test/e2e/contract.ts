// What the page exposes to the e2e suite; the web implementation must honour every item here.

/** Read-only inspection hook set by `web.terminals` on `window.__wtdInspect`. */
export interface WtdInspect {
  /** The terminal's active buffer (scrollback and screen), rows `translateToString(true)` joined by '\n', trimEnd()'d; null without such a terminal object. */
  screen: (host: number, termId: number) => string | null;
}

declare global {
  interface Window {
    __wtdInspect?: WtdInspect;
  }
}

/** `data-testid` values of the page. */
export const TID = {
  /** Shown alone when the page has no usable credential; text names `wtd ui`. */
  authMessage: 'auth-message',
  /** Shown when the bundle still differs from the hub after one reload; text says outdated and names `wtd ui`. */
  outdatedUi: 'outdated-ui',
  /** Visible while the WebSocket is closed and the page reconnects. */
  reconnecting: 'reconnecting',
  /** One per repo, in hub order; text = label, `title` = full path, `aria-selected="true"` when selected. */
  repoTab: 'repo-tab',
  /** In the selected repo's area when its watch failed; text holds the error code and the path. */
  repoError: 'repo-error',
  /** Banner of an `outdated` host; text contains "outdated". */
  hostOutdated: 'host-outdated',
  /** Button in the outdated banner; asks `window.confirm` (message says terminals will be killed), then sends `restartDaemon`. */
  restartDaemon: 'restart-daemon',
  /** Sidebar entry; `title` = path, `aria-selected`, `data-prunable="true"`, `data-gone="true"`; holds a checkbox input unless gone. */
  worktree: 'worktree',
  /** The label inside a sidebar entry; clicking it selects the worktree. */
  worktreeLabel: 'worktree-label',
  /** Checkbox input: checked = show checked worktrees only. */
  filterChecked: 'filter-checked',
  /** Terminal tab; `data-term` = its first live terminal's id, `aria-selected`, text contains "exited" once that terminal exited. */
  termTab: 'term-tab',
  /** Close button inside a terminal tab; closes every terminal of the tab, confirming first when any is running. */
  termTabClose: 'term-tab-close',
  /** Tab-bar button: new tab through the preset picker; `title` names Ctrl+Shift+T; `disabled` when not possible. */
  newTab: 'new-tab',
  /** Tab-bar button: split the focused pane right; `title` names Ctrl+Shift+D; `disabled` when not possible. */
  splitRight: 'split-right',
  /** Tab-bar button: split the focused pane down; `title` names Ctrl+Shift+E; `disabled` when not possible. */
  splitDown: 'split-down',
  /** Pane frame of the shown tab, placed over its terminal; `data-term`, `data-focused="true"` on the focused pane. */
  pane: 'pane',
  /** Close button inside a pane; closes its terminal, confirming first when it is running. */
  paneClose: 'pane-close',
  /** Divider between the two sides of a split; `data-split` = right|down, `data-path` = path from the tab root, e.g. "", "b", "b.a". */
  divider: 'divider',
  /** The preset picker over the terminal area. */
  presetPicker: 'preset-picker',
  /** The preset list a worktree without terminals shows in its terminal area. */
  presetChoices: 'preset-choices',
  /** One preset in a picker or in the choices, in configured order; text = preset name; `aria-selected="true"` on the highlighted one. */
  presetOption: 'preset-option',
  /** Dialog confirming the close of running terminals. */
  closeDialog: 'close-dialog',
  /** One running terminal listed in the close dialog; text holds its preset and its id. */
  closeTarget: 'close-target',
  /** Confirms the close dialog. */
  closeConfirm: 'close-confirm',
  /** Cancels the close dialog. */
  closeCancel: 'close-cancel',
  /** Attention mark inside a pane, terminal tab, worktree entry or repo tab, absent without a mark; `data-mark` = input|failed|exited|done|output; `title` gives the number of terminals per mark, one line `<mark>: <count>` per mark present, in rank order. */
  mark: 'mark',
  /** Banner for problems reported on the page, such as a failed copy. */
  notice: 'notice',
  /** Terminal container, `data-host` and `data-term`; holds the `.xterm` element; hidden ones are not visible. */
  terminal: 'terminal',
} as const;

/** Mark names in rank order, as `data-mark` values. */
export const MARKS = ['input', 'failed', 'exited', 'done', 'output'] as const;

/** Performance mark at the start of the worktree-switch input handler (design D13). */
export const SWITCH_START = 'wtd:switch-start';
/** Performance mark just after the first frame painted with the switch applied (design D13). */
export const SWITCH_END = 'wtd:switch-end';

/** Performance mark at the start of a divider-drag pointer-move handler. */
export const DRAG_MOVE = 'wtd:drag-move';
/** Performance mark just after the first frame painted with that move's pane sizes. */
export const DRAG_PAINT = 'wtd:drag-paint';

export const byTestId = (id: string): string => `[data-testid="${id}"]`;

export const repoTab = (path: string): string => `${byTestId(TID.repoTab)}[title="${path}"]`;

export const worktreeEntry = (path: string): string => `${byTestId(TID.worktree)}[title="${path}"]`;

export const termTab = (termId: number): string => `${byTestId(TID.termTab)}[data-term="${String(termId)}"]`;

export const pane = (termId: number): string => `${byTestId(TID.pane)}[data-term="${String(termId)}"]`;

export const terminalBox = (host: number, termId: number): string =>
  `${byTestId(TID.terminal)}[data-host="${String(host)}"][data-term="${String(termId)}"]`;
