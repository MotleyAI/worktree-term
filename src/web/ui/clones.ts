import type { HostEntry } from '../../protocol/index.js';

/** A discovered repo the page watches as a clone. */
export interface WatchedClone {
  host: number;
  path: string;
  origin: string;
}

/** What clone discovery knows in a page session. */
export interface CloneState {
  /** Hosts whose discovery was sent and did not fail. */
  readonly discovering: readonly number[];
  /** Hosts whose discovery failed while they are still connected; discovered again once they reconnect. */
  readonly failed: readonly number[];
  /** Each host's listed repos. */
  readonly listed: ReadonlyMap<number, readonly string[]>;
  /** The known origins of repos, by host and repo. */
  readonly origins: ReadonlyMap<number, ReadonlyMap<string, string | null>>;
  /** Each host's discovered repos. */
  readonly found: ReadonlyMap<number, readonly { path: string; origin: string | null }[]>;
  readonly watched: readonly WatchedClone[];
  /** The name each host index last had. */
  readonly names: ReadonlyMap<number, string>;
  /** The hosts the latest hosts update showed connected. */
  readonly connected: readonly number[];
}

export type CloneAction =
  | { t: 'hosts'; hosts: readonly { idx: number; name: string; status: HostEntry['status']; repos: readonly string[] }[] }
  | { t: 'origin'; host: number; repo: string; origin: string | null }
  | { t: 'discovered'; host: number; name: string; repos: readonly { path: string; origin: string | null }[] }
  | { t: 'failed'; host: number; name: string };

export type CloneEffect = { t: 'discover'; host: number } | { t: 'watch'; host: number; path: string };

export const initialCloneState: CloneState = {
  discovering: [],
  failed: [],
  listed: new Map(),
  origins: new Map(),
  found: new Map(),
  watched: [],
  names: new Map(),
  connected: [],
};

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

/** `state` without what it knew of the hosts at `moved`, each index now naming another host. */
const forget = (state: CloneState, moved: ReadonlySet<number>): CloneState =>
  moved.size === 0
    ? state
    : {
        ...state,
        discovering: state.discovering.filter((h) => !moved.has(h)),
        failed: state.failed.filter((h) => !moved.has(h)),
        origins: new Map([...state.origins].filter(([h]) => !moved.has(h))),
        found: new Map([...state.found].filter(([h]) => !moved.has(h))),
        watched: state.watched.filter((w) => !moved.has(w.host)),
      };

/** Clone discovery after `action`: every host discovered once, at its first connection or the next after a failure, and matching clones watched once. */
export const cloneStep = (state: CloneState, action: CloneAction): { state: CloneState; effects: CloneEffect[] } => {
  switch (action.t) {
    case 'hosts': {
      const moved = new Set(action.hosts.filter((h) => (state.names.get(h.idx) ?? h.name) !== h.name).map((h) => h.idx));
      const known = forget(state, moved);
      const connected = (idx: number): boolean => action.hosts.some((h) => h.idx === idx && h.status === 'connected');
      const failed = known.failed.filter(connected);
      const fresh = action.hosts
        .filter((h) => h.status === 'connected' && !known.discovering.includes(h.idx) && !failed.includes(h.idx))
        .map((h) => h.idx);
      const next: CloneState = {
        ...known,
        discovering: [...known.discovering, ...fresh],
        failed,
        listed: new Map(action.hosts.map((h) => [h.idx, h.repos])),
        names: new Map([...known.names, ...action.hosts.map((h) => [h.idx, h.name] as const)]),
        connected: action.hosts.filter((h) => h.status === 'connected').map((h) => h.idx),
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
      if (state.names.get(action.host) !== action.name) return { state, effects: [] };
      return matched({ ...state, found: new Map(state.found).set(action.host, action.repos) });
    case 'failed': {
      if (state.names.get(action.host) !== action.name) return { state, effects: [] };
      const discovering = state.discovering.filter((h) => h !== action.host);
      // A host that dropped meanwhile is discovered again on its next connection.
      const failed = state.connected.includes(action.host) ? [...state.failed, action.host] : state.failed;
      return { state: { ...state, discovering, failed }, effects: [] };
    }
  }
};
