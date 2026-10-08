import { signal } from '@preact/signals';
import type { HostEntry, Layout, MessageOf, Preset, Terminal, Worktree } from '../../protocol/index.js';

type DaemonEvent = Extract<MessageOf<'hubToBrowser'>, { t: 'host' }>['m'];

/** Where the page stands with the hub. */
export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'auth' | 'outdated';

/** What the page knows of one watched repo. */
export interface RepoState {
  worktrees: readonly Worktree[];
  terminals: readonly Terminal[];
  checked: readonly string[];
  layouts: ReadonlyMap<string, Layout>;
  /** Why the repo's watch failed, if it did. */
  error: { code: string; message: string } | null;
}

export const SHORT_HEAD = 7;

const directoryName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** The branch, or `<directory> @ <short head>` when detached, or the directory name. */
export const worktreeLabel = (worktree: Worktree): string => {
  if (worktree.branch !== null) return worktree.branch;
  const dir = directoryName(worktree.path);
  return worktree.detached && worktree.head !== null ? `${dir} @ ${worktree.head.slice(0, SHORT_HEAD)}` : dir;
};

const EMPTY: RepoState = { worktrees: [], terminals: [], checked: [], layouts: new Map(), error: null };

export const repoKey = (host: number, repo: string): string => `${String(host)}:${repo}`;

const writeKey = (host: number, worktree: string): string => `${String(host)}:${worktree}`;

/** The page's view of the hub and its daemons, as signals. */
export class HubStore {
  readonly status = signal<ConnectionStatus>('connecting');
  readonly hosts = signal<readonly HostEntry[]>([]);
  /** Repo states by `repoKey`. */
  readonly repos = signal<ReadonlyMap<string, RepoState>>(new Map());
  /** A problem the hub reported outside any request. */
  readonly notice = signal<string | null>(null);
  /** The presets of the current session; null until the hub sends them. */
  readonly presets = signal<readonly Preset[] | null>(null);
  /** Per host, repos the hub no longer lists that the page keeps while they have running terminals. */
  readonly kept = signal<ReadonlyMap<number, readonly string[]>>(new Map());
  /** The layouts each repo's daemon last reported, by `repoKey` and worktree. */
  private readonly reported = new Map<string, Map<string, Layout>>();
  /** Our `setLayout` requests not yet answered, by host and worktree. */
  private readonly writes = new Map<string, number>();

  setPresets(presets: readonly Preset[]): void {
    this.presets.value = presets;
  }

  /** The session with the hub closed: its presets no longer hold. */
  sessionClosed(): void {
    this.presets.value = null;
  }

  repo(host: number, repo: string): RepoState | null {
    return this.repos.value.get(repoKey(host, repo)) ?? null;
  }

  /** Terminal ids the daemon lists for `repo`. */
  terminalIds(host: number, repo: string): number[] {
    return (this.repo(host, repo)?.terminals ?? []).map((t) => t.termId);
  }

  repoError(host: number, repo: string, error: { code: string; message: string }): void {
    this.update(host, repo, (state) => ({ ...state, error }));
  }

  /** Whether the page holds a terminal of `repo` whose process runs. */
  hasRunning(host: number, repo: string): boolean {
    return (this.repo(host, repo)?.terminals ?? []).some((t) => t.exit === null);
  }

  /** Keeps `repo` of `host` shown although the hub no longer lists it, or stops keeping it. */
  keep(host: number, repo: string, kept: boolean): void {
    const current = this.kept.value.get(host) ?? [];
    if (current.includes(repo) === kept) return;
    const next = new Map(this.kept.value);
    next.set(host, kept ? [...current, repo] : current.filter((r) => r !== repo));
    this.kept.value = next;
  }

  /** Forgets the state of one repo. */
  dropRepo(host: number, repo: string): void {
    const key = repoKey(host, repo);
    this.reported.delete(key);
    this.repos.value = new Map([...this.repos.value].filter(([k]) => k !== key));
    this.keep(host, repo, false);
  }

  /** The running terminals of `host` with their worktree labels. */
  running(host: number): { worktree: string; preset: string }[] {
    const prefix = `${String(host)}:`;
    const found: { worktree: string; preset: string }[] = [];
    for (const [key, state] of this.repos.value) {
      if (!key.startsWith(prefix)) continue;
      for (const t of state.terminals) {
        if (t.exit !== null) continue;
        const worktree = state.worktrees.find((w) => w.path === t.worktree);
        found.push({ worktree: worktree === undefined ? directoryName(t.worktree) : worktreeLabel(worktree), preset: t.preset });
      }
    }
    return found;
  }

  /** Forgets every repo state of `host`. */
  clearHost(host: number): void {
    const prefix = `${String(host)}:`;
    this.repos.value = new Map([...this.repos.value].filter(([key]) => !key.startsWith(prefix)));
    if (this.kept.value.has(host)) {
      const kept = new Map(this.kept.value);
      kept.delete(host);
      this.kept.value = kept;
    }
    for (const key of this.reported.keys()) if (key.startsWith(prefix)) this.reported.delete(key);
    for (const key of this.writes.keys()) if (key.startsWith(prefix)) this.writes.delete(key);
  }

