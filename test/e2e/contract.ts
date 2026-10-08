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
  /** One per repo, in hub order; text starts with the label (`<host>:` prefixed for a remote host), `title` = full path, `aria-selected="true"` when selected. */
  repoTab: 'repo-tab',
  /** Inside the repo tab of a host that is not `connected`: text = the host's status; absent while connected. */
  hostStatus: 'host-status',
  /** Button inside each repo tab; opens the confirmation dialog, then sends `removeRepo` for that tab's host and repo. */
  removeRepo: 'remove-repo',
  /** In the selected repo's area when its watch failed; text holds the error code and the path. */
  repoError: 'repo-error',
  /** One per `down` or `outdated` host, none for other statuses; `data-host` = host index; text names the host, its status and its reason when present. */
  hostBanner: 'host-banner',
  /** Button inside a host banner: "Restart daemon" (outdated local), "Reinstall & restart" (outdated remote) or "Install" (down remote); opens the confirmation dialog, then sends `restartDaemon` or `reinstallDaemon`. */
  hostAction: 'host-action',
  /** In-page confirmation of a host action or a repo removal; nothing is sent before it is confirmed; text says every running terminal on the host will be killed when it lists none. */
  confirmDialog: 'confirm-dialog',
  /** One running terminal the page last saw on the daemon instance the host reports; text holds its worktree label and preset. */
  confirmTarget: 'confirm-target',
  /** Present when the dialog lists terminals; text says when the page last saw them. */
  confirmSeen: 'confirm-seen',
  /** Confirms the confirmation dialog. */
  confirmOk: 'confirm-ok',
  /** Cancels the confirmation dialog, sending nothing. */
  confirmCancel: 'confirm-cancel',
  /** Last control of the repo tab bar; opens the add-repo dialog. */
  addRepo: 'add-repo',
  /** The add-repo dialog; Escape closes it without sending anything. */
  addRepoDialog: 'add-repo-dialog',
  /** `<select>` in the add-repo dialog: one `<option>` per host, `value` = host index, text holds the host name and its status, `disabled` unless `connected`; preselects the selected tab's host. */
  addRepoHost: 'add-repo-host',
  /** A repo discovered on the selected host and not listed for it by the hub; `title` = its path; clicking it sends `addRepo`. */
  addRepoOption: 'add-repo-option',
  /** Text input narrowing the discovered repos to those whose path contains its value. */
  addRepoFilter: 'add-repo-filter',
  /** Text input for a typed absolute path; Enter sends `addRepo` for it. */
  addRepoPath: 'add-repo-path',
  /** In the add-repo dialog after a failed `addRepo`; text holds the error code. */
  addRepoError: 'add-repo-error',
  /** Sidebar entry; `data-path` = path, `title` = path then `<preset> <id>: <status>` per terminal (or "no terminals"), `aria-selected`, `data-prunable="true"`, `data-gone="true"`; holds a checkbox input unless gone; right-click opens the worktree menu. */
  worktree: 'worktree',
  /** The label inside a sidebar entry; clicking it selects the worktree. */
  worktreeLabel: 'worktree-label',
  /** Checkbox input: checked = show checked worktrees only, in the selected repo; each repo keeps its own, across reloads. */
  filterChecked: 'filter-checked',
  /** Context menu of a worktree entry; Escape or a press outside closes it. */
  worktreeMenu: 'worktree-menu',
  /** Menu item: deletes the worktree, at once when nothing would be lost, else after the confirmation; `disabled` for the main worktree, a locked or gone one, or an unconnected host. */
  deleteWorktree: 'delete-worktree',
  /** One reason in the confirmation of a worktree deletion. */
  confirmReason: 'confirm-reason',
  /** In the confirmation of a worktree deletion: whether its branch is kept, or that a detached worktree's commits are left only in the reflog. */
  confirmNote: 'confirm-note',
  /** Separator on the sidebar's right edge; dragging or ArrowLeft/ArrowRight resizes the sidebar; `aria-valuenow` = its width in px, kept across reloads. */
  sidebarResizer: 'sidebar-resizer',
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
  /** Close button in the header of a pane of a split (a lone pane has no header); closes its terminal, confirming first when it is running. */
  paneClose: 'pane-close',
  /** Divider between the two sides of a split; `data-split` = right|down, `data-path` = path from the tab root, e.g. "", "b", "b.a". */
  divider: 'divider',
  /** The preset picker over the terminal area. */
  presetPicker: 'preset-picker',
  /** The preset list a worktree without terminals shows in its terminal area. */
  presetChoices: 'preset-choices',
  /** One preset in a picker or in the choices, in configured order; text = preset name; `aria-selected="true"` on the highlighted one. */
  presetOption: 'preset-option',
  /** Button beside each preset while more than one exists; sends `removePreset` for it. */
  presetRemove: 'preset-remove',
  /** Row holding a preset option and its remove button; draggable while more than one preset exists, a drop sends `movePreset`. */
  presetRow: 'preset-row',
  /** Button under a preset list; opens the add-preset form. */
  presetAdd: 'preset-add',
  /** The add-preset form; Escape closes it without sending anything. */
  presetForm: 'preset-form',
  /** Name input of the add-preset form. */
  presetName: 'preset-name',
  /** Command input of the add-preset form; empty means the login shell. */
  presetCommand: 'preset-command',
  /** Submits the add-preset form; sends `addPreset` when the form is valid. */
  presetSubmit: 'preset-submit',
  /** In the add-preset form after a refused preset; text says why. */
  presetError: 'preset-error',
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
  /** Banner for problems reported on the page, such as a failed copy, a failed host action or a repo that cannot be removed. */
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

export const hostBanner = (host: number): string => `${byTestId(TID.hostBanner)}[data-host="${String(host)}"]`;

export const worktreeEntry = (path: string): string => `${byTestId(TID.worktree)}[data-path="${path}"]`;

export const termTab = (termId: number): string => `${byTestId(TID.termTab)}[data-term="${String(termId)}"]`;

export const pane = (termId: number): string => `${byTestId(TID.pane)}[data-term="${String(termId)}"]`;

export const terminalBox = (host: number, termId: number): string =>
  `${byTestId(TID.terminal)}[data-host="${String(host)}"][data-term="${String(termId)}"]`;
