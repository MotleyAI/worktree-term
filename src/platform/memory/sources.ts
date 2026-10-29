import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Where the memory sources are read from, and whose processes count. */
export interface MemoryRoots {
  proc: string;
  cgroup: string;
  uid: number;
}

export interface ProcessInfo {
  pid: number;
  ppid: number;
  sid: number;
  /** `VmRSS` in bytes. */
  rss: number;
  /** `RssAnon` in bytes. */
  anon: number;
}

export interface PressureFigures {
  avg10: number;
  avg60: number;
  avg300: number;
}

export interface Pressure {
  some: PressureFigures;
  full: PressureFigures;
}

/** `/proc/meminfo` figures in bytes. */
export interface Meminfo {
  total: number;
  available: number;
  swapTotal: number;
  swapFree: number;
}

export interface SystemMemory {
  pressure: Pressure | null;
  meminfo: Meminfo | null;
}

/** The own cgroup v2's figures in bytes; null where a file is absent or `max`. */
export interface OwnCgroup {
  path: string;
  current: number;
  peak: number | null;
  max: number | null;
  high: number | null;
  swapCurrent: number | null;
  pressure: Pressure | null;
  pids: number[];
}

/** Per-process details read on request; null when the process is gone or unreadable. */
export interface ProcessLookup {
  /** Its `WTD_TERMINAL` environment value. */
  tag: (pid: number) => Promise<string | null>;
  args: (pid: number) => Promise<readonly string[] | null>;
  /** Its arguments joined by spaces, at most 200 characters. */
  command: (pid: number) => Promise<string | null>;
}

export type Report = (error: unknown) => void;

const KiB = 1024;
const COMMAND_CHARS = 200;
/** Processes read at a time; each procfs read takes a 64 KiB buffer, so this bounds a sample's footprint. */
const READ_BATCH = 8;
const TAG = 'WTD_TERMINAL=';

/** Content that does not parse; a failure of its source. */
class MalformedError extends Error {
  override readonly name = 'MalformedError';

  constructor(path: string, what: string) {
    super(`malformed ${path}: ${what}`);
  }
}

const codeOf = (error: unknown): unknown => (error instanceof Error && 'code' in error ? error.code : undefined);

/** Absent or unreadable: the expected state where a source does not exist. */
const isAbsent = (error: unknown): boolean => codeOf(error) === 'ENOENT' || codeOf(error) === 'EACCES' || codeOf(error) === 'ENOTDIR';

/** Gone while being read. */
const isGone = (error: unknown): boolean => isAbsent(error) || codeOf(error) === 'ESRCH';

/** The roots of this host and user. */
export const hostRoots = (): MemoryRoots => ({ proc: '/proc', cgroup: '/sys/fs/cgroup', uid: process.getuid?.() ?? -1 });

/** Runs a source: null silently when absent, null and reported on any other failure. */
const source = async <T>(read: () => Promise<T | null>, report: Report): Promise<T | null> => {
  try {
    return await read();
  } catch (error) {
    if (!isAbsent(error)) report(error);
    return null;
  }
};

/** The content of `path`, or null when absent. */
const readOptional = async (path: string): Promise<string | null> => {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isAbsent(error)) return null;
    throw error;
  }
};

const integer = (text: string, path: string, what: string): number => {
  if (!/^\d+$/.test(text)) throw new MalformedError(path, what);
  return Number(text);
};

/** The kB figure on `key`'s line of a `status` or `meminfo` text in bytes; null without the line. */
const kibLine = (text: string, key: string, path: string): number | null => {
  const line = text.split('\n').find((l) => l.startsWith(`${key}:`));
  if (line === undefined) return null;
  const match = /^\S+:\s+(\d+) kB$/.exec(line);
  if (match?.[1] === undefined) throw new MalformedError(path, key);
  return Number(match[1]) * KiB;
};

const parseStatus = (text: string, path: string): { uid: number; rss: number; anon: number } => {
  const uid = /^Uid:\t(\d+)\t/m.exec(text)?.[1];
  if (uid === undefined) throw new MalformedError(path, 'Uid');
  return { uid: Number(uid), rss: kibLine(text, 'VmRSS', path) ?? 0, anon: kibLine(text, 'RssAnon', path) ?? 0 };
};

