import type { Socket } from 'node:net';
import { FLOW_HIGH, PROTOCOL_VERSION, type Layout, type Terminal, type Worktree } from '../../protocol/index.js';
import { pruneLayout, type StateStore } from '../state/index.js';
import { SpawnError, type OutputSink, type TerminalEvents, type TerminalProcess, type TerminalSpec } from '../terminals/index.js';
import { NotARepoError, type discoverRepos, type listWorktrees, type watchWorktrees, type WorktreeWatch } from '../worktrees/index.js';
import type { GateOutcome, Request } from './connection.js';
import { Peer, type Event } from './peer.js';

/** Most live terminals per repo. */
const MAX_TERMINALS = 1024;

type ErrorCode = Extract<Event, { t: 'error' }>['code'];
type Correlated = Extract<Request, { req: number }>;

/** A request failure reported to the client with `code`. */
class RequestError extends Error {
  override readonly name = 'RequestError';

  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

interface RepoEntry {
  watch: WorktreeWatch;
  watchers: Set<Peer>;
}

interface TermEntry {
  termId: number;
  repo: string;
  worktree: string;
  preset: string;
  process: TerminalProcess;
}

/** What the daemon composes: worktree watching and listing, discovery, and terminals. */
export interface DaemonServices {
  watchWorktrees: typeof watchWorktrees;
  listWorktrees: typeof listWorktrees;
  discoverRepos: typeof discoverRepos;
  spawnTerminal: (spec: TerminalSpec, events: TerminalEvents) => Promise<TerminalProcess>;
}

export interface DaemonOptions {
  services: DaemonServices;
  version: string;
  instance: string;
  store: StateStore;
  /** Environment of terminal processes. */
  env: Readonly<Record<string, string | undefined>>;
  /** A client asked the daemon to shut down. */
  shutdown: () => void;
  /** Reports an unexpected failure. */
  report: (error: unknown) => void;
}

/** The daemon's protocol service: connections, repo watches, terminals and state, composed. */
export class Daemon {
  private readonly peers = new Set<Peer>();
  private readonly repos = new Map<string, RepoEntry>();
  private readonly starting = new Map<string, Promise<RepoEntry>>();
  /** Connections waiting per repo for its watch to start; a started watch is kept while any wait. */
  private readonly waiting = new Map<string, number>();
  private readonly terminals = new Map<number, TermEntry>();
  /** Terminals being started per repo; they count against MAX_TERMINALS. */
  private readonly spawning = new Map<string, number>();
  private readonly spawns = new Set<Promise<TerminalProcess>>();
  /** Terminals closed but not yet reaped. */
  private readonly reaping = new Set<Promise<void>>();
  private stopping = false;
  private nextTermId = 1;
  private nextPeerId = 1;

  constructor(private readonly options: DaemonOptions) {}

  accept(socket: Socket): void {
    const peer = new Peer(this.nextPeerId++, socket, {
      received: (p, outcome) => {
        this.receive(p, outcome);
      },
      closed: (p) => {
        this.disconnect(p);
      },
    });
    this.peers.add(peer);
    peer.send({ t: 'hello', protocol: PROTOCOL_VERSION, version: this.options.version, instance: this.options.instance });
  }

  /**
   * Refuses further requests, lets terminal and watch starts in flight finish, closes every
   * terminal and watch, waits until each terminal is reaped and state is written, then ends every
   * connection.
   */
  async shutdown(): Promise<void> {
    this.stopping = true;
    await Promise.allSettled([...this.starting.values(), ...this.spawns]);
    for (const term of this.terminals.values()) this.closeTerminal(term);
    for (const entry of this.repos.values()) entry.watch.close();
    this.repos.clear();
    while (this.reaping.size > 0) await Promise.all(this.reaping); // NOSONAR(S9382) — re-checks for closes started meanwhile
    await this.options.store.flush();
    for (const peer of this.peers) peer.end();
  }

  private receive(peer: Peer, outcome: GateOutcome): void {
    switch (outcome.kind) {
      case 'hello':
        return;
      case 'shutdown':
        this.options.shutdown();
        return;
      case 'reject':
        peer.sendError(outcome.code, outcome.code === 'bad-message' ? 'malformed message' : 'protocol version mismatch');
        if (outcome.close) peer.end();
        return;
      case 'input':
        this.input(peer, outcome.termId, outcome.data);
        return;
      case 'request':
        this.request(peer, outcome.message);
        return;
    }
  }

