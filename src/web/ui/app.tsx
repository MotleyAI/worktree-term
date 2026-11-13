import type { JSX, TargetedKeyboardEvent } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { HostEntry, Preset, Terminal } from '../../protocol/index.js';
import { repoKey, RequestError, type HubClient } from '../client/index.js';
import { termsOf, type Divider } from '../layout/index.js';
import { followArea, type TerminalManager } from '../terminals/index.js';
import { hasBanner, hostAction, statusText } from './hosts.js';
import { hubLineText, hubsMenu, hubStep, initialHubState, type HubAction, type HubLine, type HubTarget } from './hubs.js';
import { EDITOR_HINT, EDITOR_TITLE, editorBlocker, editorFailure, editorSave, type EditorFailure } from './editor.js';
import { aggregate, exitNote, markTitle, ringTitle, worktreeTitle, type Aggregate } from './marks.js';
import { choicesTakeFocus, dropPosition, focusSpot, pickerKey, presetFromForm, type FocusSpot } from './picker.js';
import { SIDEBAR_WIDTH, type SidebarEntry } from './sidebar.js';
import type { RepoTab } from './repo-tabs.js';
import {
  hasPaneHeaders,
  MAX_TAB_NAME,
  PANE_HEADER,
  tabLabel,
  type AddRepoDialog,
  type CloseRequest,
  type Confirmation,
  type ShownPane,
  type ShownTab,
  type View,
  type WorktreeMenu,
} from './view.js';

export interface AppProps {
  client: HubClient;
  manager: TerminalManager;
  view: View;
}

const report =
  (what: string) =>
  (error: unknown): void => {
    console.warn(`${what} failed`, error);
  };

const px = (n: number): string => `${String(n)}px`;

/** ` (<exit note>)` for an exited terminal, else nothing. */
const exitSuffix = (terminal: Terminal | null | undefined): string => {
  const note = terminal == null ? null : exitNote(terminal);
  return note === null ? '' : ` (${note})`;
};

const AuthMessage = () => (
  <div class="message" data-testid="auth-message">
    Open worktree-term with <code>wtd ui</code>.
  </div>
);

const OutdatedUi = () => (
  <div class="message" data-testid="outdated-ui">
    This page is outdated. Run <code>wtd ui</code> to open the current version.
  </div>
);

/** The banner of a `needs-login` host, with its login link. */
const LoginBanner = ({ host, login }: { host: HostEntry; login: string }) => (
  <div class="banner host-banner" data-testid="host-banner" data-host={String(host.idx)}>
    {host.name}: needs Tailscale login{' '}
    <a class="button" data-testid="host-login" href={login} target="_blank" rel="noopener noreferrer">
      Open login link
    </a>
  </div>
);

/** The banner of a `down`, `outdated` or `needs-login` host, with its action or login link. */
const HostBanner = ({ host, view }: { host: HostEntry; view: View }) => {
  if (host.status === 'needs-login' && host.login !== null) return <LoginBanner host={host} login={host.login} />;
  const action = hostAction(host);
  const what = host.status === 'outdated' ? `outdated daemon ${host.daemonVersion ?? '(unknown version)'}` : 'down';
  return (
    <div class="banner host-banner" data-testid="host-banner" data-host={String(host.idx)}>
      {host.name}: {what}
      {host.reason === null ? '' : ` (${host.reason})`}{' '}
      {action !== null && (
        <button
          type="button"
          data-testid="host-action"
          onClick={() => {
            view.requestHostAction(host);
          }}
        >
          {action.label}
        </button>
      )}
    </div>
  );
};

/** The status line of the latest hub opening, with its login link, reinstall button or ×. */
const HubStatus = ({ line, install, dismiss }: { line: HubLine; install: () => void; dismiss: () => void }) => (
  <span class="hub-status" data-testid="hub-status">
    {hubLineText(line)}
    {line.kind === 'login' && (
      <>
        {' '}
        <a class="button" data-testid="hub-login" href={line.login} target="_blank" rel="noopener noreferrer">
          Open login link
        </a>
      </>
    )}
    {line.kind === 'outdated' && (
      <>
        {' '}
        <button type="button" data-testid="hub-reinstall" onClick={install}>
          Reinstall on {line.name}
        </button>
      </>
    )}
    {line.kind === 'failed' && (
      <button type="button" data-testid="hub-dismiss" title="Dismiss" onClick={dismiss}>
        ×
      </button>
    )}
  </span>
);

