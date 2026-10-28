import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, type PathLike } from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  hostRoots,
  isTight,
  processLookup,
  readOwnCgroup,
  readProcessTable,
  readSystemMemory,
  summarise,
  type MemoryRoots,
  type OwnCgroup,
  type ProcessInfo,
  type SystemMemory,
} from './index.js';

// platform.memory reads through node:fs/promises; these hooks make reads of one path fail with a code.
const hooks = vi.hoisted((): { failing: Map<string, string> } => ({ failing: new Map() }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof FsPromises>();
  const fail = (path: PathLike): void => {
    const code = hooks.failing.get(String(path));
    if (code !== undefined) throw Object.assign(new Error(`${code}: ${String(path)}`), { code });
  };
  return {
    ...real,
    readFile: async (path: PathLike, options?: object) => {
      fail(path);
      return real.readFile(path, options);
    },
    readdir: async (path: PathLike, options?: object) => {
      fail(path);
      return real.readdir(path, options);
    },
  };
});

const UID = 4242;
const KiB = 1024;
const PSI = 'some avg10=1.50 avg60=2.25 avg300=3.00 total=123\nfull avg10=0.50 avg60=0.75 avg300=1.00 total=45\n';
const PRESSURE = { some: { avg10: 1.5, avg60: 2.25, avg300: 3 }, full: { avg10: 0.5, avg60: 0.75, avg300: 1 } };
const MEMINFO =
  'MemTotal:       1000 kB\nMemFree:         100 kB\nMemAvailable:    400 kB\nSwapTotal:       200 kB\nSwapFree:        150 kB\n';

