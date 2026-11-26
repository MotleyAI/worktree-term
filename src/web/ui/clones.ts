import type { HostEntry } from '../../protocol/index.js';

/** A discovered repo the page watches as a clone. */
export interface WatchedClone {
  host: number;
  path: string;
  origin: string;
}

/** What clone discovery knows in a page session. */
export interface CloneState {
  /** Hosts whose discovery was sent. */
  readonly discovering: readonly number[];
  /** Each host's listed repos. */
  readonly listed: ReadonlyMap<number, readonly string[]>;
  /** The known origins of repos, by host and repo. */
  readonly origins: ReadonlyMap<number, ReadonlyMap<string, string | null>>;
  /** Each host's discovered repos. */
  readonly found: ReadonlyMap<number, readonly { path: string; origin: string | null }[]>;
  readonly watched: readonly WatchedClone[];
}

export type CloneAction =
  | { t: 'hosts'; hosts: readonly { idx: number; status: HostEntry['status']; repos: readonly string[] }[] }
  | { t: 'origin'; host: number; repo: string; origin: string | null }
  | { t: 'discovered'; host: number; repos: readonly { path: string; origin: string | null }[] };

export type CloneEffect = { t: 'discover'; host: number } | { t: 'watch'; host: number; path: string };

export const initialCloneState: CloneState = { discovering: [], listed: new Map(), origins: new Map(), found: new Map(), watched: [] };

/** The non-null origins of repos their host lists. */
const listedOrigins = (state: CloneState): Set<string> => {
  const origins = new Set<string>();
  for (const [host, repos] of state.listed) {
    for (const repo of repos) {
      const origin = state.origins.get(host)?.get(repo);
      if (origin !== undefined && origin !== null) origins.add(origin);
    }
  }
  return origins;
};

/** Watches every found repo its host does not list whose origin a listed repo has, once per (host, path). */
const matched = (state: CloneState): { state: CloneState; effects: CloneEffect[] } => {
  const origins = listedOrigins(state);
  const watched = [...state.watched];
  const effects: CloneEffect[] = [];
  for (const [host, repos] of state.found) {
    const listed = state.listed.get(host) ?? [];
    for (const { path, origin } of repos) {
      if (origin === null || !origins.has(origin) || listed.includes(path)) continue;
      if (watched.some((w) => w.host === host && w.path === path)) continue;
      watched.push({ host, path, origin });
      effects.push({ t: 'watch', host, path });
    }
  }
  return { state: { ...state, watched }, effects };
};

/** Clone discovery after `action`: every host discovered once, at its first connection, and matching clones watched once. */
export const cloneStep = (state: CloneState, action: CloneAction): { state: CloneState; effects: CloneEffect[] } => {
  switch (action.t) {
    case 'hosts': {
      const fresh = action.hosts.filter((h) => h.status === 'connected' && !state.discovering.includes(h.idx)).map((h) => h.idx);
      const next: CloneState = {
        ...state,
        discovering: [...state.discovering, ...fresh],
        listed: new Map(action.hosts.map((h) => [h.idx, h.repos])),
      };
      const step = matched(next);
      return { state: step.state, effects: [...fresh.map((host) => ({ t: 'discover', host }) as const), ...step.effects] };
    }
    case 'origin': {
      const origins = new Map(state.origins);
      origins.set(action.host, new Map(origins.get(action.host)).set(action.repo, action.origin));
      return matched({ ...state, origins });
    }
    case 'discovered':
      return matched({ ...state, found: new Map(state.found).set(action.host, action.repos) });
  }
};