/** The Hubs menu and the status line of the latest hub opening; a home page opens hubs, a remote page links home. */
const Hubs = ({ client }: { client: HubClient }) => {
  const [state, setState] = useState(initialHubState);
  const [open, setOpen] = useState(false);
  const stateRef = useRef(state);
  const menuButton = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const outside = (event: PointerEvent): void => {
      if (event.target instanceof Node && menu.current?.contains(event.target) !== true) setOpen(false);
    };
    document.addEventListener('pointerdown', outside, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
    };
  }, [open]);
  const hosts = client.store.hosts.value;
  const dispatch = (action: HubAction): void => {
    const { state: next, effect } = hubStep(stateRef.current, action);
    stateRef.current = next;
    setState(next);
    if (effect?.t === 'navigate') location.assign(effect.url);
    else if (effect?.t === 'reopen') openHub(effect.host, effect.name);
  };
  const openHub = (host: number, name: string): void => {
    const req = client.openHub(host);
    if (req !== null) dispatch({ t: 'open', req, host, name });
  };
  useEffect(
    () =>
      client.onHubOpening((m) => {
        dispatch({ t: 'reply', m });
      }),
    [client],
  );
  useEffect(() => {
    const name = client.requestedHub;
    if (name === null || client.store.status.value !== 'open' || hosts.length === 0) return;
    client.requestedHub = null;
    const host = hosts.find((h) => h.remote && h.name === name);
    if (host === undefined) dispatch({ t: 'unknown', name });
    else openHub(host.idx, host.name);
  }, [hosts]);
  const entries = hubsMenu(client.remote, hosts);
  const pick = (target: HubTarget): void => {
    setOpen(false);
    if (target.t === 'navigate') location.assign(target.url);
    else if (target.t === 'open') openHub(target.host, target.name);
  };
  const closeOnEscape = (event: TargetedKeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    setOpen(false);
    // The focused entry goes with the menu: keep the keyboard on the Hubs button.
    menuButton.current?.focus();
  };
  const install = (): void => {
    const pending = stateRef.current.line;
    const host = hosts.find((h) => h.remote && h.name === pending?.name);
    const req = host === undefined ? null : client.installHub(host.idx);
    if (host !== undefined && req !== null) dispatch({ t: 'install', req, host: host.idx, name: host.name });
  };
  return (
    <>
      {state.line !== null && (
        <HubStatus
          line={state.line}
          install={install}
          dismiss={() => {
            dispatch({ t: 'dismiss' });
          }}
        />
      )}
      {entries !== null && (
        <span class="hubs" ref={menu}>
          <button
            type="button"
            ref={menuButton}
            class="hubs-menu"
            data-testid="hubs-menu"
            aria-expanded={open}
            onClick={() => {
              setOpen(!open);
            }}
            onKeyDown={closeOnEscape}
          >
            Hubs
          </button>
          {open && (
            <div class="hubs-list" data-testid="hubs-list" role="menu" tabIndex={-1} onKeyDown={closeOnEscape}>
              {entries.map((entry) => (
                <button
                  key={entry.label}
                  type="button"
                  role="menuitem"
                  class={entry.marked ? 'hubs-entry marked' : 'hubs-entry'}
                  data-testid="hubs-entry"
                  aria-current={entry.marked ? 'true' : undefined}
                  onClick={() => {
                    pick(entry.target);
                  }}
                >
                  {entry.label}
                </button>
              ))}
            </div>
          )}
        </span>
      )}
    </>
  );
};

/** Handles Enter and Escape on a dialog: Enter confirms unless a button has the focus, Escape cancels. */
const dialogKeys =
  (confirm: (() => void) | null, cancel: () => void) =>
  (event: TargetedKeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'Escape' && (event.key !== 'Enter' || confirm === null)) return;
    // A focused control acts on its own.
    if (event.key === 'Enter' && event.target !== event.currentTarget) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Enter') confirm?.();
    else cancel();
  };

/** What a confirmation asks, and what it lists. */
const ConfirmBody = ({ confirmation }: { confirmation: Confirmation }) => {
  if (confirmation.t === 'removeRepo') {
    return <div class="title">Remove {confirmation.label} from the repo tabs?</div>;
  }
  if (confirmation.t === 'removeWorktree') {
    return (
      <>
        <div class="title">Delete the worktree {confirmation.label}?</div>
        <ul>
          {confirmation.reasons.map((reason) => (
            <li key={reason} data-testid="confirm-reason">
              {reason}
            </li>
          ))}
        </ul>
        <p data-testid="confirm-note">{confirmation.note}</p>
      </>
    );
  }
  const { host, action, recalled } = confirmation;
  const title = action.kind === 'restart' ? `Restart the daemon on ${host.name}?` : `${action.label} wtd on ${host.name}?`;
  if (recalled === null) {
    return (
      <>
        <div class="title">{title}</div>
        <p>Every running terminal on {host.name} will be killed.</p>
      </>
    );
  }
  return (
    <>
      <div class="title">{title}</div>
      <p>These running terminals on {host.name} will be killed:</p>
      <ul>
        {recalled.terminals.map((t, i) => (
          <li
            key={String(i)} // NOSONAR(S6479) — a static list that may repeat a worktree and preset, so it has no other unique key
            data-testid="confirm-target"
          >
            {t.worktree}: {t.preset}
          </li>
        ))}
      </ul>
      <p data-testid="confirm-seen">Last seen {new Date(recalled.at).toLocaleString()}.</p>
    </>
  );
};

/** The confirm button's label. */
const confirmLabel = (confirmation: Confirmation): string => {
  if (confirmation.t === 'removeRepo') return 'Remove';
  return confirmation.t === 'removeWorktree' ? 'Delete' : confirmation.action.label;
};

/** The in-page confirmation of a host action, a repo removal or a worktree deletion; nothing is sent before it is confirmed. */
const ConfirmDialog = ({ view, confirmation }: { view: View; confirmation: Confirmation }) => {
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    dialog.current?.focus();
  }, []);
  const confirm = (): void => {
    view.confirm();
  };
  const cancel = (): void => {
    view.cancelConfirmation();
  };
  return (
    <dialog
      open
      class={confirmation.t === 'removeWorktree' ? 'confirm-dialog delete-worktree' : 'confirm-dialog'}
      data-testid="confirm-dialog"
      aria-label="Confirm"
      tabIndex={-1}
      ref={dialog}
      onKeyDown={dialogKeys(confirm, cancel)}
    >
      <ConfirmBody confirmation={confirmation} />
      <div class="buttons">
        <button type="button" data-testid="confirm-ok" onClick={confirm}>
          {confirmLabel(confirmation)}
        </button>
        <button type="button" data-testid="confirm-cancel" onClick={cancel}>
          Cancel
        </button>
      </div>
    </dialog>
  );
};