let root: string;
let roots: MemoryRoots;
let reported: unknown[];
const report = (error: unknown): void => {
  reported.push(error);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wtd-memory-'));
  roots = { proc: join(root, 'proc'), cgroup: join(root, 'cgroup'), uid: UID };
  mkdirSync(roots.proc);
  mkdirSync(roots.cgroup);
  reported = [];
  hooks.failing.clear();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

interface FakeProcess {
  name?: string;
  state?: string;
  ppid?: number;
  sid?: number;
  uid?: number;
  /** VmRSS in kB; null leaves the line out. */
  rss?: number | null;
  /** RssAnon in kB; null leaves the line out. */
  anon?: number | null;
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
}

/** Writes `/proc/<pid>` of the fake tree. */
const fakeProcess = (pid: number, p: FakeProcess = {}): string => {
  const { name = 'sh', state = 'S', ppid = 1, sid = pid, uid = UID, rss = 1000, anon = 600, args = [name], env = {} } = p;
  const dir = join(roots.proc, String(pid));
  mkdirSync(dir, { recursive: true });
  const rest = Array.from({ length: 45 }, () => '0').join(' ');
  writeFileSync(join(dir, 'stat'), `${String(pid)} (${name}) ${state} ${String(ppid)} ${String(pid)} ${String(sid)} 0 -1 ${rest}\n`);
  const lines = [
    `Name:\t${name}`,
    `State:\t${state} (sleeping)`,
    `PPid:\t${String(ppid)}`,
    `Uid:\t${String(uid)}\t${String(uid)}\t${String(uid)}\t${String(uid)}`,
  ];
  if (rss !== null) lines.push(`VmRSS:\t${String(rss).padStart(8)} kB`);
  if (anon !== null) lines.push(`RssAnon:\t${String(anon).padStart(8)} kB`);
  writeFileSync(join(dir, 'status'), `${lines.join('\n')}\n`);
  writeFileSync(join(dir, 'cmdline'), args.map((a) => `${a}\0`).join(''));
  writeFileSync(
    join(dir, 'environ'),
    Object.entries(env)
      .map(([k, v]) => `${k}=${v}\0`)
      .join(''),
  );
  return dir;
};

/** Writes a fake file at `relative` under the root. */
const fakeFile = (relative: string, text: string): void => {
  const path = join(root, relative);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
};

/** A cgroup v2 own cgroup at `/app.slice/x.scope` with every file present. */
const fakeCgroup = (): string => {
  fakeFile('proc/self/cgroup', '0::/app.slice/x.scope\n');
  const dir = 'cgroup/app.slice/x.scope';
  fakeFile(`${dir}/memory.current`, '123456\n');
  fakeFile(`${dir}/memory.peak`, '234567\n');
  fakeFile(`${dir}/memory.max`, 'max\n');
  fakeFile(`${dir}/memory.high`, '1000000\n');
  fakeFile(`${dir}/memory.swap.current`, '4096\n');
  fakeFile(`${dir}/memory.pressure`, PSI);
  fakeFile(`${dir}/cgroup.procs`, '10\n11\n12\n');
  return join(root, dir);
};

const byPid = (table: readonly ProcessInfo[] | null): ProcessInfo[] => [...(table ?? [])].sort((a, b) => a.pid - b.pid);

describe('process table', () => {
  it('lists the processes of the user with parent, session and resident memory in bytes', async () => {
    fakeProcess(10, { ppid: 1, sid: 10, rss: 2000, anon: 1500 });
    fakeProcess(11, { ppid: 10, sid: 10, rss: 300, anon: 100 });
    fakeProcess(12, { uid: 0 });
    fakeFile('proc/meminfo', MEMINFO);
    mkdirSync(join(roots.proc, 'self'), { recursive: true });
    expect(byPid(await readProcessTable(roots, report))).toEqual([
      { pid: 10, ppid: 1, sid: 10, rss: 2000 * KiB, anon: 1500 * KiB },
      { pid: 11, ppid: 10, sid: 10, rss: 300 * KiB, anon: 100 * KiB },
    ]);
    expect(reported).toEqual([]);
  });

  it('reads parent and session after a command name holding spaces and parentheses', async () => {
    fakeProcess(20, { name: 'a) (b c', ppid: 7, sid: 8 });
    expect(await readProcessTable(roots, report)).toEqual([expect.objectContaining({ pid: 20, ppid: 7, sid: 8 })]);
  });

  it('counts a zombie, which has no resident memory lines, with none', async () => {
    fakeProcess(30, { state: 'Z', rss: null, anon: null });
    expect(await readProcessTable(roots, report)).toEqual([{ pid: 30, ppid: 1, sid: 30, rss: 0, anon: 0 }]);
    expect(reported).toEqual([]);
  });

  it('leaves out a process whose status is gone by the time it is read', async () => {
    fakeProcess(40);
    const vanishing = fakeProcess(41);
    rmSync(join(vanishing, 'status'));
    expect((await readProcessTable(roots, report))?.map((p) => p.pid)).toEqual([40]);
    expect(reported).toEqual([]);
  });

  it.each(['ESRCH', 'ENOENT'])('leaves out a process whose files fail with %s mid-read', async (code) => {
    fakeProcess(40);
    const vanishing = fakeProcess(41);
    hooks.failing.set(join(vanishing, 'status'), code);
    expect((await readProcessTable(roots, report))?.map((p) => p.pid)).toEqual([40]);
    expect(reported).toEqual([]);
  });

  it('yields null without /proc, reporting nothing', async () => {
    rmSync(roots.proc, { recursive: true });
    expect(await readProcessTable(roots, report)).toBeNull();
    expect(reported).toEqual([]);
  });

  it('yields null when /proc cannot be read, reporting nothing', async () => {
    fakeProcess(10);
    hooks.failing.set(roots.proc, 'EACCES');
    expect(await readProcessTable(roots, report)).toBeNull();
    expect(reported).toEqual([]);
  });

  it('yields null and reports a malformed status', async () => {
    const dir = fakeProcess(50);
    writeFileSync(
      join(dir, 'status'),
      `Name:\tsh\nPPid:\t1\nUid:\t${String(UID)}\t${String(UID)}\t${String(UID)}\t${String(UID)}\nVmRSS:\tlots kB\n`,
    );
    expect(await readProcessTable(roots, report)).toBeNull();
    expect(reported).toHaveLength(1);
  });

  it.runIf(existsSync('/proc/self/stat'))('contains a child of the reader running sleep, from the real /proc', async () => {
    const child = spawn('sleep', ['30'], { stdio: 'ignore', env: { ...process.env, WTD_TERMINAL: '1/real/2' } });
    try {
      const pid = child.pid ?? 0;
      const stat = readFileSync('/proc/self/stat', 'utf8');
      const ownSession = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[3]);
      const real = hostRoots();
      let entry: ProcessInfo | undefined;
      for (let attempt = 0; attempt < 50 && entry === undefined; attempt++) {
        entry = (await readProcessTable(real, report))?.find((p) => p.pid === pid); // NOSONAR(S9382) — polls until the child has exec'd
        if (entry === undefined) await new Promise((resolve) => setTimeout(resolve, 20)); // NOSONAR(S9382) — polling loop
      }
      expect(entry).toMatchObject({ pid, ppid: process.pid, sid: ownSession });
      expect(entry?.rss).toBeGreaterThan(0);
      const lookup = processLookup(real);
      expect(await lookup.tag(pid)).toBe('1/real/2');
      expect(await lookup.args(pid)).toEqual(['sleep', '30']);
      expect(reported).toEqual([]);
    } finally {
      child.kill('SIGKILL');
    }
  });
});

