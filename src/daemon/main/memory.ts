import {
  summarise,
  type OwnCgroup,
  type ProcessGroup,
  type ProcessInfo,
  type ProcessLookup,
  type SelfMemory,
  type SystemMemory,
} from '../../platform/memory/index.js';
import type { ClosedTerminalView, LiveTerminalView, MemoryView } from '../server/index.js';

/** Bytes per mirror cell: xterm stores three 32-bit words. */
const CELL_BYTES = 12;
const TERMINAL_TOP = 3;
const GROUP_TOP = 5;
const MAX_ESCAPED = 20;

export interface DaemonSampleInput {
  ts: string;
  pid: number;
  instance: string;
  version: string;
  intervalMs: number;
  self: SelfMemory;
  view: MemoryView;
  /** The current user's processes; null without a process table. */
  table: readonly ProcessInfo[] | null;
  cgroup: OwnCgroup | null;
  system: SystemMemory;
  lookup: ProcessLookup;
}

export interface TerminalRecord {
  termId: number;
  repo: string;
  worktree: string;
  preset: string;
  pid: number;
  mirror: { lines: number; cols: number; bytes: number };
  members: ProcessGroup | null;
  detached: ProcessGroup | null;
}

export interface EscapedGroup extends ProcessGroup {
  tag: string;
  termId: number | null;
  /** Set when this daemon instance closed the terminal. */
  worktree: string | null;
  preset: string | null;
}

export interface DaemonRecord {
  ts: string;
  source: 'daemon';
  pid: number;
  instance: string;
  version: string;
  intervalMs: number;
  self: SelfMemory;
  mirrors: { count: number; bytes: number };
  terminals: TerminalRecord[];
  escaped: EscapedGroup[] | null;
  escapedOmitted: { groups: number; processes: number; rss: number; anon: number } | null;
  cgroup: (Omit<OwnCgroup, 'pids'> & { others: ProcessGroup | null }) | null;
  system: SystemMemory;
}

interface ParsedTag {
  pid: number;
  instance: string;
  termId: number;
}

const parseTag = (tag: string): ParsedTag | null => {
  const match = /^(\d+)\/([^/]+)\/(\d+)$/.exec(tag);
  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) return null;
  return { pid: Number(match[1]), instance: match[2], termId: Number(match[3]) };
};

/** Whether `args` run a wtd daemon: last argument `daemon`, an argument whose basename starts with `wtd`. */
const isWtdDaemon = (args: readonly string[] | null): boolean =>
  args !== null && args.at(-1) === 'daemon' && args.some((arg) => (arg.split('/').at(-1) ?? '').startsWith('wtd'));

const mirrorBytes = ({ lines, cols }: { lines: number; cols: number }): number => lines * cols * CELL_BYTES;

/** Pids of `table` descending, by parent pid, from `root`. */
const descendants = (table: readonly ProcessInfo[], root: number): Set<number> => {
  const children = new Map<number, number[]>();
  for (const p of table) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p.pid]);
  const found = new Set<number>();
  const pending = [root];
  for (let pid = pending.pop(); pid !== undefined; pid = pending.pop()) {
    for (const child of children.get(pid) ?? []) {
      if (found.has(child)) continue;
      found.add(child);
      pending.push(child);
    }
  }
  return found;
};

interface Placement {
  members: Map<number, ProcessInfo[]>;
  detached: Map<number, ProcessInfo[]>;
  escaped: Map<string, ProcessInfo[]>;
  /** Pids placed by any rule, foreign daemons' included. */
  placed: Set<number>;
  /** Closed terminals some process was attributed to. */
  found: Set<number>;
}

/** Places each process of `table` by the first rule that applies; see the daemon memory log spec. */
const place = async (input: DaemonSampleInput, table: readonly ProcessInfo[]): Promise<Placement> => {
  const { pid: self, instance, view, lookup } = input;
  const ownTag = (termId: number): string => `${String(self)}/${instance}/${String(termId)}`;
  const live = new Map(view.terminals.map((t) => [t.termId, t]));
  const closedById = new Map(view.closed.map((t) => [t.termId, t]));
  const closedBySession = new Map(view.closed.map((t) => [t.pid, t]));
  const trees = view.terminals.map((t) => ({ termId: t.termId, shell: t.pid, tree: descendants(table, t.pid) }));
  const result: Placement = {
    members: new Map(view.terminals.map((t) => [t.termId, []])),
    detached: new Map(view.terminals.map((t) => [t.termId, []])),
    escaped: new Map(),
    placed: new Set(),
    found: new Set(),
  };
  const daemons = new Map<number, Promise<boolean>>();
  const runsDaemon = (pid: number): Promise<boolean> => {
    let known = daemons.get(pid);
    if (known === undefined) {
      known = lookup.args(pid).then(isWtdDaemon);
      daemons.set(pid, known);
    }
    return known;
  };
  const escape = (tag: string, p: ProcessInfo): void => {
    result.escaped.set(tag, [...(result.escaped.get(tag) ?? []), p]);
    result.placed.add(p.pid);
  };

  for (const p of table) {
    if (p.pid === self) continue;
    const member = trees.find((t) => p.sid === t.shell || p.pid === t.shell || t.tree.has(p.pid));
    if (member !== undefined) {
      result.members.get(member.termId)?.push(p);
      result.placed.add(p.pid);
      continue;
    }
    const tag = await lookup.tag(p.pid); // NOSONAR(S9382) — one environ read at a time
    const parsed = tag === null ? null : parseTag(tag);
    if (parsed !== null && parsed.pid === self && parsed.instance === instance && live.has(parsed.termId)) {
      result.detached.get(parsed.termId)?.push(p);
      result.placed.add(p.pid);
      continue;
    }
    if (parsed !== null && parsed.pid !== self && (await runsDaemon(parsed.pid))) {
      result.placed.add(p.pid);
      continue;
    }
    if (tag !== null) {
      if (parsed !== null && parsed.pid === self && parsed.instance === instance) result.found.add(parsed.termId);
      escape(tag, p);
      continue;
    }
    const session = closedBySession.get(p.sid);
    if (session !== undefined) {
      result.found.add(session.termId);
      escape(ownTag(session.termId), p);
    }
  }
  for (const termId of result.found) if (!closedById.has(termId)) result.found.delete(termId);
  return result;
};