/** The add-repo dialog: a host, the repos discovered there, a filter and a typed path. */
const AddRepoBox = ({ client, view, dialog }: { client: HubClient; view: View; dialog: AddRepoDialog }) => {
  const filter = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    filter.current?.focus();
  }, []);
  const close = (): void => {
    view.closeAddRepo();
  };
  return (
    <dialog open class="add-repo-dialog" data-testid="add-repo-dialog" aria-label="Add repo" onKeyDown={dialogKeys(null, close)}>
      <div class="title">Add repo</div>
      <select
        data-testid="add-repo-host"
        value={String(dialog.host)}
        onChange={(event) => {
          view.changeAddRepoHost(Number(event.currentTarget.value));
        }}
      >
        {client.store.hosts.value.map((h) => (
          <option key={h.idx} value={String(h.idx)} disabled={h.status !== 'connected'}>
            {h.name} ({h.status})
          </option>
        ))}
      </select>
      <input
        type="text"
        ref={filter}
        data-testid="add-repo-filter"
        placeholder="Filter discovered repos"
        value={dialog.filter}
        onInput={(event) => {
          view.setAddRepoField('filter', event.currentTarget.value);
        }}
      />
      <div class="add-repo-options" role="listbox">
        {dialog.discovered === null && <div class="hint">Discovering…</div>}
        {view.offered.value.map((repo) => (
          <button
            type="button"
            key={repo}
            role="option"
            aria-selected={false}
            data-testid="add-repo-option"
            title={repo}
            onClick={() => {
              view.chooseRepo(repo);
            }}
          >
            {repo}
          </button>
        ))}
      </div>
      <input
        type="text"
        data-testid="add-repo-path"
        placeholder="Or type an absolute path and press Enter"
        value={dialog.path}
        onInput={(event) => {
          view.setAddRepoField('path', event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          view.chooseRepo(event.currentTarget.value);
        }}
      />
      {dialog.error !== null && (
        <div class="error" data-testid="add-repo-error">
          {dialog.error}
        </div>
      )}
      <div class="buttons">
        <button type="button" onClick={close}>
          Close
        </button>
      </div>
    </dialog>
  );
};

/** One repo tab: its label, the host's status while not connected, attention marks and a remove action. */
const RepoTabButton = ({ client, view, tab, selected }: { client: HubClient; view: View; tab: RepoTab; selected: boolean }) => {
  const key = repoKey(tab.host, tab.repo);
  const status = client.store.hosts.value.find((h) => h.idx === tab.host)?.status ?? null;
  const select = (): void => {
    view.selectRepo(tab);
  };
  return (
    <div
      class={`repo-tab${selected ? ' active' : ''}`}
      role="tab"
      data-testid="repo-tab"
      title={tab.repo}
      aria-selected={selected ? 'true' : 'false'}
      tabIndex={0}
      onClick={select}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        select();
      }}
    >
      {tab.label}
      {status !== null && status !== 'connected' && (
        <span class="host-status" data-testid="host-status">
          {statusText(status)}
        </span>
      )}
      <Mark of={aggregate(client.store.repos.value.get(key)?.terminals ?? [], 'group')} />
      <button
        type="button"
        class="close remove-repo"
        data-testid="remove-repo"
        title="Remove repo"
        aria-label="Remove repo"
        onClick={(event) => {
          event.stopPropagation();
          view.requestRemoveRepo(tab);
        }}
      />
    </div>
  );
};

/** An attention mark, absent without one; its title gives the number of terminals per mark. */
const Mark = ({ of }: { of: Aggregate }) =>
  of.mark === null ? null : <span class={`mark mark-${of.mark}`} data-testid="mark" data-mark={of.mark} title={markTitle(of.counts)} />;

const WorktreeEntry = ({
  entry,
  selected,
  terminals,
  view,
}: {
  entry: SidebarEntry;
  selected: boolean;
  terminals: Terminal[];
  view: View;
}) => (
  <div // NOSONAR(S6848) — a pointer shortcut; the label button is the keyboard control
    class={`worktree${entry.prunable ? ' prunable' : ''}${entry.gone ? ' gone' : ''}`}
    data-testid="worktree"
    data-path={entry.path}
    title={worktreeTitle(entry.path, terminals)}
    aria-selected={selected ? 'true' : 'false'}
    data-prunable={entry.prunable ? 'true' : undefined}
    data-gone={entry.gone ? 'true' : undefined}
    onClick={() => {
      view.selectWorktree(entry.path);
    }}
    onContextMenu={(event) => {
      event.preventDefault();
      view.openWorktreeMenu(entry.path, event.clientX, event.clientY);
    }}
  >
    {!entry.gone && (
      <input
        type="checkbox"
        class="worktree-star"
        aria-label={`${entry.checked ? 'Unstar' : 'Star'} ${entry.label}`}
        title={entry.checked ? 'Remove from starred' : 'Add to starred'}
        checked={entry.checked}
        onClick={(event) => {
          event.stopPropagation();
        }}
        onChange={(event) => {
          view.setChecked(entry.path, event.currentTarget.checked).catch(report('checking a worktree'));
        }}
      />
    )}
    <button type="button" class="label" data-testid="worktree-label">
      {entry.label}
      {entry.gone ? ' (gone)' : ''}
    </button>
    <Mark of={aggregate(terminals, 'group')} />
    <Ring terminals={terminals} />
  </div>
);

/** A hollow ring where a worktree with terminals shows no mark; its title gives their number. */
const Ring = ({ terminals }: { terminals: readonly Terminal[] }) => {
  const title = ringTitle(terminals);
  return title === null ? null : <span class="ring" data-testid="ring" title={title} />;
};

/** The worktree context menu; Escape or a press outside closes it. */
const WorktreeMenuBox = ({ view, menu }: { view: View; menu: WorktreeMenu }) => {
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    box.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const outside = (event: PointerEvent): void => {
      if (event.target instanceof Node && box.current?.contains(event.target) !== true) view.closeWorktreeMenu();
    };
    document.addEventListener('pointerdown', outside, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
    };
  }, [view]);
  const blocker = view.deleteBlocker(menu.worktree);
  return (
    <div
      class="context-menu"
      role="menu"
      data-testid="worktree-menu"
      tabIndex={-1}
      ref={box}
      style={{ left: px(menu.x), top: px(menu.y) }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        view.closeWorktreeMenu();
      }}
    >
      <button
        type="button"
        role="menuitem"
        data-testid="delete-worktree"
        disabled={blocker !== null}
        title={blocker ?? undefined}
        onClick={() => {
          view.deleteWorktree(menu.worktree);
        }}
      >
        Delete worktree
      </button>
    </div>
  );
};