  private request(peer: Peer, message: Request): void {
    switch (message.t) {
      case 'resize':
        this.uncorrelated(peer, () => {
          this.access(peer, message.termId).process.resize(message.cols, message.rows);
        });
        return;
      case 'ack':
        this.ack(peer, message.termId, message.offset);
        return;
      case 'setVisible':
        this.setVisible(peer, message.termIds);
        return;
      case 'watchRepo':
      case 'unwatchRepo':
      case 'discoverRepos':
      case 'createTerm':
      case 'attach':
      case 'detach':
      case 'closeTerm':
      case 'setChecked':
      case 'setLayout':
        void this.correlated(peer, message);
    }
  }

  /** Runs `action`, reporting a failure as an uncorrelated error. */
  private uncorrelated(peer: Peer, action: () => void): void {
    try {
      action();
    } catch (error) {
      if (!(error instanceof RequestError)) throw error;
      peer.sendError(error.code, error.message);
    }
  }

  private async correlated(peer: Peer, message: Correlated): Promise<void> {
    try {
      await this.handle(peer, message);
    } catch (error) {
      if (error instanceof RequestError) {
        peer.sendError(error.code, error.message, message.req);
        return;
      }
      this.options.report(error);
      peer.sendError('internal', error instanceof Error ? error.message : String(error), message.req);
    }
  }

  private async handle(peer: Peer, m: Correlated): Promise<void> {
    if (this.stopping) throw new RequestError('internal', 'the daemon is shutting down');
    switch (m.t) {
      case 'watchRepo':
        await this.watchRepo(peer, m.repo);
        break;
      case 'unwatchRepo':
        if (!peer.watched.has(m.repo)) throw new RequestError('not-watched', `${m.repo} is not watched`);
        this.unsubscribe(peer, m.repo);
        break;
      case 'discoverRepos':
        peer.send({ t: 'reposDiscovered', req: m.req, repos: await this.options.services.discoverRepos(m.roots, m.depth) });
        return;
      case 'createTerm':
        await this.createTerm(peer, m);
        return;
      case 'attach':
        await this.attach(peer, m.termId, m.req);
        return;
      case 'detach':
        this.access(peer, m.termId).process.detach(peer.id);
        break;
      case 'closeTerm':
        await this.closeTerm(peer, m.termId);
        break;
      case 'setChecked':
        await this.setChecked(peer, m.worktree, m.checked);
        break;
      case 'setLayout':
        await this.setLayout(peer, m.worktree, m.layout);
        break;
    }
    peer.send({ t: 'done', req: m.req });
  }

  private broadcast(repo: string, message: Event, except: Peer | null = null): void {
    for (const peer of this.repos.get(repo)?.watchers ?? []) if (peer !== except) peer.send(message);
  }

  // Repos and worktrees.

  private async watchRepo(peer: Peer, repo: string): Promise<void> {
    let entry = this.repos.get(repo);
    if (entry === undefined) {
      increment(this.waiting, repo);
      try {
        entry = await this.startWatch(repo);
      } finally {
        decrement(this.waiting, repo);
      }
    }
    if (peer.closed) {
      if (entry.watchers.size === 0 && !this.waiting.has(repo)) this.stopWatch(repo);
      return;
    }
    entry.watchers.add(peer);
    peer.watched.add(repo);
    peer.send({
      t: 'repoState',
      repo,
      worktrees: entry.watch.worktrees,
      terminals: this.terminalsOf(repo).map(describe),
      checked: this.options.store.checked(repo),
      layouts: this.options.store.layouts(repo),
    });
  }

  /** The repo's shared watch, started once however many connections ask at the same time. */
  private startWatch(repo: string): Promise<RepoEntry> {
    let pending = this.starting.get(repo);
    if (pending === undefined) {
      pending = this.createWatch(repo).finally(() => this.starting.delete(repo));
      this.starting.set(repo, pending);
    }
    return pending;
  }

  private async createWatch(repo: string): Promise<RepoEntry> {
    let watch: WorktreeWatch;
    try {
      watch = await this.options.services.watchWorktrees(repo, {
        changed: (worktrees) => {
          this.broadcast(repo, { t: 'worktreesChanged', repo, worktrees });
          void this.prune(repo);
        },
        failed: (error) => {
          this.watchFailed(repo, error);
        },
      });
    } catch (error) {
      if (error instanceof NotARepoError) throw new RequestError('not-a-repo', error.message);
      throw error;
    }
    const entry: RepoEntry = { watch, watchers: new Set() };
    this.repos.set(repo, entry);
    void this.prune(repo);
    return entry;
  }

  private stopWatch(repo: string): void {
    this.repos.get(repo)?.watch.close();
    this.repos.delete(repo);
  }

  private watchFailed(repo: string, error: Error): void {
    this.options.report(error);
    const watchers = [...(this.repos.get(repo)?.watchers ?? [])];
    for (const peer of watchers) {
      peer.sendError('internal', `watching ${repo} failed: ${error.message}`);
      this.unsubscribe(peer, repo);
    }
    this.repos.delete(repo);
  }

