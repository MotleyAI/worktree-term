import { describe, expect, it } from 'vitest';
import type { OwnCgroup, ProcessInfo, ProcessLookup, SystemMemory } from '../../platform/memory/index.js';
import type { MemoryView } from '../server/index.js';
import { daemonRecord, type DaemonSampleInput } from './memory.js';

const DAEMON = 100;
const INSTANCE = 'inst';
const WTD_DAEMON = ['/usr/bin/node', '/opt/wtd/dist/wtd.mjs', 'daemon'];

/** A process whose resident memory defaults to a distinct amount per pid. */
const p = (pid: number, ppid: number, sid: number, rss = pid * 1000): ProcessInfo => ({ pid, ppid, sid, rss, anon: rss / 2 });

interface Fakes {
  tags?: Readonly<Record<number, string>>;
  args?: Readonly<Record<number, readonly string[]>>;
}

/** A lookup over `fakes`; records which pids had their tag read. */
const lookupOf = ({ tags = {}, args = {} }: Fakes): ProcessLookup & { tagged: number[] } => {
  const tagged: number[] = [];
  return {
    tagged,
    tag: (pid) => {
      tagged.push(pid);
      return Promise.resolve(tags[pid] ?? null);
    },
    args: (pid) => Promise.resolve(args[pid] ?? null),
    command: (pid) => Promise.resolve(args[pid]?.join(' ') ?? `cmd${String(pid)}`),
  };
};

const VIEW: MemoryView = {
  terminals: [
    { termId: 1, repo: '/r', worktree: '/r/w1', preset: 'shell', pid: 200, mirror: { lines: 100, cols: 80 } },
    { termId: 5, repo: '/r', worktree: '/r/w5', preset: 'claude', pid: 250, mirror: { lines: 24, cols: 120 } },
  ],
  closed: [
    { termId: 2, pid: 500, worktree: '/r/w2', preset: 'codex' },
    { termId: 3, pid: 700, worktree: '/r/w3', preset: 'shell' },
  ],
};

const PRESSURE = { some: { avg10: 1, avg60: 2, avg300: 3 }, full: { avg10: 0, avg60: 0, avg300: 0 } };
const SYSTEM: SystemMemory = { pressure: PRESSURE, meminfo: { total: 1000, available: 500, swapTotal: 0, swapFree: 0 } };
const cgroupOf = (pids: readonly number[]): OwnCgroup => ({
  path: '/app.slice/x.scope',
  current: 10,
  peak: 20,
  max: null,
  high: null,
  swapCurrent: 0,
  pressure: PRESSURE,
  pids: [...pids],
});

const input = (table: readonly ProcessInfo[] | null, fakes: Fakes = {}, over: Partial<DaemonSampleInput> = {}): DaemonSampleInput => ({
  ts: '2026-10-28T10:00:00.000Z',
  pid: DAEMON,
  instance: INSTANCE,
  version: '1.2.3',
  intervalMs: 60_000,
  self: { rss: 1, heapTotal: 2, heapUsed: 3, external: 4, arrayBuffers: 5 },
  view: VIEW,
  table,
  cgroup: null,
  system: SYSTEM,
  lookup: lookupOf(fakes),
  ...over,
});

/** The daemon and both live shells; every table includes them. */
const BASE = [p(DAEMON, 1, DAEMON), p(200, DAEMON, 200), p(250, DAEMON, 250)];

const terminal = async (termId: number, table: readonly ProcessInfo[], fakes: Fakes = {}) => {
  const { record } = await daemonRecord(input(table, fakes));
  const found = record.terminals.find((t) => t.termId === termId);
  if (found === undefined) throw new Error(`no terminal ${String(termId)}`);
  return found;
};

const escapedOf = async (table: readonly ProcessInfo[], fakes: Fakes = {}) => (await daemonRecord(input(table, fakes))).record.escaped;