/** Replaces a tab's label while it is renamed; Enter or leaving stores the text, Escape stores nothing, each edit ending once. */
const TabNameField = ({ tab, view, onEnd }: { tab: ShownTab; view: View; onEnd: () => void }) => {
  const field = useRef<HTMLInputElement>(null);
  const ended = useRef(false);
  useLayoutEffect(() => {
    const input = field.current;
    if (input === null) return;
    input.value = tabLabel(tab);
    input.focus();
    input.select();
  }, []);
  const end = (text: string | null): void => {
    if (ended.current) return;
    ended.current = true;
    if (text !== null) view.renameTab(tab.termId, text);
    onEnd();
  };
  return (
    <input
      type="text"
      class="term-tab-name"
      data-testid="term-tab-name"
      ref={field}
      maxLength={MAX_TAB_NAME}
      aria-label="Tab name"
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Enter') {
          if (event.isComposing) return;
          event.preventDefault();
          end(event.currentTarget.value);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          end(null);
        }
      }}
      onBlur={(event) => {
        end(event.currentTarget.value);
      }}
      onClick={(event) => {
        event.stopPropagation();
      }}
      onDblClick={(event) => {
        event.stopPropagation();
      }}
    />
  );
};

const TermTab = ({ tab, active, view }: { tab: ShownTab; active: boolean; view: View }) => {
  const [renaming, setRenaming] = useState(false);
  return (
    <div
      class={`term-tab${active ? ' active' : ''}`}
      role="tab"
      data-testid="term-tab"
      data-term={String(tab.termId)}
      aria-selected={active ? 'true' : 'false'}
      tabIndex={0}
      onClick={() => {
        view.chooseTab(tab.termId);
      }}
      onDblClick={() => {
        if (view.canRename(tab.termId)) setRenaming(true);
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        view.chooseTab(tab.termId);
      }}
    >
      {renaming ? (
        <TabNameField
          tab={tab}
          view={view}
          onEnd={() => {
            setRenaming(false);
          }}
        />
      ) : (
        tabLabel(tab)
      )}
      {exitSuffix(tab.terminal)}
      <Mark of={aggregate(tab.terminals, 'tab')} />
      <button
        type="button"
        class="close"
        data-testid="term-tab-close"
        title="Close"
        onClick={(event) => {
          event.stopPropagation();
          view.requestClose(termsOf(tab.root));
        }}
        onDblClick={(event) => {
          event.stopPropagation();
        }}
      >
        ×
      </button>
    </div>
  );
};

const NewTabButton = ({ view }: { view: View }) => (
  <button
    type="button"
    class="new-tab"
    data-testid="new-tab"
    title="New tab (Ctrl+Shift+T)"
    disabled={!view.canNewTab.value}
    onClick={() => {
      view.startCreate({ t: 'newTab' });
    }}
  >
    +
  </button>
);

const TabControls = ({ client, view }: { client: HubClient; view: View }) => (
  <span class="tab-controls">
    {(['right', 'down'] as const).map((dir) => (
      <button
        type="button"
        key={dir}
        data-testid={dir === 'right' ? 'split-right' : 'split-down'}
        title={dir === 'right' ? 'Split right (Ctrl+Shift+D)' : 'Split down (Ctrl+Shift+E)'}
        disabled={!view.canSplit.value}
        onClick={() => {
          const target = view.focused.value;
          if (target !== null) view.startCreate({ t: 'split', dir, target });
        }}
      >
        {dir === 'right' ? '◫' : '⬓'}
      </button>
    ))}
    <EditorControl client={client} view={view} />
  </span>
);

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** "Open in editor": opens the selected local worktree; a right-click, enabled or not, edits the command. */
const EditorControl = ({ client, view }: { client: HubClient; view: View }) => {
  const [pending, setPending] = useState(false);
  const failure = view.editorFailure.value;
  const [editing, setEditing] = useState(false);
  const worktree = view.worktree.value;
  const command = client.store.editor.value;
  const remotePage = client.remote !== null;
  const blocker = editorBlocker({
    remotePage,
    worktree: view.entries.value.find((e) => e.path === worktree) ?? null,
    remoteHost: view.host.value?.remote ?? false,
    command,
    pending,
  });
  useEffect(() => {
    if (command === null) setEditing(false);
  }, [command]);
  const open = (): void => {
    if (worktree === null || blocker !== null) return;
    const sent = command;
    setPending(true);
    client
      .openEditor(worktree)
      .catch((error: unknown) => {
        const code = error instanceof RequestError ? error.code : null;
        view.editorFailure.value = editorFailure(code, messageOf(error), sent);
      })
      .finally(() => {
        setPending(false);
      });
  };
  return (
    <span // NOSONAR(S6848) — a pointer shortcut; the form is also reachable through the button
      class="editor-control"
      title={blocker ?? EDITOR_TITLE}
      onContextMenu={(event) => {
        event.preventDefault();
        if (!remotePage && command !== null) setEditing(true);
      }}
    >
      <button
        type="button"
        data-testid="open-editor"
        aria-label="Open selected worktree in editor"
        title={blocker ?? EDITOR_TITLE}
        // Not `disabled`: it stays focusable, so the context-menu key opens the form in every state.
        aria-disabled={blocker !== null}
        onClick={open}
      >
        ✎
      </button>
      {editing && command !== null && (
        <EditorForm
          client={client}
          shown={command}
          onClose={() => {
            setEditing(false);
          }}
        />
      )}
      {failure !== null && (
        <EditorDialog
          failure={failure}
          onClose={() => {
            view.editorFailure.value = null;
          }}
        />
      )}
    </span>
  );
};

/** The dialog after a failed launch: the missing program, or the error's message as text. */
const EditorDialog = ({ failure, onClose }: { failure: EditorFailure; onClose: () => void }) => {
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    dialog.current?.focus();
  }, []);
  return (
    <dialog
      open
      class="confirm-dialog"
      data-testid="editor-dialog"
      aria-label="Open in editor"
      tabIndex={-1}
      ref={dialog}
      onKeyDown={dialogKeys(onClose, onClose)}
    >
      {failure.t === 'missing' ? (
        <p>
          Could not find <code>{failure.program}</code>. Install it, or right-click the editor button to set the command of the editor you
          prefer.
        </p>
      ) : (
        <p>Could not open the editor: {failure.message}</p>
      )}
      <div class="buttons">
        <button type="button" data-testid="editor-dialog-close" onClick={onClose}>
          Close
        </button>
      </div>
    </dialog>
  );
};