describe('process lookup', () => {
  it("reads a process's WTD_TERMINAL, null when it has none, is gone or cannot be read", async () => {
    fakeProcess(10, { env: { HOME: '/h', WTD_TERMINAL: '100/inst/3', WTD_TERMINAL_X: 'no' } });
    fakeProcess(11, { env: { HOME: '/h' } });
    const hidden = fakeProcess(12, { env: { WTD_TERMINAL: '1/a/1' } });
    chmodSync(join(hidden, 'environ'), 0o000);
    const lookup = processLookup(roots);
    expect(await lookup.tag(10)).toBe('100/inst/3');
    expect(await lookup.tag(11)).toBeNull();
    expect(await lookup.tag(99)).toBeNull();
    expect(await lookup.tag(12)).toBeNull();
  });

  it('reads the arguments and the command line, cut to 200 characters', async () => {
    fakeProcess(10, { args: ['node', '/opt/wtd.mjs', 'daemon'] });
    fakeProcess(11, { args: ['x', 'y'.repeat(300)] });
    const lookup = processLookup(roots);
    expect(await lookup.args(10)).toEqual(['node', '/opt/wtd.mjs', 'daemon']);
    expect(await lookup.command(10)).toBe('node /opt/wtd.mjs daemon');
    expect(await lookup.command(11)).toBe(`x ${'y'.repeat(198)}`);
    expect(await lookup.args(99)).toBeNull();
    expect(await lookup.command(99)).toBeNull();
  });
});

describe('own cgroup', () => {
  it('reads the cgroup v2 figures, pressure and member pids', async () => {
    fakeCgroup();
    expect(await readOwnCgroup(roots, report)).toEqual({
      path: '/app.slice/x.scope',
      current: 123456,
      peak: 234567,
      max: null,
      high: 1000000,
      swapCurrent: 4096,
      pressure: PRESSURE,
      pids: [10, 11, 12],
    });
    expect(reported).toEqual([]);
  });

  it('gives null for each optional file that is absent', async () => {
    const dir = fakeCgroup();
    for (const name of ['memory.peak', 'memory.swap.current', 'memory.pressure', 'memory.high', 'memory.max']) rmSync(join(dir, name));
    expect(await readOwnCgroup(roots, report)).toMatchObject({
      current: 123456,
      peak: null,
      max: null,
      high: null,
      swapCurrent: null,
      pressure: null,
    });
    expect(reported).toEqual([]);
  });

  it('yields null without memory.current while the system source is still read', async () => {
    rmSync(join(fakeCgroup(), 'memory.current'));
    fakeFile('proc/meminfo', MEMINFO);
    fakeFile('proc/pressure/memory', PSI);
    expect(await readOwnCgroup(roots, report)).toBeNull();
    expect((await readSystemMemory(roots, report)).meminfo).not.toBeNull();
    expect(reported).toEqual([]);
  });

  it.each([
    ['cgroup v1 only', '12:memory:/user.slice\n1:name=systemd:/user.slice\n'],
    ['no cgroup file', null],
  ])('yields null with %s', async (_name, text) => {
    if (text !== null) fakeFile('proc/self/cgroup', text);
    expect(await readOwnCgroup(roots, report)).toBeNull();
    expect(reported).toEqual([]);
  });

  it.each(['proc/self/cgroup', 'cgroup/app.slice/x.scope/memory.current'])(
    'yields null when %s cannot be read, reporting nothing',
    async (file) => {
      fakeCgroup();
      hooks.failing.set(join(root, file), 'EACCES');
      expect(await readOwnCgroup(roots, report)).toBeNull();
      expect(reported).toEqual([]);
    },
  );

  it('yields null and reports a malformed memory.current', async () => {
    writeFileSync(join(fakeCgroup(), 'memory.current'), 'lots\n');
    expect(await readOwnCgroup(roots, report)).toBeNull();
    expect(reported).toHaveLength(1);
  });
});

