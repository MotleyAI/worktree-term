import { describe, expect, it } from 'vitest';
import type { OwnCgroup, ProcessInfo, ProcessLookup, SystemMemory } from '../../platform/memory/index.js';
import { hubRecord, type HubSampleInput } from './memory.js';

const HUB = 100;
const WTD = ['/usr/bin/node', '/opt/wtd/dist/wtd.mjs'];
const DAEMON_COMMAND = [...WTD, 'daemon'];

const p = (pid: number, ppid: number, sid = pid): ProcessInfo => ({ pid, ppid, sid, rss: pid * 1000, anon: pid * 500 });

const lookupOf = (args: Readonly<Record<number, readonly string[]>>): ProcessLookup => ({
  tag: () => Promise.resolve(null),
  args: (pid) => Promise.resolve(args[pid] ?? [`cmd${String(pid)}`]),
  command: (pid) => Promise.resolve((args[pid] ?? [`cmd${String(pid)}`]).join(' ')),
});

const PRESSURE = { some: { avg10: 1, avg60: 2, avg300: 3 }, full: { avg10: 0, avg60: 0, avg300: 0 } };
const SYSTEM: SystemMemory = { pressure: PRESSURE, meminfo: null };
const cgroupOf = (pids: readonly number[]): OwnCgroup => ({
  path: '/app.slice/x.scope',
  current: 10,
  peak: 20,
  max: 30,
  high: null,
  swapCurrent: null,
  pressure: null,
  pids: [...pids],
});

/**
 * The hub (100) with an SSH child (101) that has a detached child (105), a hub-run helper (108), and the daemon
 * (102) with a shell (103) and its child (104); 106 is unrelated and 107 runs the daemon command elsewhere.
 */
const TABLE = [
  p(HUB, 1),
  p(101, HUB),
  p(105, 101),
  p(108, HUB),
  p(102, HUB, 102),
  p(103, 102, 103),
  p(104, 103, 103),
  p(106, 1),
  p(107, 1),
];
const ARGS = { 101: ['ssh', 'box', 'wtd connect'], 102: DAEMON_COMMAND, 107: DAEMON_COMMAND, 108: [...WTD, 'hub'] };

const input = (over: Partial<HubSampleInput> = {}): HubSampleInput => ({
  ts: '2026-10-28T10:00:00.000Z',
  pid: HUB,
  instance: 'hubinst',
  version: '1.2.3',
  intervalMs: 60_000,
  self: { rss: 1, heapTotal: 2, heapUsed: 3, external: 4, arrayBuffers: 5 },
  daemonCommand: DAEMON_COMMAND,
  table: TABLE,
  cgroup: null,
  system: SYSTEM,
  lookup: lookupOf(ARGS),
  ...over,
});

describe('hub record', () => {
  it('has the identity, own memory, children, cgroup and system figures', async () => {
    expect(await hubRecord(input({ cgroup: cgroupOf([HUB, 101, 102, 103, 106, 999]) }))).toEqual({
      ts: '2026-10-28T10:00:00.000Z',
      source: 'hub',
      pid: HUB,
      instance: 'hubinst',
      version: '1.2.3',
      intervalMs: 60_000,
      self: { rss: 1, heapTotal: 2, heapUsed: 3, external: 4, arrayBuffers: 5 },
      children: {
        processes: 3,
        rss: 314_000,
        anon: 157_000,
        top: [
          { pid: 108, rss: 108_000, anon: 54_000, command: `${WTD.join(' ')} hub` },
          { pid: 105, rss: 105_000, anon: 52_500, command: 'cmd105' },
          { pid: 101, rss: 101_000, anon: 50_500, command: 'ssh box wtd connect' },
        ],
      },
      cgroup: {
        path: '/app.slice/x.scope',
        current: 10,
        peak: 20,
        max: 30,
        high: null,
        swapCurrent: null,
        pressure: null,
        others: {
          processes: 3,
          rss: 311_000,
          anon: 155_500,
          top: [
            { pid: 106, rss: 106_000, anon: 53_000, command: 'cmd106' },
            { pid: 103, rss: 103_000, anon: 51_500, command: 'cmd103' },
            { pid: 102, rss: 102_000, anon: 51_000, command: DAEMON_COMMAND.join(' ') },
          ],
        },
      },
      system: SYSTEM,
    });
  });

  it('lists the 5 largest children', async () => {
    const many = Array.from({ length: 7 }, (_, i) => p(200 + i, HUB));
    const record = await hubRecord(input({ table: [p(HUB, 1), ...many] }));
    expect(record.children?.processes).toBe(7);
    expect(record.children?.top.map((t) => t.pid)).toEqual([206, 205, 204, 203, 202]);
  });

  it('counts a process running another command than the daemon command as a child', async () => {
    const record = await hubRecord(input({ lookup: lookupOf({ ...ARGS, 102: [...WTD, 'daemon', '--x'] }) }));
    expect(record.children?.processes).toBe(6);
  });

  it('keeps own memory but gives null groups without a process table', async () => {
    const record = await hubRecord(input({ table: null, cgroup: cgroupOf([HUB]) }));
    expect(record.self).toEqual({ rss: 1, heapTotal: 2, heapUsed: 3, external: 4, arrayBuffers: 5 });
    expect(record.children).toBeNull();
    expect(record.cgroup).toMatchObject({ current: 10, others: null });
  });

  it('gives a null cgroup without one', async () => {
    expect((await hubRecord(input())).cgroup).toBeNull();
  });
});