describe('the record', () => {
  it('has the identity, own memory, mirrors, terminals, cgroup and system figures', async () => {
    const { record, gone } = await daemonRecord(input(BASE, {}, { cgroup: cgroupOf([DAEMON]) }));
    expect(record).toEqual({
      ts: '2026-10-28T10:00:00.000Z',
      source: 'daemon',
      pid: DAEMON,
      instance: INSTANCE,
      version: '1.2.3',
      intervalMs: 60_000,
      self: { rss: 1, heapTotal: 2, heapUsed: 3, external: 4, arrayBuffers: 5 },
      mirrors: { count: 2, bytes: 100 * 80 * 12 + 24 * 120 * 12 },
      terminals: [
        {
          termId: 1,
          repo: '/r',
          worktree: '/r/w1',
          preset: 'shell',
          pid: 200,
          mirror: { lines: 100, cols: 80, bytes: 100 * 80 * 12 },
          members: { processes: 1, rss: 200_000, anon: 100_000, top: [{ pid: 200, rss: 200_000, anon: 100_000, command: 'cmd200' }] },
          detached: { processes: 0, rss: 0, anon: 0, top: [] },
        },
        {
          termId: 5,
          repo: '/r',
          worktree: '/r/w5',
          preset: 'claude',
          pid: 250,
          mirror: { lines: 24, cols: 120, bytes: 24 * 120 * 12 },
          members: { processes: 1, rss: 250_000, anon: 125_000, top: [{ pid: 250, rss: 250_000, anon: 125_000, command: 'cmd250' }] },
          detached: { processes: 0, rss: 0, anon: 0, top: [] },
        },
      ],
      escaped: [],
      escapedOmitted: { groups: 0, processes: 0, rss: 0, anon: 0 },
      cgroup: {
        path: '/app.slice/x.scope',
        current: 10,
        peak: 20,
        max: null,
        high: null,
        swapCurrent: 0,
        pressure: PRESSURE,
        others: { processes: 0, rss: 0, anon: 0, top: [] },
      },
      system: SYSTEM,
    });
    expect([...gone].sort((a, b) => a - b)).toEqual([2, 3]);
  });

  it('keeps own memory and mirrors but gives null groups without a process table, forgetting no closed terminal', async () => {
    const { record, gone } = await daemonRecord(input(null, {}, { cgroup: cgroupOf([DAEMON]) }));
    expect(record.self).toEqual({ rss: 1, heapTotal: 2, heapUsed: 3, external: 4, arrayBuffers: 5 });
    expect(record.mirrors).toEqual({ count: 2, bytes: 100 * 80 * 12 + 24 * 120 * 12 });
    expect(record.terminals.map((t) => [t.termId, t.members, t.detached])).toEqual([
      [1, null, null],
      [5, null, null],
    ]);
    expect(record.escaped).toBeNull();
    expect(record.escapedOmitted).toBeNull();
    expect(record.cgroup).toMatchObject({ current: 10, others: null });
    expect(gone).toEqual([]);
  });

  it('gives a null cgroup without one', async () => {
    expect((await daemonRecord(input(BASE))).record.cgroup).toBeNull();
  });
});

describe('rule 1: members of a live terminal', () => {
  it('are in its session or descend from its shell, the 3 largest listed', async () => {
    const table = [...BASE, p(201, 200, 200), p(202, 201, 202), p(210, 1, 200), p(211, 1, 211)];
    const term = await terminal(1, table);
    expect(term.members).toMatchObject({ processes: 4, rss: 813_000, anon: 406_500 });
    expect(term.members?.top.map((t) => t.pid)).toEqual([210, 202, 201]);
  });

  it('come first, whatever their tag, and their tags are not read', async () => {
    const fakes = { tags: { 201: '999/gone/9', 202: '300/other/4' }, args: { 300: WTD_DAEMON } };
    const lookup = lookupOf(fakes);
    const table = [...BASE, p(201, 200, 200), p(202, 201, 202), p(300, 1, 300)];
    const { record } = await daemonRecord(input(table, fakes, { lookup }));
    expect(record.terminals.find((t) => t.termId === 1)?.members?.processes).toBe(3);
    expect(record.escaped).toEqual([]);
    expect(lookup.tagged).not.toContain(200);
    expect(lookup.tagged).not.toContain(201);
    expect(lookup.tagged).not.toContain(202);
  });

  it('leave the daemon itself out', async () => {
    const { record } = await daemonRecord(input(BASE, {}, { cgroup: cgroupOf([DAEMON, 200]) }));
    expect(record.terminals.flatMap((t) => t.members?.top.map((m) => m.pid) ?? [])).not.toContain(DAEMON);
    expect(record.cgroup?.others?.processes).toBe(0);
  });
});

describe('rule 2: detached processes of a live terminal', () => {
  it('carry its tag outside its session and tree', async () => {
    const table = [...BASE, p(203, 1, 203), p(204, 203, 203)];
    const term = await terminal(1, table, { tags: { 203: '100/inst/1', 204: '100/inst/1' } });
    expect(term.detached).toMatchObject({ processes: 2, rss: 407_000 });
    expect(term.members?.processes).toBe(1);
    expect(await escapedOf(table, { tags: { 203: '100/inst/1', 204: '100/inst/1' } })).toEqual([]);
  });
});

describe("rule 3: another running daemon's processes", () => {
  it('are not escaped, even when they no longer descend from it, nor among others', async () => {
    const table = [...BASE, p(300, 1, 300), p(301, 1, 301), p(302, 301, 301)];
    const fakes = { tags: { 301: '300/other/4', 302: '300/other/4' }, args: { 300: WTD_DAEMON } };
    const { record } = await daemonRecord(input(table, fakes, { cgroup: cgroupOf([DAEMON, 301, 302]) }));
    expect(record.escaped).toEqual([]);
    expect(record.cgroup?.others?.processes).toBe(0);
  });
});