/** The editor command form beside the control; Escape, Cancel or a press outside closes it without sending. */
const EditorForm = ({ client, shown, onClose }: { client: HubClient; shown: string; onClose: () => void }) => {
  const box = useRef<HTMLFormElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const touched = useRef(false);
  const mounted = useRef(true);
  useLayoutEffect(() => {
    // An untouched field follows the command another page saved.
    if (field.current !== null && !touched.current) field.current.value = shown;
  }, [shown]);
  useLayoutEffect(() => {
    const input = field.current;
    if (input !== null) {
      input.value = shown;
      input.focus();
      input.select();
    }
    const outside = (event: PointerEvent): void => {
      if (event.target instanceof Node && box.current?.contains(event.target) !== true) onClose();
    };
    document.addEventListener('pointerdown', outside, true);
    return () => {
      mounted.current = false;
      document.removeEventListener('pointerdown', outside, true);
    };
  }, []);
  const send = (command: string | null): void => {
    setSending(true);
    setError(null);
    // A reply after this form closed belongs to no form shown now.
    client
      .setEditor(command)
      .then(
        () => {
          if (mounted.current) onClose();
        },
        (error_: unknown) => {
          if (mounted.current) setError(messageOf(error_));
        },
      )
      .finally(() => {
        if (mounted.current) setSending(false);
      });
  };
  return (
    <form // NOSONAR(S6847) — handles Escape bubbling from its field; the form itself takes no focus
      class="editor-form"
      data-testid="editor-form"
      ref={box}
      onSubmit={(event) => {
        event.preventDefault();
        const save = editorSave(field.current?.value ?? '', shown);
        if (save.t === 'refused') setError(save.error);
        else if (save.t === 'unchanged') onClose();
        else send(save.command);
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key !== 'Escape') return;
        event.preventDefault();
        onClose();
      }}
      onContextMenu={(event) => {
        event.stopPropagation();
      }}
    >
      <input
        type="text"
        data-testid="editor-command"
        aria-label="Editor command"
        ref={field}
        onInput={() => {
          touched.current = true;
        }}
      />
      <div class="hint">{EDITOR_HINT}</div>
      {error !== null && (
        <div class="error" data-testid="editor-error">
          {error}
        </div>
      )}
      <div class="buttons">
        <button
          type="button"
          data-testid="editor-reset"
          disabled={sending}
          onClick={() => {
            send(null);
          }}
        >
          Reset to default
        </button>
        <button type="button" data-testid="editor-cancel" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" data-testid="editor-save" disabled={sending}>
          Save
        </button>
      </div>
    </form>
  );
};

/** A pane of the shown tab; only in a split does it have a header naming it, with its mark and close button. */
const PaneFrame = ({ pane, focused, header, view }: { pane: ShownPane; focused: boolean; header: boolean; view: View }) => (
  <div
    class={`pane${focused ? ' focused' : ''}`}
    data-testid="pane"
    data-term={String(pane.termId)}
    data-focused={focused ? 'true' : undefined}
    style={{ left: px(pane.rect.left), top: px(pane.rect.top), width: px(pane.rect.width), height: px(pane.rect.height) }}
  >
    {header && (
      <div // NOSONAR(S6848) — a pointer shortcut; the keyboard moves between panes with Alt+arrows
        class="pane-header"
        style={{ height: px(PANE_HEADER) }}
        onMouseDown={() => {
          view.focusPane(pane.termId);
        }}
      >
        <span class="pane-label">
          {pane.terminal?.preset ?? 'terminal'} {pane.termId}
          {exitSuffix(pane.terminal)}
        </span>
        <Mark of={aggregate(pane.terminal === null ? [] : [pane.terminal], 'tab')} />
        <button
          type="button"
          class="close"
          data-testid="pane-close"
          title="Close (Ctrl+Shift+W)"
          onClick={() => {
            view.requestClose([pane.termId]);
          }}
        >
          ×
        </button>
      </div>
    )}
  </div>
);

const DividerHandle = ({ divider, view }: { divider: Divider; view: View }) => (
  <div
    class={`divider divider-${divider.split}`}
    data-testid="divider"
    data-split={divider.split}
    data-path={divider.path.join('.')}
    style={{ left: px(divider.rect.left), top: px(divider.rect.top), width: px(divider.rect.width), height: px(divider.rect.height) }}
    onPointerDown={(event) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      view.startDrag(divider);
    }}
    onPointerMove={(event) => {
      view.moveDrag(event.clientX, event.clientY);
    }}
    onPointerUp={() => {
      view.endDrag();
    }}
    onPointerCancel={() => {
      view.endDrag();
    }}
    onLostPointerCapture={() => {
      view.endDrag();
    }}
  />
);

