import type { JSX } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import type { HostEntry } from '../../protocol/index.js';
import { repoKey, type HubClient } from '../client/index.js';
import { followArea, type TerminalManager } from '../terminals/index.js';
import type { SidebarEntry } from './sidebar.js';
import type { ShownTab, View } from './view.js';

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

const OutdatedHost = ({ host, client }: { host: HostEntry; client: HubClient }) => {
  const restart = (): void => {
    if (!window.confirm(`Restart the daemon on ${host.name}? Every terminal on ${host.name} will be killed.`)) return;
    client.restartDaemon(host.idx).catch(report('restarting the daemon'));
  };
  return (
    <div class="banner" data-testid="host-outdated">
      {host.name}: the daemon is outdated ({host.daemonVersion ?? 'unknown version'}).{' '}
      <button type="button" data-testid="restart-daemon" onClick={restart}>
        Restart daemon
      </button>
    </div>
  );
};

const WorktreeEntry = ({ entry, selected, view }: { entry: SidebarEntry; selected: boolean; view: View }) => (
  <div
    class={`worktree${entry.prunable ? ' prunable' : ''}${entry.gone ? ' gone' : ''}`}
    data-testid="worktree"
    title={entry.path}
    aria-selected={selected ? 'true' : 'false'}
    data-prunable={entry.prunable ? 'true' : undefined}
    data-gone={entry.gone ? 'true' : undefined}
  >
    {!entry.gone && (
      <input
        type="checkbox"
        checked={entry.checked}
        onChange={(event) => {
          view.setChecked(entry.path, event.currentTarget.checked).catch(report('checking a worktree'));
        }}
      />
    )}
    <button
      type="button"
      class="label"
      data-testid="worktree-label"
      onClick={() => {
        view.selectWorktree(entry.path);
      }}
    >
      {entry.label}
      {entry.gone ? ' (gone)' : ''}
    </button>
  </div>
);

const TermTab = ({ tab, active, view }: { tab: ShownTab; active: boolean; view: View }) => (
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
    onKeyDown={(event) => {
      if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
      event.preventDefault();
      view.chooseTab(tab.termId);
    }}
  >
    {tab.terminal?.preset ?? 'terminal'} {tab.termId}
    {tab.terminal?.exit != null ? ' (exited)' : ''}
    <button
      type="button"
      class="close"
      data-testid="term-tab-close"
      title="Close"
      onClick={(event) => {
        event.stopPropagation();
        view.closeTerminal(tab.termId).catch(report('closing a terminal'));
      }}
    >
      ×
    </button>
  </div>
);

/** The area the terminal manager's layer covers. */
const TerminalArea = ({ manager }: { manager: TerminalManager }) => {
  const area = useRef<HTMLDivElement>(null);
  useEffect(() => (area.current === null ? undefined : followArea(manager, area.current)), [manager]);
  return <div class="terminal-area" ref={area} />;
};

const Workspace = ({ client, manager, view }: AppProps) => {
  const tab = view.tab.value;
  const repo = view.repo.value;
  const worktree = view.worktree.value;
  const entry = view.entries.value.find((e) => e.path === worktree);
  const { tabs, active } = view.termTabs.value;
  const canCreate =
    entry !== undefined &&
    !entry.prunable &&
    !entry.gone &&
    client.store.hosts.value.some((h) => h.idx === tab?.host && h.status === 'connected');
  return (
    <div class="workspace">
      <nav class="sidebar">
        {view.listed.value.map((e) => (
          <WorktreeEntry key={e.path} entry={e} selected={e.path === worktree} view={view} />
        ))}
      </nav>
      <main class="terminal-pane">
        {tab !== null && repo?.error != null && (
          <div class="repo-error" data-testid="repo-error">
            {repo.error.code}: {tab.repo} ({repo.error.message})
          </div>
        )}
        <div class="term-tabs" role="tablist">
          {tabs.map((t) => (
            <TermTab key={t.termId} tab={t} active={t.termId === active} view={view} />
          ))}
          {canCreate && (
            <button
              type="button"
              class="new-terminal"
              data-testid="new-terminal"
              onClick={() => {
                view.newTerminal().catch(report('creating a terminal'));
              }}
            >
              + New terminal
            </button>
          )}
        </div>
        <TerminalArea manager={manager} />
      </main>
    </div>
  );
};

/** The page: repo tabs, host banners, sidebar and terminal tabs; terminals themselves live in the manager's layer. */
export const App = ({ client, manager, view }: AppProps): JSX.Element => {
  const status = client.store.status.value;
  if (status === 'auth') return <AuthMessage />;
  if (status === 'outdated') return <OutdatedUi />;
  const selected = view.tab.value;
  return (
    <div class="app">
      <div class="repo-tabs" role="tablist">
        {view.tabs.value.map((t) => {
          const key = repoKey(t.host, t.repo);
          const isSelected = selected !== null && repoKey(selected.host, selected.repo) === key;
          return (
            <button
              type="button"
              key={key}
              class={`repo-tab${isSelected ? ' active' : ''}`}
              role="tab"
              data-testid="repo-tab"
              title={t.repo}
              aria-selected={isSelected ? 'true' : 'false'}
              onClick={() => {
                view.selectRepo(t);
              }}
            >
              {t.label}
            </button>
          );
        })}
        <span class="spacer" />
        {status === 'reconnecting' && (
          <span class="reconnecting" data-testid="reconnecting">
            Reconnecting…
          </span>
        )}
        <label class="filter">
          <input
            type="checkbox"
            data-testid="filter-checked"
            checked={view.filter.value === 'checked'}
            onChange={(event) => {
              view.setFilter(event.currentTarget.checked ? 'checked' : 'all');
            }}
          />{' '}
          Checked only
        </label>
      </div>
      {client.store.hosts.value
        .filter((h) => h.status === 'outdated')
        .map((h) => (
          <OutdatedHost key={h.idx} host={h} client={client} />
        ))}
      {client.store.notice.value !== null && <div class="banner notice">{client.store.notice.value}</div>}
      <Workspace client={client} manager={manager} view={view} />
    </div>
  );
};