const terminalRecord = (t: LiveTerminalView, members: ProcessGroup | null, detached: ProcessGroup | null): TerminalRecord => ({
  termId: t.termId,
  repo: t.repo,
  worktree: t.worktree,
  preset: t.preset,
  pid: t.pid,
  mirror: { ...t.mirror, bytes: mirrorBytes(t.mirror) },
  members,
  detached,
});

const escapedGroups = async (
  input: DaemonSampleInput,
  escaped: Map<string, ProcessInfo[]>,
): Promise<{ groups: EscapedGroup[]; omitted: NonNullable<DaemonRecord['escapedOmitted']> }> => {
  const closed = new Map<number, ClosedTerminalView>(input.view.closed.map((t) => [t.termId, t]));
  const ranked = [...escaped]
    .map(([tag, members]) => ({ tag, members, rss: members.reduce((sum, p) => sum + p.rss, 0) }))
    .sort((a, b) => b.rss - a.rss);
  const kept = ranked.slice(0, MAX_ESCAPED);
  const rest = ranked.slice(MAX_ESCAPED).flatMap((g) => g.members);
  const groups = await Promise.all(
    kept.map(async ({ tag, members }): Promise<EscapedGroup> => {
      const parsed = parseTag(tag);
      const ours =
        parsed !== null && parsed.pid === input.pid && parsed.instance === input.instance ? closed.get(parsed.termId) : undefined;
      return {
        tag,
        termId: parsed?.termId ?? null,
        worktree: ours?.worktree ?? null,
        preset: ours?.preset ?? null,
        ...(await summarise(members, GROUP_TOP, input.lookup.command)),
      };
    }),
  );
  return {
    groups,
    omitted: {
      groups: ranked.length - kept.length,
      processes: rest.length,
      rss: rest.reduce((sum, p) => sum + p.rss, 0),
      anon: rest.reduce((sum, p) => sum + p.anon, 0),
    },
  };
};

/** The daemon's memory log record, and the closed terminals none of whose processes remain. */
export const daemonRecord = async (input: DaemonSampleInput): Promise<{ record: DaemonRecord; gone: number[] }> => {
  const { view, table, cgroup, lookup } = input;
  const placement = table === null ? null : await place(input, table);
  const group = (members: readonly ProcessInfo[] | undefined, n: number): Promise<ProcessGroup | null> =>
    members === undefined ? Promise.resolve(null) : summarise(members, n, lookup.command);
  const terminals = await Promise.all(
    view.terminals.map(async (t) =>
      terminalRecord(
        t,
        await group(placement?.members.get(t.termId), TERMINAL_TOP),
        await group(placement?.detached.get(t.termId), TERMINAL_TOP),
      ),
    ),
  );
  const escaped = placement === null ? null : await escapedGroups(input, placement.escaped);
  let cgroupRecord: DaemonRecord['cgroup'] = null;
  if (cgroup !== null) {
    const { pids, ...figures } = cgroup;
    let others: ProcessGroup | null = null;
    if (table !== null && placement !== null) {
      const members = new Set(pids);
      const rest = table.filter((p) => members.has(p.pid) && p.pid !== input.pid && !placement.placed.has(p.pid));
      others = await summarise(rest, GROUP_TOP, lookup.command);
    }
    cgroupRecord = { ...figures, others };
  }
  const record: DaemonRecord = {
    ts: input.ts,
    source: 'daemon',
    pid: input.pid,
    instance: input.instance,
    version: input.version,
    intervalMs: input.intervalMs,
    self: input.self,
    mirrors: { count: view.terminals.length, bytes: view.terminals.reduce((sum, t) => sum + mirrorBytes(t.mirror), 0) },
    terminals,
    escaped: escaped?.groups ?? null,
    escapedOmitted: escaped?.omitted ?? null,
    cgroup: cgroupRecord,
    system: input.system,
  };
  const gone = placement === null ? [] : view.closed.map((t) => t.termId).filter((termId) => !placement.found.has(termId));
  return { record, gone };
};