  /** Ends `peer`'s subscription to `repo`: no events, no attachments, no visibility. */
  private unsubscribe(peer: Peer, repo: string): void {
    peer.watched.delete(repo);
    const entry = this.repos.get(repo);
    entry?.watchers.delete(peer);
    const ids = new Set(this.terminalsOf(repo).map((t) => t.termId));
    for (const id of ids) this.terminals.get(id)?.process.detach(peer.id);
    this.showOnly(
      peer,
      [...peer.visible].filter((id) => !ids.has(id)),
    );
    if (entry?.watchers.size === 0) this.stopWatch(repo);
  }

  /** The watched repo of `peer` whose current list holds `worktree`. */
  private repoOfWorktree(peer: Peer, worktree: string): string {
    for (const repo of peer.watched) {
      if (this.repos.get(repo)?.watch.worktrees.some((w: Worktree) => w.path === worktree) === true) return repo;
    }
    throw new RequestError('unknown-worktree', `${worktree} is not a worktree of a watched repo`);
  }

  /** Removes state entries of `repo` for worktrees that are not listed and have no terminals. */
  private async prune(repo: string): Promise<void> {
    try {
      const listed = this.repos.get(repo)?.watch.worktrees ?? (await this.options.services.listWorktrees(repo));
      const keep = new Set([...listed.map((w) => w.path), ...this.terminalsOf(repo).map((t) => t.worktree)]);
      await this.options.store.prune(repo, keep);
    } catch (error) {
      this.options.report(error);
    }
  }

  // Terminals.

  private terminalsOf(repo: string): TermEntry[] {
    return [...this.terminals.values()].filter((t) => t.repo === repo);
  }

  private access(peer: Peer, termId: number): TermEntry {
    const term = this.terminals.get(termId);
    if (term === undefined) throw new RequestError('unknown-term', `no terminal ${String(termId)}`);
    if (!peer.watched.has(term.repo)) throw new RequestError('not-watched', `terminal ${String(termId)} is in an unwatched repo`);
    return term;
  }

  private async createTerm(peer: Peer, m: Extract<Correlated, { t: 'createTerm' }>): Promise<void> {
    const repo = this.repoOfWorktree(peer, m.worktree);
    if (this.terminalsOf(repo).length + (this.spawning.get(repo) ?? 0) >= MAX_TERMINALS) {
      throw new RequestError('busy', `${repo} has ${String(MAX_TERMINALS)} terminals`);
    }
    let termId = 0;
    const spawn = this.options.services.spawnTerminal(
      { cwd: m.worktree, command: m.command, cols: m.cols, rows: m.rows, env: this.options.env },
      {
        activity: (unseen, bell) => {
          this.broadcast(repo, { t: 'activity', termId, unseen, bell });
        },
        exited: (code, signal) => {
          this.broadcast(repo, { t: 'termExited', termId, code, signal });
        },
      },
    );
    increment(this.spawning, repo);
    this.spawns.add(spawn);
    let spawned: TerminalProcess;
    try {
      spawned = await spawn;
    } catch (error) {
      if (error instanceof SpawnError) throw new RequestError('spawn-failed', error.message);
      throw error;
    } finally {
      decrement(this.spawning, repo);
      this.spawns.delete(spawn);
    }
    termId = this.nextTermId++;
    const term: TermEntry = { termId, repo, worktree: m.worktree, preset: m.preset, process: spawned };
    this.terminals.set(termId, term);
    peer.send({ t: 'termCreated', req: m.req, term: describe(term) });
    this.broadcast(repo, { t: 'termCreated', req: null, term: describe(term) }, peer);
  }

  private async attach(peer: Peer, termId: number, req: number): Promise<void> {
    this.access(peer, termId);
    await peer.drained(FLOW_HIGH);
    if (peer.closed) return;
    const term = this.access(peer, termId);
    const sink: OutputSink = {
      snapshot: (offset, data) => {
        try {
          peer.sendData({ kind: 'snapshot', termId, offset, data });
        } catch (error) {
          this.options.report(error);
          term.process.detach(peer.id);
          peer.sendError('internal', 'snapshot does not fit a frame', req);
          return;
        }
        peer.send({ t: 'done', req });
      },
      output: (offset, data) => {
        peer.sendData({ kind: 'output', termId, offset, data });
      },
      superseded: () => {
        peer.send({ t: 'done', req });
      },
      lagging: () => {
        peer.send({ t: 'detached', termId, reason: 'lagging' });
      },
    };
    term.process.attach(peer.id, sink);
  }