/** Preset options in a list; keys move, choose and cancel as `pickerKey` says. */
const PresetList = ({
  presets,
  index,
  move,
  choose,
  cancel,
  remove,
  reorder,
  keyboardReorder,
  focusRequest,
}: {
  presets: readonly Preset[];
  index: number;
  move: (index: number) => void;
  choose: (index: number) => void;
  cancel: () => void;
  /** Removes the named preset; offered while more than one is left. */
  remove: (name: string) => void;
  /** Moves the named preset to position `to`, by dragging or, with `keyboardReorder`, Alt+Up/Down; resolves with whether the hub did. */
  reorder: (name: string, to: number) => Promise<boolean>;
  /** Whether Alt+Up/Down move the highlighted preset; otherwise they pass through untouched. */
  keyboardReorder: boolean;
  /** While positive, focuses the highlighted option at mount and on each change. */
  focusRequest: number;
}) => {
  const list = useRef<HTMLDivElement>(null);
  /** The dragged preset's position and the gap it would be dropped into (0 = before the first). */
  const [drag, setDrag] = useState<{ from: number; slot: number | null } | null>(null);
  const order = presets.map((p) => p.name).join('\n');
  const focusHighlighted = (): void => {
    list.current?.querySelectorAll<HTMLElement>('[data-testid="preset-option"]')[index]?.focus();
  };
  // Read before this render changes the DOM: a keyed reorder or a removed option may blur the focused one.
  const held = useRef(false);
  held.current = list.current?.contains(document.activeElement) ?? false;
  // Before the browser handles the next key, so no key meant for the list reaches a terminal.
  useLayoutEffect(() => {
    if (focusRequest > 0) focusHighlighted();
  }, [focusRequest]);
  useLayoutEffect(() => {
    if (held.current) focusHighlighted();
  }, [index, order]);
  /** The order a keyboard move was sent from; further moves wait until the new order arrives or the move fails. */
  const movingFrom = useRef<string | null>(null);
  const moveBy = (step: number): void => {
    const preset = presets[index];
    const to = index + step;
    if (preset === undefined || to < 0 || to >= presets.length || movingFrom.current === order) return;
    movingFrom.current = order;
    move(to);
    void reorder(preset.name, to).then((moved) => {
      if (!moved) movingFrom.current = null;
    });
  };
  const dropClass = (i: number): string => {
    if (drag?.slot === i) return ' drop-before';
    return drag?.slot === presets.length && i === presets.length - 1 ? ' drop-after' : '';
  };
  return (
    <div
      class="preset-list"
      role="listbox"
      tabIndex={-1}
      ref={list}
      onKeyDown={(event) => {
        if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
          if (!keyboardReorder) return;
          event.preventDefault();
          event.stopPropagation();
          moveBy(event.key === 'ArrowUp' ? -1 : 1);
          return;
        }
        const key = pickerKey(event.key, index, presets.length, event.repeat);
        if (key === null) {
          // Else a held Enter's repeats click the focused option.
          if (event.key === 'Enter') event.preventDefault();
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (key.t === 'choose') choose(key.index);
        else if (key.t === 'move') move(key.index);
        else cancel();
      }}
    >
      {presets.map((preset, i) => (
        <div
          class={`preset-row${dropClass(i)}`}
          role="none"
          key={preset.name}
          data-testid="preset-row"
          draggable={presets.length > 1}
          onDragStart={(event) => {
            event.dataTransfer?.setData('text/plain', preset.name);
            if (event.dataTransfer !== null) event.dataTransfer.effectAllowed = 'move';
            setDrag({ from: i, slot: null });
          }}
          onDragOver={(event) => {
            if (drag === null) return;
            event.preventDefault();
            const box = event.currentTarget.getBoundingClientRect();
            const slot = event.clientY < box.top + box.height / 2 ? i : i + 1;
            if (slot !== drag.slot) setDrag({ ...drag, slot });
          }}
          onDrop={(event) => {
            event.preventDefault();
            const slot = drag?.slot ?? null;
            const dragged = drag === null ? undefined : presets[drag.from];
            if (drag !== null && slot !== null && dragged !== undefined) {
              const to = dropPosition(drag.from, slot);
              if (to !== drag.from) void reorder(dragged.name, to);
            }
            setDrag(null);
          }}
          onDragEnd={() => {
            setDrag(null);
          }}
        >
          <button
            type="button"
            role="option"
            class="preset-option"
            data-testid="preset-option"
            aria-selected={i === index ? 'true' : 'false'}
            data-digit={i < 9 ? String(i + 1) : undefined}
            title={preset.command ?? 'shell'}
            onFocus={() => {
              if (i !== index) move(i);
            }}
            onClick={() => {
              choose(i);
            }}
          >
            {preset.name}
          </button>
          {presets.length > 1 && (
            <button
              type="button"
              class="preset-remove"
              data-testid="preset-remove"
              tabIndex={-1}
              title={`Remove ${preset.name}`}
              aria-label={`Remove preset ${preset.name}`}
              onClick={() => {
                remove(preset.name);
              }}
            >
              ×
            </button>
          )}
        </div>
      ))}
    </div>
  );
};

/** "+ Add preset", which opens a form for a new preset's name and command; Escape closes the form. */
const PresetAdder = ({ view, presets, onClose }: { view: View; presets: readonly Preset[]; onClose: () => void }) => {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);
  /** Bumped on each close, so a submission completing later leaves the form alone. */
  const generation = useRef(0);
  useLayoutEffect(() => {
    if (open) nameInput.current?.focus();
  }, [open]);
  const close = (): void => {
    generation.current++;
    setOpen(false);
    setName('');
    setCommand('');
    setError(null);
    setSending(false);
    onClose();
  };
  if (!open) {
    return (
      <button
        type="button"
        class="preset-add"
        data-testid="preset-add"
        onClick={() => {
          setOpen(true);
        }}
      >
        + Add preset
      </button>
    );
  }
  return (
    <form // NOSONAR(S6847) — handles Escape bubbling from its fields; the form itself takes no focus
      class="preset-form"
      data-testid="preset-form"
      onSubmit={(event) => {
        event.preventDefault();
        const result = presetFromForm(name, command, presets);
        if ('error' in result) {
          setError(result.error);
          return;
        }
        setSending(true);
        const mine = generation.current;
        view.addPreset(result.preset).then(
          () => {
            if (generation.current === mine) close();
          },
          (error_: unknown) => {
            if (generation.current !== mine) return;
            setError(error_ instanceof Error ? error_.message : String(error_));
            setSending(false);
          },
        );
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        close();
      }}
    >
      <input
        ref={nameInput}
        data-testid="preset-name"
        aria-label="Preset name"
        placeholder="Name"
        value={name}
        onInput={(event) => {
          setName(event.currentTarget.value);
        }}
      />
      <input
        data-testid="preset-command"
        aria-label="Preset command"
        placeholder="Command (empty: login shell)"
        value={command}
        onInput={(event) => {
          setCommand(event.currentTarget.value);
        }}
      />
      {error !== null && (
        <div class="error" data-testid="preset-error">
          {error}
        </div>
      )}
      <div class="buttons">
        <button type="button" onClick={close}>
          Cancel
        </button>
        <button type="submit" data-testid="preset-submit" disabled={sending}>
          Add
        </button>
      </div>
    </form>
  );
};

