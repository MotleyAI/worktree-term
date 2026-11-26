import { uniqueLabels } from './labels.js';

/** A repo of a host with its origin; null when it has none or the page does not know it yet. */
export interface OriginRepo {
  path: string;
  origin: string | null;
}

/** A host as grouping sees it: its listed repos and the discovered clones the page watches there. */
export interface GroupHost {
  idx: number;
  name: string;
  remote: boolean;
  repos: readonly OriginRepo[];
  clones: readonly OriginRepo[];
}

/** One repo of a group: listed by its host, or a discovered clone. */
export interface GroupMember {
  host: number;
  repo: string;
  listed: boolean;
  /** Its path, prefixed `<host>:` for a remote host. */
  name: string;
}

/** One repo tab: the repos of one origin, or a listed repo of its own; labelled and keyed by its first listed member. */
export interface RepoGroup {
  /** `origin:<origin>`, or `<host name>:<repo>` for a repo of its own. */
  key: string;
  label: string;
  /** The first listed member. */
  host: number;
  repo: string;
  /** One line per member, as its `name`. */
  title: string;
  members: GroupMember[];
}

/** `path` as the page shows it: prefixed `<host>:` for a remote host. */
export const hostPath = (host: { name: string; remote: boolean }, path: string): string => (host.remote ? `${host.name}:${path}` : path);

const byCodeUnits = (a: string, b: string): number => {
  if (a === b) return 0;
  return a < b ? -1 : 1;
};

/** The repo tabs of `hosts` in hub order: listed repos grouped by origin, discovered clones joining their origin's group. */
export const repoGroups = (hosts: readonly GroupHost[]): RepoGroup[] => {
  const groups = new Map<string, Omit<RepoGroup, 'title'>>();
  const keyOf = (host: GroupHost, repo: OriginRepo): string =>
    repo.origin === null ? `${host.name}:${repo.path}` : `origin:${repo.origin}`;
  const add = (group: Omit<RepoGroup, 'title'>, member: GroupMember): void => {
    if (!group.members.some((m) => m.host === member.host && m.repo === member.repo)) group.members.push(member);
  };
  for (const host of hosts) {
    const labels = uniqueLabels(host.repos.map((r) => r.path));
    host.repos.forEach((repo, i) => {
      const key = keyOf(host, repo);
      const member = { host: host.idx, repo: repo.path, listed: true, name: hostPath(host, repo.path) };
      let group = groups.get(key);
      if (group === undefined) {
        const label = `${host.remote ? `${host.name}:` : ''}${labels[i] ?? repo.path}`;
        group = { key, label, host: host.idx, repo: repo.path, members: [] };
        groups.set(key, group);
      }
      add(group, member);
    });
  }
  for (const host of hosts) {
    for (const clone of host.clones) {
      const group = clone.origin === null ? undefined : groups.get(`origin:${clone.origin}`);
      if (group !== undefined) add(group, { host: host.idx, repo: clone.path, listed: false, name: hostPath(host, clone.path) });
    }
  }
  const rank = (idx: number): number => {
    const at = hosts.findIndex((h) => h.idx === idx);
    return hosts[at]?.remote === false ? -1 : at;
  };
  return [...groups.values()].map((group) => {
    const members = [...group.members].sort((a, b) => rank(a.host) - rank(b.host) || byCodeUnits(a.repo, b.repo));
    return { ...group, members, title: members.map((m) => m.name).join('\n') };
  });
};

/** What removing a group's tab names and removes: its listed members, never its discovered clones. */
export const groupRemoval = (group: RepoGroup): { names: string[]; members: { host: number; repo: string }[] } => {
  const listed = group.members.filter((m) => m.listed);
  return { names: listed.map((m) => m.name), members: listed.map((m) => ({ host: m.host, repo: m.repo })) };
};
