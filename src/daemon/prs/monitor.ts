import type { PrStatus, Worktree } from '../../protocol/index.js';
import type { FailureClass, Fetch, FetchOutcome } from './github.js';

const DEFAULT_INTERVAL_MS = 60_000;
/** Longest delay a timer takes as given. */
const MAX_TIMER_MS = 2 ** 31 - 1;
/** Most refreshes running at a time. */
const MAX_RUNNING = 4;

/** The refresh interval `WTD_PR_INTERVAL_MS` asks for when it is a positive integer, capped at the longest timer, else 60 s. */
export const prIntervalMs = (value = ''): number => {
  const ms = /^\d+$/.test(value) ? Number(value) : 0;
  return ms > 0 ? Math.min(ms, MAX_TIMER_MS) : DEFAULT_INTERVAL_MS;
};

export interface PrWatch {
  /** The repo's current worktrees; a changed set of paths with their branches refreshes. */
  update: (worktrees: readonly Worktree[]) => void;
  close: () => void;
}

export interface Prs {
  /** Refreshes `repo` now and every interval until closed; `changed` gets each new status list. */
  watch: (repo: string, worktrees: readonly Worktree[], changed: (prs: PrStatus[]) => void) => PrWatch;
  /** The last successful statuses of `repo`, or null before one. */
  cached: (repo: string) => PrStatus[] | null;
  /** Stops every refresh, kills their processes and settles once they ended. */
  close: () => Promise<void>;
}

export interface PrsOptions {
  fetch: Fetch;
  intervalMs: number;
  log: (line: string) => void;
}

interface Watcher {
  changed: (prs: PrStatus[]) => void;
}

interface RepoState {
  worktrees: readonly Worktree[];
  branchSet: string;
  watchers: Set<Watcher>;
  timer: ReturnType<typeof setInterval> | null;
  running: boolean;
  /** A refresh was asked for while one ran. */
  again: boolean;
  waiting: boolean;
  cache: PrStatus[] | null;
  /** Failure classes logged since the last success. */
  logged: Set<FailureClass>;
}

const branchSetOf = (worktrees: readonly Worktree[]): string =>
  JSON.stringify(worktrees.map((w) => [w.path, w.branch]).sort(([a], [b]) => (a ?? '').localeCompare(b ?? '')));

/** Pull request statuses per repo, refreshed while watched, at most MAX_RUNNING at a time. */
export const createPrs = ({ fetch, intervalMs, log }: PrsOptions): Prs => {
  const repos = new Map<string, RepoState>();
  const queue: string[] = [];
  const inFlight = new Set<Promise<void>>();
  const abort = new AbortController();
  let closed = false;

  const stateOf = (repo: string, worktrees: readonly Worktree[]): RepoState => {
    let state = repos.get(repo);
    if (state === undefined) {
      state = {
        worktrees,
        branchSet: branchSetOf(worktrees),
        watchers: new Set(),
        timer: null,
        running: false,
        again: false,
        waiting: false,
        cache: null,
        logged: new Set(),
      };
      repos.set(repo, state);
    }
    return state;
  };

  const finish = (repo: string, state: RepoState, outcome: FetchOutcome): void => {
    state.running = false;
    if (closed) return;
    if (outcome.ok) {
      state.logged.clear();
      if (state.cache === null || JSON.stringify(state.cache) !== JSON.stringify(outcome.prs)) {
        state.cache = outcome.prs;
        for (const watcher of state.watchers) watcher.changed(outcome.prs);
      }
    } else if (!state.logged.has(outcome.failure)) {
      state.logged.add(outcome.failure);
      log(`pull requests of ${repo}: refresh failed (${outcome.failure})`);
    }
    if (state.again) {
      state.again = false;
      if (state.watchers.size > 0) request(repo, state);
    }
    pump();
  };

  const start = (repo: string, state: RepoState): void => {
    state.running = true;
    const done = fetch(repo, state.worktrees, abort.signal)
      .catch((error: unknown): FetchOutcome => {
        if (!closed) log(`pull requests of ${repo}: ${error instanceof Error ? error.message : String(error)}`);
        return { ok: false, failure: 'exit' };
      })
      .then((outcome) => {
        inFlight.delete(done);
        finish(repo, state, outcome);
      });
    inFlight.add(done);
  };

  const pump = (): void => {
    while (!closed && inFlight.size < MAX_RUNNING && queue.length > 0) {
      const repo = queue.shift();
      const state = repo === undefined ? undefined : repos.get(repo);
      if (repo === undefined || state === undefined) continue;
      state.waiting = false;
      if (state.watchers.size > 0) start(repo, state);
    }
  };

  const request = (repo: string, state: RepoState): void => {
    if (closed || state.waiting) return;
    if (state.running) {
      state.again = true;
      return;
    }
    state.waiting = true;
    queue.push(repo);
    pump();
  };

  const tick = (repo: string, state: RepoState): void => {
    if (!state.running) request(repo, state);
  };

  return {
    watch: (repo, worktrees, changed) => {
      if (closed) return { update: () => undefined, close: () => undefined };
      const state = stateOf(repo, worktrees);
      const watcher: Watcher = { changed };
      state.watchers.add(watcher);
      state.worktrees = worktrees;
      state.branchSet = branchSetOf(worktrees);
      state.timer ??= setInterval(() => {
        tick(repo, state);
      }, intervalMs);
      state.timer.unref();
      request(repo, state);
      let open = true;
      return {
        update: (next) => {
          if (!open || closed) return;
          state.worktrees = next;
          const branchSet = branchSetOf(next);
          if (branchSet === state.branchSet) return;
          state.branchSet = branchSet;
          request(repo, state);
        },
        close: () => {
          if (!open) return;
          open = false;
          state.watchers.delete(watcher);
          if (state.watchers.size > 0 || state.timer === null) return;
          clearInterval(state.timer);
          state.timer = null;
        },
      };
    },
    cached: (repo) => repos.get(repo)?.cache ?? null,
    close: async () => {
      closed = true;
      queue.length = 0;
      for (const state of repos.values()) {
        if (state.timer !== null) clearInterval(state.timer);
        state.timer = null;
      }
      abort.abort();
      await Promise.all(inFlight);
    },
  };
};