/** The picker for a new terminal; any pointer press outside it cancels it. */
const PresetPicker = ({ view, presets }: { view: View; presets: readonly Preset[] }) => {
  const box = useRef<HTMLDialogElement>(null);
  const [focusRequest, setFocusRequest] = useState(1);
  const picker = view.picker.value;
  const open = picker !== null;
  useLayoutEffect(() => {
    if (!open) return undefined;
    const outside = (event: PointerEvent): void => {
      if (event.target instanceof Node && box.current?.contains(event.target) !== true) view.cancelPicker();
    };
    document.addEventListener('pointerdown', outside, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
    };
  }, [view, open]);
  if (picker === null) return null;
  return (
    <dialog open class="preset-picker" data-testid="preset-picker" aria-label="New terminal" ref={box}>
      <div class="title">{picker.context.op.t === 'newTab' ? 'New tab' : `Split ${picker.context.op.dir}`}</div>
      <PresetList
        presets={presets}
        index={Math.min(picker.index, presets.length - 1)}
        keyboardReorder
        focusRequest={focusRequest}
        move={(i) => {
          view.movePicker(i);
        }}
        choose={(i) => {
          view.choosePreset(i);
        }}
        cancel={() => {
          view.cancelPicker();
        }}
        remove={(name) => {
          view.removePreset(name);
        }}
        reorder={(name, to) => view.movePreset(name, to)}
      />
      <PresetAdder
        view={view}
        presets={presets}
        onClose={() => {
          setFocusRequest((n) => n + 1);
        }}
      />
    </dialog>
  );
};

/** Where the page's keyboard focus is. */
const activeSpot = (manager: TerminalManager): FocusSpot => {
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

/** The presets a worktree without terminals offers; they take the keyboard focus as `choicesTakeFocus` says. */
const PresetChoices = ({ view, manager, presets }: { view: View; manager: TerminalManager; presets: readonly Preset[] }) => {
  const [index, setIndex] = useState(0);
  const [focusRequest, setFocusRequest] = useState(() => (choicesTakeFocus('shown', activeSpot(manager), view.modal.peek()) ? 1 : 0));
  const modal = view.modal.value;
  const wasModal = useRef(modal);
  useLayoutEffect(() => {
    if (wasModal.current && !modal) {
      // After this render flush, once the closed picker or dialog has left the DOM.
      queueMicrotask(() => {
        if (choicesTakeFocus('modalClosed', activeSpot(manager), view.modal.peek())) setFocusRequest((n) => n + 1);
      });
    }
    wasModal.current = modal;
  }, [manager, view, modal]);
  return (
    <div class="preset-choices" data-testid="preset-choices">
      <div class="title">Start a terminal</div>
      <PresetList
        presets={presets}
        index={Math.min(index, presets.length - 1)}
        keyboardReorder={false}
        focusRequest={focusRequest}
        move={setIndex}
        choose={(i) => {
          const preset = presets[i];
          if (preset !== undefined) view.choose(preset);
        }}
        cancel={() => undefined}
        remove={(name) => {
          view.removePreset(name);
        }}
        reorder={(name, to) => view.movePreset(name, to)}
      />
      <PresetAdder
        view={view}
        presets={presets}
        onClose={() => {
          setFocusRequest((n) => n + 1);
        }}
      />
    </div>
  );
};

const CloseDialog = ({ view, request }: { view: View; request: CloseRequest }) => {
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    dialog.current?.focus();
  }, []);
  return (
    <dialog
      open
      class="close-dialog"
      data-testid="close-dialog"
      aria-label="Close terminals"
      tabIndex={-1}
      ref={dialog}
      onKeyDown={(event) => {
        dialogKeys(
          () => {
            view.confirmClose();
          },
          () => {
            view.cancelClose();
          },
        )(event);
      }}
    >
      <div class="title">Close running terminals?</div>
      <ul>
        {view.closingTargets(request).map((t) => (
          <li key={t.termId} data-testid="close-target">
            {t.preset} {t.termId}
          </li>
        ))}
      </ul>
      <div class="buttons">
        <button
          type="button"
          data-testid="close-confirm"
          onClick={() => {
            view.confirmClose();
          }}
        >
          Close
        </button>
        <button
          type="button"
          data-testid="close-cancel"
          onClick={() => {
            view.cancelClose();
          }}
        >
          Cancel
        </button>
      </div>
    </dialog>
  );
};

/** The area the terminal manager's layer covers, with pane frames, dividers and the preset picker over it. */
const TerminalArea = ({ client, manager, view }: AppProps) => {
  const area = useRef<HTMLDivElement>(null);
  useEffect(
    () =>
      area.current === null
        ? undefined
        : followArea(manager, area.current, (rect) => {
            view.area.value = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
          }),
    [manager, view],
  );
  const presets = client.store.presets.value;
  const focused = view.focused.value;
  const empty = view.termTabs.value.tabs.length === 0;
  const tab = view.tab.value;
  const choicesKey = `${String(tab?.host)}\n${String(tab?.repo)}\n${String(view.worktree.value)}`;
  return (
    <div class="terminal-area" ref={area}>
      {view.panes.value.map((pane) => (
        <PaneFrame
          key={pane.termId}
          pane={pane}
          focused={pane.termId === focused}
          header={hasPaneHeaders(view.panes.value.length)}
          view={view}
        />
      ))}
      {view.dividers.value.map((divider) => (
        <DividerHandle key={divider.path.join('.')} divider={divider} view={view} />
      ))}
      {empty && view.canCreate.value && presets !== null && (
        <PresetChoices key={choicesKey} view={view} manager={manager} presets={presets} />
      )}
      {presets !== null && <PresetPicker view={view} presets={presets} />}
    </div>
  );
};

/** Sidebar width change per arrow key, in pixels. */
const SIDEBAR_KEY_STEPS: Readonly<Record<string, number>> = { ArrowLeft: -16, ArrowRight: 16 };