/** Parent pid and session id from a `stat` text, read after the command name. */
const parseStat = (text: string, path: string): { ppid: number; sid: number } => {
  const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
  return { ppid: integer(fields[1] ?? '', path, 'ppid'), sid: integer(fields[3] ?? '', path, 'session') };
};

/** One process of the user, or null when it is another user's or gone. */
const readProcess = async (roots: MemoryRoots, pid: number): Promise<ProcessInfo | null> => {
  const dir = join(roots.proc, String(pid));
  try {
    const statusPath = join(dir, 'status');
    const status = parseStatus(await readFile(statusPath, 'utf8'), statusPath);
    if (status.uid !== roots.uid) return null;
    const statPath = join(dir, 'stat');
    const { ppid, sid } = parseStat(await readFile(statPath, 'utf8'), statPath);
    return { pid, ppid, sid, rss: status.rss, anon: status.anon };
  } catch (error) {
    if (isGone(error)) return null;
    throw error;
  }
};

/** Every process of `roots.uid`; null without a readable `/proc`. */
export const readProcessTable = (roots: MemoryRoots, report: Report): Promise<ProcessInfo[] | null> =>
  source(async () => {
    const pids = (await readdir(roots.proc)).filter((name) => /^\d+$/.test(name)).map(Number);
    const table: ProcessInfo[] = [];
    for (let i = 0; i < pids.length; i += READ_BATCH) {
      const batch = await Promise.all(pids.slice(i, i + READ_BATCH).map((pid) => readProcess(roots, pid))); // NOSONAR(S9382) — bounded batches
      for (const entry of batch) if (entry !== null) table.push(entry);
    }
    return table;
  }, report);

/** Reads of single processes' environment and command line. */
export const processLookup = (roots: MemoryRoots): ProcessLookup => {
  const read = async (pid: number, name: string): Promise<string | null> => {
    try {
      return await readFile(join(roots.proc, String(pid), name), 'utf8');
    } catch (error) {
      if (isGone(error)) return null;
      throw error;
    }
  };
  const args = async (pid: number): Promise<string[] | null> => {
    const text = await read(pid, 'cmdline');
    if (text === null) return null;
    const parts = text.split('\0');
    if (parts.at(-1) === '') parts.pop();
    return parts;
  };
  return {
    tag: async (pid) => {
      const text = await read(pid, 'environ');
      const entry = text?.split('\0').find((e) => e.startsWith(TAG));
      return entry === undefined ? null : entry.slice(TAG.length);
    },
    args,
    command: async (pid) => (await args(pid))?.join(' ').slice(0, COMMAND_CHARS) ?? null,
  };
};

const parsePressure = (text: string, path: string): Pressure => {
  const figures = (kind: string): PressureFigures => {
    const match = new RegExp(String.raw`^${kind} avg10=(\d+\.\d+) avg60=(\d+\.\d+) avg300=(\d+\.\d+) total=\d+$`, 'm').exec(text);
    if (match === null) throw new MalformedError(path, `no ${kind} line`);
    return { avg10: Number(match[1]), avg60: Number(match[2]), avg300: Number(match[3]) };
  };
  return { some: figures('some'), full: figures('full') };
};

/** Null when absent or with PSI disabled, where reading fails with `EOPNOTSUPP`. */
const readPressure = async (path: string): Promise<Pressure | null> => {
  let text: string | null;
  try {
    text = await readOptional(path);
  } catch (error) {
    if (codeOf(error) === 'EOPNOTSUPP') return null;
    throw error;
  }
  return text === null ? null : parsePressure(text, path);
};

const parseMeminfo = (text: string, path: string): Meminfo => {
  const required = (key: string): number => {
    const value = kibLine(text, key, path);
    if (value === null) throw new MalformedError(path, `no ${key}`);
    return value;
  };
  return {
    total: required('MemTotal'),
    available: required('MemAvailable'),
    swapTotal: required('SwapTotal'),
    swapFree: required('SwapFree'),
  };
};

/** System pressure and meminfo, each null when absent or malformed. */
export const readSystemMemory = async (roots: MemoryRoots, report: Report): Promise<SystemMemory> => {
  const pressure = source(() => readPressure(join(roots.proc, 'pressure', 'memory')), report);
  const meminfoPath = join(roots.proc, 'meminfo');
  const meminfo = source(async () => parseMeminfo(await readFile(meminfoPath, 'utf8'), meminfoPath), report);
  return { pressure: await pressure, meminfo: await meminfo };
};

