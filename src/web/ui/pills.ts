import type { HostEntry } from '../../protocol/index.js';
import { statusText } from './hosts.js';
import { uniqueLabels } from './labels.js';

/** A host as its pills show it. */
export interface PillHost {
  idx: number;
  name: string;
  remote: boolean;
  status: HostEntry['status'];
}

/** The pill after a worktree row's label. */
export interface Pill {
  text: string;
  /** The hue of the host's colour, from its name alone. */
  hue: number;
  /** A local clone's pill, shown muted. */
  muted: boolean;
  look: 'normal' | 'dimmed' | 'error';
  title: string;
}

const HUES = 360;

/** A whole hue in [0, 360) derived from the host name alone. */
export const hostHue = (name: string): number => {
  let hash = 0x811c9dc5;
  for (const char of name) hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), 0x01000193) >>> 0;
  return hash % HUES;
};

/** Labels clones by directory name, adding leading segments until they are unique. */
export const cloneLabels = (paths: readonly string[]): string[] => uniqueLabels(paths);

const lookOf = (status: HostEntry['status']): Pill['look'] => {
  if (status === 'connecting' || status === 'reconnecting') return 'dimmed';
  return status === 'connected' ? 'normal' : 'error';
};

/** The pill of a row of `host`'s clone `repo` in a tab of `members`; null for a tab's only local clone. */
export const rowPill = (host: PillHost, repo: string, members: readonly { host: number; repo: string }[]): Pill | null => {
  const clones = members.filter((m) => m.host === host.idx).map((m) => m.repo);
  const several = clones.length > 1;
  if (!host.remote && !several) return null;
  const clone = several ? (cloneLabels(clones)[clones.indexOf(repo)] ?? repo) : null;
  let text = host.name;
  if (clone !== null) text = host.remote ? `${host.name} · ${clone}` : clone;
  return {
    text,
    hue: hostHue(host.name),
    muted: !host.remote,
    look: lookOf(host.status),
    title: `${host.name}: ${statusText(host.status)}`,
  };
};