/** The draggable edge between the sidebar and the terminals; arrow keys move it too. */
const SidebarResizer = ({ view }: { view: View }) => {
  const width = view.sidebarWidth.value;
  return (
    <div // NOSONAR(S6819) NOSONAR(S6847) — WAI-ARIA window splitter: a focusable separator is interactive
      class="sidebar-resizer"
      role="separator"
      tabIndex={0} // NOSONAR(S6845) — WAI-ARIA window splitter: a focusable separator is interactive
      aria-orientation="vertical"
      aria-label="Resize the worktree list"
      aria-valuemin={SIDEBAR_WIDTH.min}
      aria-valuemax={SIDEBAR_WIDTH.max}
      aria-valuenow={width}
      data-testid="sidebar-resizer"
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const sidebar = event.currentTarget.previousElementSibling;
        if (!event.currentTarget.hasPointerCapture(event.pointerId) || sidebar === null) return;
        view.resizeSidebar(event.clientX - sidebar.getBoundingClientRect().left);
      }}
      onLostPointerCapture={() => {
        view.storeSidebarWidth();
      }}
      onKeyDown={(event) => {
        const step = SIDEBAR_KEY_STEPS[event.key];
        if (step === undefined) return;
        event.preventDefault();
        view.resizeSidebar(width + step);
        view.storeSidebarWidth();
      }}
    />
  );
};

/** The selected repo's worktree name search, with a button clearing it. */
const WorktreeSearch = ({ view }: { view: View }) => {
  const input = useRef<HTMLInputElement>(null);
  const search = view.search.value;
  return (
    <span class="worktree-search">
      <input
        ref={input}
        type="text"
        spellcheck={false}
        autocomplete="off"
        placeholder="Filter"
        aria-label="Filter worktrees by name"
        data-testid="worktree-search"
        value={search}
        onInput={(event) => {
          view.setSearch(event.currentTarget.value);
        }}
      />
      {search !== '' && (
        <button
          type="button"
          aria-label="Clear the worktree filter"
          title="Clear the worktree filter"
          data-testid="worktree-search-clear"
          onClick={() => {
            view.setSearch('');
            input.current?.focus();
          }}
        >
          ×
        </button>
      )}
    </span>
  );
};

const Workspace = ({ client, manager, view }: AppProps) => {
  const tab = view.tab.value;
  const repo = view.repo.value;
  const worktree = view.worktree.value;
  const { tabs, active } = view.termTabs.value;
  const closing = view.closing.value;
  return (
    <div class="workspace">
      <nav class="sidebar" style={{ width: px(view.sidebarWidth.value) }}>
        <div class="sidebar-header">
          <span class="sidebar-title">Worktrees</span>
          <WorktreeSearch view={view} />
          <label class="star-filter" title="Show starred worktrees only">
            <span>Starred</span>
            {/* Keyed by repo: switching repos mounts it in place, so only a click animates it. */}
            <input
              key={tab === null ? '' : repoKey(tab.host, tab.repo)}
              type="checkbox"
              role="switch"
              aria-label="Show starred worktrees only"
              data-testid="filter-checked"
              checked={view.filter.value === 'checked'}
              onChange={(event) => {
                view.setFilter(event.currentTarget.checked ? 'checked' : 'all');
              }}
            />
          </label>
        </div>
        <div class="worktree-list">
          {view.listed.value.map((e) => (
            <WorktreeEntry
              key={e.path}
              entry={e}
              selected={e.path === worktree}
              terminals={(repo?.terminals ?? []).filter((t) => t.worktree === e.path)}
              view={view}
            />
          ))}
        </div>
      </nav>
      <SidebarResizer view={view} />
      <main class="terminal-pane">
        {tab !== null && repo?.error != null && (
          <div class="repo-error" data-testid="repo-error">
            {repo.error.code}: {tab.repo} ({repo.error.message})
          </div>
        )}
        <div class="term-tabs" role="tablist">
          <div class="term-tab-strip">
            {tabs.map((t) => (
              <TermTab key={t.key} tab={t} active={t.termId === active} view={view} />
            ))}
            <NewTabButton view={view} />
          </div>
          <span class="spacer" />
          <TabControls client={client} view={view} />
        </div>
        <TerminalArea client={client} manager={manager} view={view} />
      </main>
      {closing !== null && <CloseDialog view={view} request={closing} />}
      {view.worktreeMenu.value !== null && <WorktreeMenuBox view={view} menu={view.worktreeMenu.value} />}
    </div>
  );
};

/** The page: repo tabs, host banners, sidebar and terminal tabs; terminals themselves live in the manager's layer. */
export const App = ({ client, manager, view }: AppProps): JSX.Element => {
  const status = client.store.status.value;
  if (status === 'auth') return <AuthMessage />;
  if (status === 'outdated') return <OutdatedUi />;
  const selected = view.tab.value;
  const notice = view.notice.value ?? client.store.notice.value;
  const confirmation = view.confirmation.value;
  const addRepo = view.addRepo.value;
  return (
    <div class="app">
      <div class="repo-tabs" role="tablist">
        {view.tabs.value.map((t) => {
          const key = repoKey(t.host, t.repo);
          const isSelected = selected !== null && repoKey(selected.host, selected.repo) === key;
          return <RepoTabButton key={key} client={client} view={view} tab={t} selected={isSelected} />;
        })}
        <button
          type="button"
          class="add-repo"
          data-testid="add-repo"
          title="Add repo"
          onClick={() => {
            view.openAddRepo();
          }}
        >
          + Add repo
        </button>
        <span class="spacer" />
        <Hubs client={client} />
        {status === 'reconnecting' && (
          <span class="reconnecting" data-testid="reconnecting">
            Reconnecting…
          </span>
        )}
      </div>
      {client.store.hosts.value.filter(hasBanner).map((h) => (
        <HostBanner key={h.idx} host={h} view={view} />
      ))}
      {notice !== null && (
        <div class="banner notice" data-testid="notice">
          {notice}
          <button
            type="button"
            title="Dismiss"
            onClick={() => {
              view.notice.value = null;
              client.store.notice.value = null;
            }}
          >
            ×
          </button>
        </div>
      )}
      <Workspace client={client} manager={manager} view={view} />
      {confirmation !== null && <ConfirmDialog view={view} confirmation={confirmation} />}
      {addRepo !== null && <AddRepoBox client={client} view={view} dialog={addRepo} />}
    </div>
  );
};