  /** Applies a daemon event of `host` to the repo states. */
  apply(host: number, m: DaemonEvent): void {
    switch (m.t) {
      case 'repoState':
        this.reported.set(repoKey(host, m.repo), new Map(m.layouts.map((l) => [l.worktree, l.layout])));
        this.update(host, m.repo, () => ({
          worktrees: m.worktrees,
          terminals: m.terminals,
          checked: m.checked,
          layouts: new Map(m.layouts.map((l) => [l.worktree, l.layout])),
          error: null,
        }));
        return;
      case 'worktreesChanged':
        this.update(host, m.repo, (state) => ({ ...state, worktrees: m.worktrees }));
        return;
      case 'termCreated':
        this.inRepoOf(host, m.term.worktree, (state) =>
          state.terminals.some((t) => t.termId === m.term.termId) ? state : { ...state, terminals: [...state.terminals, m.term] },
        );
        return;
      case 'termExited':
        this.withTerminal(host, m.termId, (t) => ({ ...t, exit: { code: m.code, signal: m.signal } }));
        return;
      case 'activity':
        this.withTerminal(host, m.termId, (t) => ({ ...t, unseen: m.unseen, state: m.state }));
        return;
      case 'termClosed':
        this.forHost(host, (state) =>
          state.terminals.some((t) => t.termId === m.termId)
            ? { ...state, terminals: state.terminals.filter((t) => t.termId !== m.termId) }
            : state,
        );
        return;
      case 'checkedChanged':
        this.inRepoOf(host, m.worktree, (state) => ({
          ...state,
          checked: m.checked ? [...new Set([...state.checked, m.worktree])] : state.checked.filter((p) => p !== m.worktree),
        }));
        return;
      case 'layoutChanged': {
        const repo = this.repoOf(host, m.worktree);
        if (repo !== null) this.reported.get(repoKey(host, repo))?.set(m.worktree, m.layout);
        // An echo of an earlier write of ours must not replace a newer layout we show.
        if (!this.writes.has(writeKey(host, m.worktree))) this.setLayout(host, m.worktree, m.layout);
        return;
      }
      case 'done':
      case 'error':
      case 'detached':
      case 'reposDiscovered':
      case 'worktreeAtRisk':
        return;
    }
  }

  /** Shows `layout` for `worktree` at once, as the daemon will once our `setLayout` of it lands; `layoutWritten` follows its answer. */
  writeLayout(host: number, worktree: string, layout: Layout): void {
    const key = writeKey(host, worktree);
    this.writes.set(key, (this.writes.get(key) ?? 0) + 1);
    this.setLayout(host, worktree, layout);
  }

  /** One of our `setLayout` requests for `worktree` was answered; once none is left, shows the layout the daemon last reported. */
  layoutWritten(host: number, worktree: string): void {
    const key = writeKey(host, worktree);
    const left = (this.writes.get(key) ?? 0) - 1;
    if (left > 0) {
      this.writes.set(key, left);
      return;
    }
    this.writes.delete(key);
    this.showReported(host, worktree);
  }

  private setLayout(host: number, worktree: string, layout: Layout): void {
    this.inRepoOf(host, worktree, (state) => ({ ...state, layouts: new Map([...state.layouts, [worktree, layout]]) }));
  }

  private showReported(host: number, worktree: string): void {
    const repo = this.repoOf(host, worktree);
    if (repo === null) return;
    const reported = this.reported.get(repoKey(host, repo))?.get(worktree);
    this.update(host, repo, (state) => {
      const layouts = new Map(state.layouts);
      if (reported === undefined) layouts.delete(worktree);
      else layouts.set(worktree, reported);
      return { ...state, layouts };
    });
  }

  /** The repo of `host` that `worktree` belongs to. */
  repoOf(host: number, worktree: string): string | null {
    const prefix = `${String(host)}:`;
    for (const [key, state] of this.repos.value) {
      if (!key.startsWith(prefix)) continue;
      if (state.worktrees.some((w) => w.path === worktree) || state.terminals.some((t) => t.worktree === worktree)) {
        return key.slice(prefix.length);
      }
    }
    return null;
  }

  private update(host: number, repo: string, change: (state: RepoState) => RepoState): void {
    const key = repoKey(host, repo);
    const next = new Map(this.repos.value);
    next.set(key, change(next.get(key) ?? EMPTY));
    this.repos.value = next;
  }

  private inRepoOf(host: number, worktree: string, change: (state: RepoState) => RepoState): void {
    const repo = this.repoOf(host, worktree);
    if (repo !== null) this.update(host, repo, change);
  }

  private forHost(host: number, change: (state: RepoState) => RepoState): void {
    const prefix = `${String(host)}:`;
    const next = new Map(this.repos.value);
    let changed = false;
    for (const [key, state] of this.repos.value) {
      if (!key.startsWith(prefix)) continue;
      const updated = change(state);
      if (updated === state) continue;
      next.set(key, updated);
      changed = true;
    }
    if (changed) this.repos.value = next;
  }

  private withTerminal(host: number, termId: number, change: (t: Terminal) => Terminal): void {
    this.forHost(host, (state) =>
      state.terminals.some((t) => t.termId === termId)
        ? { ...state, terminals: state.terminals.map((t) => (t.termId === termId ? change(t) : t)) }
        : state,
    );
  }
}
