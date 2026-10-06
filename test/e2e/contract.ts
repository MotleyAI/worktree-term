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
  /** Terminal tab; `data-term` = terminal id, `aria-selected`, text contains "exited" once exited. */
  termTab: 'term-tab',
  /** Close button inside a terminal tab; sends `closeTerm`. */
  termTabClose: 'term-tab-close',
  /** Creates a terminal in the selected worktree; absent for prunable and gone worktrees. */
  newTerminal: 'new-terminal',
  /** Terminal container, `data-host` and `data-term`; holds the `.xterm` element; hidden ones are not visible. */
  terminal: 'terminal',
} as const;

/** Performance mark at the start of the worktree-switch input handler (design D13). */
export const SWITCH_START = 'wtd:switch-start';
/** Performance mark just after the first frame painted with the switch applied (design D13). */
export const SWITCH_END = 'wtd:switch-end';

export const byTestId = (id: string): string => `[data-testid="${id}"]`;

export const repoTab = (path: string): string => `${byTestId(TID.repoTab)}[title="${path}"]`;

export const worktreeEntry = (path: string): string => `${byTestId(TID.worktree)}[title="${path}"]`;

export const termTab = (termId: number): string => `${byTestId(TID.termTab)}[data-term="${String(termId)}"]`;

export const terminalBox = (host: number, termId: number): string =>
  `${byTestId(TID.terminal)}[data-host="${String(host)}"][data-term="${String(termId)}"]`;