/** A byte count file's value; null when absent or `max`. */
const readBytes = async (path: string): Promise<number | null> => {
  const text = (await readOptional(path))?.trim() ?? null;
  return text === null || text === 'max' ? null : integer(text, path, 'bytes');
};

const readPids = async (path: string): Promise<number[]> => {
  const text = await readOptional(path);
  if (text === null) return [];
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => integer(line, path, 'pid'));
};

/** The own cgroup v2; null without one or without its `memory.current`. */
export const readOwnCgroup = (roots: MemoryRoots, report: Report): Promise<OwnCgroup | null> =>
  source(async () => {
    const membership = await readFile(join(roots.proc, 'self', 'cgroup'), 'utf8');
    const path = /^0::(\/.*)$/m.exec(membership)?.[1];
    if (path === undefined) return null;
    const dir = join(roots.cgroup, path);
    const currentPath = join(dir, 'memory.current');
    const current = integer((await readFile(currentPath, 'utf8')).trim(), currentPath, 'bytes');
    const [peak, max, high, swapCurrent, pressure, pids] = await Promise.all([
      readBytes(join(dir, 'memory.peak')),
      readBytes(join(dir, 'memory.max')),
      readBytes(join(dir, 'memory.high')),
      readBytes(join(dir, 'memory.swap.current')),
      readPressure(join(dir, 'memory.pressure')),
      readPids(join(dir, 'cgroup.procs')),
    ]);
    return { path, current, peak, max, high, swapCurrent, pressure, pids };
  }, report);

const TIGHT_PRESSURE = 10;
const TIGHT_AVAILABLE = 0.1;

/** Whether memory is tight: `some avg10` at least 10, or MemAvailable below 10% of MemTotal. */
export const isTight = (system: SystemMemory, cgroup: OwnCgroup | null): boolean => {
  const pressed = (pressure: Pressure | null | undefined): boolean => (pressure?.some.avg10 ?? 0) >= TIGHT_PRESSURE;
  const { meminfo } = system;
  return pressed(system.pressure) || pressed(cgroup?.pressure) || (meminfo !== null && meminfo.available < meminfo.total * TIGHT_AVAILABLE);
};

/** Whether memory is tight now, by system and own-cgroup figures. */
export const memoryTight = async (roots: MemoryRoots, report: Report): Promise<boolean> => {
  const [system, cgroup] = await Promise.all([readSystemMemory(roots, report), readOwnCgroup(roots, report)]);
  return isTight(system, cgroup);
};

export interface MemoryReading {
  table: ProcessInfo[] | null;
  cgroup: OwnCgroup | null;
  system: SystemMemory;
}

/** The process table, own cgroup and system memory. */
export const readMemory = async (roots: MemoryRoots, report: Report): Promise<MemoryReading> => {
  const [table, cgroup, system] = await Promise.all([
    readProcessTable(roots, report),
    readOwnCgroup(roots, report),
    readSystemMemory(roots, report),
  ]);
  return { table, cgroup, system };
};

export interface TopProcess {
  pid: number;
  rss: number;
  anon: number;
  command: string | null;
}

/** Totals of a set of processes and its largest by resident memory. */
export interface ProcessGroup {
  processes: number;
  rss: number;
  anon: number;
  top: TopProcess[];
}

/** Sums `members` and lists the `n` largest by rss, looking up commands for those only. */
export const summarise = async (
  members: readonly ProcessInfo[],
  n: number,
  command: (pid: number) => Promise<string | null>,
): Promise<ProcessGroup> => {
  const largest = [...members].sort((a, b) => b.rss - a.rss).slice(0, n);
  return {
    processes: members.length,
    rss: members.reduce((sum, p) => sum + p.rss, 0),
    anon: members.reduce((sum, p) => sum + p.anon, 0),
    top: await Promise.all(largest.map(async (p) => ({ pid: p.pid, rss: p.rss, anon: p.anon, command: await command(p.pid) }))),
  };
};

/** The process's own memory figures in bytes. */
export interface SelfMemory {
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
}

export const selfMemory = (): SelfMemory => {
  const { rss, heapTotal, heapUsed, external, arrayBuffers } = process.memoryUsage();
  return { rss, heapTotal, heapUsed, external, arrayBuffers };
};