describe('rule 4: escaped processes', () => {
  it.each([
    ['is not running', {}],
    ['runs something else', { 999: ['/bin/sleep', '100'] }],
    ['runs a wtd hub', { 999: ['/usr/bin/node', '/opt/wtd/dist/wtd.mjs', 'hub'] }],
    ['runs a daemon that is not wtd', { 999: ['/usr/bin/node', '/opt/other.mjs', 'daemon'] }],
  ])('carry a tag of a pid that %s, with null worktree and preset', async (_name, args) => {
    const table = [...BASE, p(400, 1, 400)];
    expect(await escapedOf(table, { tags: { 400: '999/gone/7' }, args })).toEqual([
      {
        tag: '999/gone/7',
        termId: 7,
        worktree: null,
        preset: null,
        processes: 1,
        rss: 400_000,
        anon: 200_000,
        top: [{ pid: 400, rss: 400_000, anon: 200_000, command: 'cmd400' }],
      },
    ]);
  });

  it('carry a tag of this pid and another instance', async () => {
    const table = [...BASE, p(600, 1, 600)];
    expect(await escapedOf(table, { tags: { 600: '100/old/1' } })).toMatchObject([
      { tag: '100/old/1', termId: 1, worktree: null, preset: null },
    ]);
  });

  it('carry a tag of a terminal of this instance that is not live, with its worktree and preset when this instance closed it', async () => {
    const table = [...BASE, p(502, 1, 502), p(800, 1, 800)];
    const escaped = await escapedOf(table, { tags: { 502: '100/inst/2', 800: '100/inst/9' } });
    expect(escaped).toHaveLength(2);
    expect(escaped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tag: '100/inst/9', termId: 9, worktree: null, preset: null, processes: 1 }),
        expect.objectContaining({ tag: '100/inst/2', termId: 2, worktree: '/r/w2', preset: 'codex', processes: 1 }),
      ]),
    );
  });

  it("are untagged processes in a closed terminal's session, grouped with its tagged ones", async () => {
    const table = [...BASE, p(501, 1, 500), p(502, 1, 502)];
    expect(await escapedOf(table, { tags: { 502: '100/inst/2' } })).toEqual([
      {
        tag: '100/inst/2',
        termId: 2,
        worktree: '/r/w2',
        preset: 'codex',
        processes: 2,
        rss: 1_003_000,
        anon: 501_500,
        top: [
          { pid: 502, rss: 502_000, anon: 251_000, command: 'cmd502' },
          { pid: 501, rss: 501_000, anon: 250_500, command: 'cmd501' },
        ],
      },
    ]);
  });

  it('carry a malformed tag, grouped by it with a null terminal id', async () => {
    const table = [...BASE, p(601, 1, 601)];
    expect(await escapedOf(table, { tags: { 601: 'junk' } })).toMatchObject([{ tag: 'junk', termId: null, worktree: null, preset: null }]);
  });

  it('are the 20 groups with the largest resident memory, the rest counted as omitted', async () => {
    const pids = Array.from({ length: 25 }, (_, i) => 1000 + i);
    const table = [...BASE, ...pids.map((pid) => p(pid, 1, pid))];
    const tags = Object.fromEntries(pids.map((pid) => [pid, `9${String(pid)}/x/1`]));
    const { record } = await daemonRecord(input(table, { tags }));
    expect(record.escaped?.map((g) => g.tag).sort()).toEqual(pids.slice(5).map((pid) => `9${String(pid)}/x/1`));
    const omitted = pids.slice(0, 5).reduce((sum, pid) => sum + pid * 1000, 0);
    expect(record.escapedOmitted).toEqual({ groups: 5, processes: 5, rss: omitted, anon: omitted / 2 });
  });

  it('list the 5 largest processes of a group', async () => {
    const pids = [1001, 1002, 1003, 1004, 1005, 1006];
    const table = [...BASE, ...pids.map((pid) => p(pid, 1, pid))];
    const tags = Object.fromEntries(pids.map((pid) => [pid, '999/gone/7']));
    const [group] = (await escapedOf(table, { tags })) ?? [];
    expect(group?.processes).toBe(6);
    expect(group?.top.map((t) => t.pid)).toEqual([1006, 1005, 1004, 1003, 1002]);
  });
});

describe('rule 5: others', () => {
  it('are the remaining members of the cgroup that are in the table', async () => {
    const table = [...BASE, p(203, 1, 203), p(800, 1, 800), p(900, 1, 900)];
    const { record } = await daemonRecord(
      input(table, { tags: { 203: '100/inst/1' } }, { cgroup: cgroupOf([DAEMON, 200, 203, 800, 801]) }),
    );
    expect(record.cgroup?.others).toEqual({
      processes: 1,
      rss: 800_000,
      anon: 400_000,
      top: [{ pid: 800, rss: 800_000, anon: 400_000, command: 'cmd800' }],
    });
  });
});

describe('closed terminals', () => {
  it('are gone once a sample finds none of their processes, tagged or in their session', async () => {
    const inSession = await daemonRecord(input([...BASE, p(501, 1, 500)]));
    expect(inSession.gone).toEqual([3]);
    const tagged = await daemonRecord(input([...BASE, p(701, 1, 701)], { tags: { 701: '100/inst/3' } }));
    expect(tagged.gone).toEqual([2]);
  });
});