describe('system memory', () => {
  it('reads system pressure and meminfo in bytes', async () => {
    fakeFile('proc/pressure/memory', PSI);
    fakeFile('proc/meminfo', MEMINFO);
    expect(await readSystemMemory(roots, report)).toEqual({
      pressure: PRESSURE,
      meminfo: { total: 1000 * KiB, available: 400 * KiB, swapTotal: 200 * KiB, swapFree: 150 * KiB },
    });
    expect(reported).toEqual([]);
  });

  it('yields null figures without /proc, reporting nothing', async () => {
    rmSync(roots.proc, { recursive: true });
    expect(await readSystemMemory(roots, report)).toEqual({ pressure: null, meminfo: null });
    expect(reported).toEqual([]);
  });

  it('gives null figures for files that cannot be read, reporting nothing', async () => {
    fakeFile('proc/pressure/memory', PSI);
    fakeFile('proc/meminfo', MEMINFO);
    hooks.failing.set(join(roots.proc, 'pressure', 'memory'), 'EACCES');
    hooks.failing.set(join(roots.proc, 'meminfo'), 'EACCES');
    expect(await readSystemMemory(roots, report)).toEqual({ pressure: null, meminfo: null });
    expect(reported).toEqual([]);
  });

  it('gives null pressure without PSI, still reading meminfo', async () => {
    fakeFile('proc/meminfo', MEMINFO);
    const meminfo: unknown = expect.objectContaining({ total: 1000 * KiB });
    expect(await readSystemMemory(roots, report)).toEqual({ pressure: null, meminfo });
    expect(reported).toEqual([]);
  });

  it('gives null pressure and reports a pressure file without its some line', async () => {
    fakeFile('proc/pressure/memory', 'full avg10=0.50 avg60=0.75 avg300=1.00 total=45\n');
    fakeFile('proc/meminfo', MEMINFO);
    const system = await readSystemMemory(roots, report);
    expect(system.pressure).toBeNull();
    expect(system.meminfo).not.toBeNull();
    expect(reported).toHaveLength(1);
    expect(String(reported[0])).toContain(join(roots.proc, 'pressure', 'memory'));
  });

  it('gives null meminfo and reports one without MemAvailable', async () => {
    fakeFile('proc/meminfo', 'MemTotal:       1000 kB\nSwapTotal:       0 kB\nSwapFree:        0 kB\n');
    expect((await readSystemMemory(roots, report)).meminfo).toBeNull();
    expect(reported).toHaveLength(1);
  });
});

describe('tight memory', () => {
  const figures = (avg10: number) => ({ some: { avg10, avg60: 0, avg300: 0 }, full: { avg10: 0, avg60: 0, avg300: 0 } });
  const system = (avg10: number, available = 500): SystemMemory => ({
    pressure: figures(avg10),
    meminfo: { total: 1000, available, swapTotal: 0, swapFree: 0 },
  });
  const cgroup = (avg10: number): OwnCgroup => ({
    path: '/x',
    current: 1,
    peak: null,
    max: null,
    high: null,
    swapCurrent: null,
    pressure: figures(avg10),
    pids: [],
  });

  it.each([
    ['calm', system(9.99), cgroup(9.99), false],
    ['system some avg10 at 10', system(10), cgroup(0), true],
    ['cgroup some avg10 at 10', system(0), cgroup(10), true],
    ['MemAvailable below 10% of MemTotal', system(0, 99), null, true],
    ['MemAvailable at 10% of MemTotal', system(0, 100), null, false],
    ['no figures', { pressure: null, meminfo: null }, null, false],
  ] as const)('is %s → %s', (_name, sys, group, tight) => {
    expect(isTight(sys, group)).toBe(tight);
  });
});

describe('groups', () => {
  const p = (pid: number, rss: number): ProcessInfo => ({ pid, ppid: 1, sid: pid, rss, anon: rss / 2 });

  it('sums the members and lists the largest by resident memory with their commands, looked up for those only', async () => {
    const looked: number[] = [];
    const command = (pid: number): Promise<string | null> => {
      looked.push(pid);
      return Promise.resolve(pid === 3 ? null : `cmd ${String(pid)}`);
    };
    expect(await summarise([p(1, 10), p(2, 40), p(3, 30), p(4, 20)], 2, command)).toEqual({
      processes: 4,
      rss: 100,
      anon: 50,
      top: [
        { pid: 2, rss: 40, anon: 20, command: 'cmd 2' },
        { pid: 3, rss: 30, anon: 15, command: null },
      ],
    });
    expect(looked.sort()).toEqual([2, 3]);
  });

  it('summarises no members as empty', async () => {
    expect(await summarise([], 5, () => Promise.resolve(''))).toEqual({ processes: 0, rss: 0, anon: 0, top: [] });
  });
});
