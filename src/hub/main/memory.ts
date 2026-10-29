import {
  summarise,
  type OwnCgroup,
  type ProcessGroup,
  type ProcessInfo,
  type ProcessLookup,
  type SelfMemory,
  type SystemMemory,
} from '../../platform/memory/index.js';

const GROUP_TOP = 5;

export interface HubSampleInput {
  ts: string;
  pid: number;
  instance: string;
  version: string;
  intervalMs: number;
  self: SelfMemory;
  /** The command the hub starts its daemon with; that process and its descendants are the daemon's to log. */
  daemonCommand: readonly string[];
  /** The current user's processes; null without a process table. */
  table: readonly ProcessInfo[] | null;
  cgroup: OwnCgroup | null;
  system: SystemMemory;
  lookup: ProcessLookup;
}

export interface HubRecord {
  ts: string;
  source: 'hub';
  pid: number;
  instance: string;
  version: string;
  intervalMs: number;
  self: SelfMemory;
  children: ProcessGroup | null;
  cgroup: (Omit<OwnCgroup, 'pids'> & { others: ProcessGroup | null }) | null;
  system: SystemMemory;
}

const sameArgs = (a: readonly string[] | null, b: readonly string[]): boolean =>
  a !== null && a.length === b.length && a.every((arg, i) => arg === b[i]);

/** Descendants of the hub by parent pid, without the subtree of a process running the daemon command. */
const childrenOf = async (input: HubSampleInput, table: readonly ProcessInfo[]): Promise<ProcessInfo[]> => {
  const byParent = new Map<number, ProcessInfo[]>();
  for (const p of table) byParent.set(p.ppid, [...(byParent.get(p.ppid) ?? []), p]);
  const children: ProcessInfo[] = [];
  const seen = new Set<number>([input.pid]);
  const pending = [input.pid];
  for (let pid = pending.pop(); pid !== undefined; pid = pending.pop()) {
    for (const child of byParent.get(pid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      if (sameArgs(await input.lookup.args(child.pid), input.daemonCommand)) continue; // NOSONAR(S9382) — walks the tree in order
      children.push(child);
      pending.push(child.pid);
    }
  }
  return children;
};

/** The hub's memory log record. */
export const hubRecord = async (input: HubSampleInput): Promise<HubRecord> => {
  const { table, cgroup, lookup } = input;
  const children = table === null ? null : await childrenOf(input, table);
  let cgroupRecord: HubRecord['cgroup'] = null;
  if (cgroup !== null) {
    const { pids, ...figures } = cgroup;
    let others: ProcessGroup | null = null;
    if (table !== null && children !== null) {
      const members = new Set(pids);
      const excluded = new Set([input.pid, ...children.map((p) => p.pid)]);
      others = await summarise(
        table.filter((p) => members.has(p.pid) && !excluded.has(p.pid)),
        GROUP_TOP,
        lookup.command,
      );
    }
    cgroupRecord = { ...figures, others };
  }
  return {
    ts: input.ts,
    source: 'hub',
    pid: input.pid,
    instance: input.instance,
    version: input.version,
    intervalMs: input.intervalMs,
    self: input.self,
    children: children === null ? null : await summarise(children, GROUP_TOP, lookup.command),
    cgroup: cgroupRecord,
    system: input.system,
  };
};