  private async closeTerm(peer: Peer, termId: number): Promise<void> {
    const term = this.access(peer, termId);
    this.closeTerminal(term);
    const { repo, worktree } = term;
    const layout = this.options.store.layout(repo, worktree);
    const live = new Set(
      this.terminalsOf(repo)
        .filter((t) => t.worktree === worktree)
        .map((t) => t.termId),
    );
    const pruned = pruneLayout(layout, live);
    let failure: Error | null = null;
    if (JSON.stringify(pruned) !== JSON.stringify(layout)) {
      try {
        await this.options.store.setLayout(repo, worktree, pruned);
        this.broadcast(repo, { t: 'layoutChanged', worktree, layout: pruned });
      } catch (error) {
        this.options.report(error);
        failure = error instanceof Error ? error : new Error(String(error));
      }
    }
    this.broadcast(repo, { t: 'termClosed', termId });
    void this.prune(repo);
    if (failure !== null) throw new RequestError('internal', `terminal closed, but its layout could not be saved: ${failure.message}`);
  }

  /** Removes `term` and ends its process. */
  private closeTerminal(term: TermEntry): void {
    this.terminals.delete(term.termId);
    const reaped = term.process.close().finally(() => this.reaping.delete(reaped));
    this.reaping.add(reaped);
    for (const peer of this.peers) if (peer.visible.has(term.termId)) this.showOnly(peer, [...peer.visible]);
  }

  private input(peer: Peer, termId: number, data: Uint8Array): void {
    this.uncorrelated(peer, () => {
      if (!this.access(peer, termId).process.write(data)) throw new RequestError('busy', `terminal ${String(termId)} input is full`);
    });
  }

  private ack(peer: Peer, termId: number, offset: number): void {
    const term = this.terminals.get(termId);
    if (term?.process.ack(peer.id, offset) !== 'beyond') return;
    peer.sendError('bad-message', `ack beyond the output sent for terminal ${String(termId)}`);
    peer.end();
  }

  // Visibility and activity.

  private setVisible(peer: Peer, termIds: readonly number[]): void {
    this.showOnly(
      peer,
      termIds.filter((id) => {
        const term = this.terminals.get(id);
        return term !== undefined && peer.watched.has(term.repo);
      }),
    );
  }

  /** Sets `peer`'s visible terminals and updates every terminal whose visibility may change. */
  private showOnly(peer: Peer, termIds: readonly number[]): void {
    const affected = new Set([...peer.visible, ...termIds]);
    peer.visible = new Set(termIds.filter((id) => this.terminals.has(id)));
    for (const id of affected) {
      const term = this.terminals.get(id);
      if (term === undefined) continue;
      term.process.setVisible([...this.peers].some((p) => p.visible.has(id)));
    }
  }

  // State.

  private async setChecked(peer: Peer, worktree: string, checked: boolean): Promise<void> {
    const repo = this.repoOfWorktree(peer, worktree);
    await this.persist(this.options.store.setChecked(repo, worktree, checked));
    this.broadcast(repo, { t: 'checkedChanged', worktree, checked });
  }

  private async setLayout(peer: Peer, worktree: string, layout: Layout): Promise<void> {
    const repo = this.repoOfWorktree(peer, worktree);
    const live = new Set(
      this.terminalsOf(repo)
        .filter((t) => t.worktree === worktree)
        .map((t) => t.termId),
    );
    // Pruning keeps a layout unchanged exactly when every leaf is live.
    if (JSON.stringify(pruneLayout(layout, live)) !== JSON.stringify(layout)) {
      throw new RequestError('unknown-term', 'the layout holds a terminal that is not a live terminal of this worktree');
    }
    await this.persist(this.options.store.setLayout(repo, worktree, layout));
    this.broadcast(repo, { t: 'layoutChanged', worktree, layout });
  }

  private async persist(change: Promise<void>): Promise<void> {
    try {
      await change;
    } catch (error) {
      this.options.report(error);
      throw new RequestError('internal', `state could not be saved: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private disconnect(peer: Peer): void {
    this.peers.delete(peer);
    for (const repo of peer.watched) this.unsubscribe(peer, repo);
    for (const term of this.terminals.values()) term.process.detach(peer.id);
    this.showOnly(peer, []);
  }
}

const increment = (counts: Map<string, number>, key: string): void => {
  counts.set(key, (counts.get(key) ?? 0) + 1);
};

const decrement = (counts: Map<string, number>, key: string): void => {
  const left = (counts.get(key) ?? 1) - 1;
  if (left === 0) counts.delete(key);
  else counts.set(key, left);
};

const describe = (term: TermEntry): Terminal => ({
  termId: term.termId,
  worktree: term.worktree,
  preset: term.preset,
  cols: term.process.cols,
  rows: term.process.rows,
  exit: term.process.exit,
  unseen: term.process.unseen,
  bell: term.process.bell,
});
