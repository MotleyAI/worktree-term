import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Terminal } from '../../src/protocol/index.js';
import type { DaemonClient } from '../support/daemon-client.js';
import { addWorktree, DaemonHost, livePidsWhere, makeRepo, sessionOf, sleep, waitUntil, type WtdProcess } from '../support/daemon-host.js';
import { FakeSsh } from '../support/fake-ssh.js';
import { HubHost } from '../support/hub-host.js';
import { packageVersion } from '../support/hub-router.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

const SAMPLE_MS = 200;
const ENV = { WTD_MEMORY_SAMPLE_MS: String(SAMPLE_MS) };
const MiB = 1024 * 1024;

const top = z.object({ pid: z.number(), rss: z.number(), anon: z.number(), command: z.string().nullable() });
const group = z.object({ processes: z.number(), rss: z.number(), anon: z.number(), top: z.array(top) });
const self = z.object({ rss: z.number(), heapTotal: z.number(), heapUsed: z.number(), external: z.number(), arrayBuffers: z.number() });
const system = z.object({ pressure: z.unknown(), meminfo: z.unknown() });
const daemonLine = z.object({
  ts: z.string(),
  source: z.literal('daemon'),
  pid: z.number(),
  instance: z.string(),
  version: z.string(),
  intervalMs: z.number(),
  self,
  mirrors: z.object({ count: z.number(), bytes: z.number() }),
  terminals: z.array(
    z.object({
      termId: z.number(),
      repo: z.string(),
      worktree: z.string(),
      preset: z.string(),
      pid: z.number(),
      mirror: z.object({ lines: z.number(), cols: z.number(), bytes: z.number() }),
      members: group.nullable(),
      detached: group.nullable(),
    }),
  ),
  escaped: z
    .array(group.extend({ tag: z.string(), termId: z.number().nullable(), worktree: z.string().nullable(), preset: z.string().nullable() }))
    .nullable(),
  escapedOmitted: z.object({ groups: z.number(), processes: z.number(), rss: z.number(), anon: z.number() }).nullable(),
  cgroup: z.object({ current: z.number(), others: group.nullable() }).nullable(),
  system,
});
const hubLine = z.object({
  ts: z.string(),
  source: z.literal('hub'),
  pid: z.number(),
  instance: z.string(),
  version: z.string(),
  intervalMs: z.number(),
  self,
  children: group.nullable(),
  cgroup: z.object({ current: z.number(), others: group.nullable() }).nullable(),
  system,
});

/** The complete lines of `path`, parsed as JSON. */
const linesOf = (path: string): unknown[] =>
  existsSync(path)
    ? readFileSync(path, 'utf8')
        .split('\n')
        .slice(0, -1)
        .map((line): unknown => JSON.parse(line))
    : [];

/** The first line of `path` from index `from` on that `schema` parses and `matches` accepts. */
const sampleWhere = <T>(path: string, schema: z.ZodType<T>, matches: (line: T) => boolean, from = 0): Promise<T> =>
  waitUntil(
    () =>
      linesOf(path)
        .slice(from)
        .map((line) => schema.parse(line))
        .find(matches),
    `a matching sample in ${path}`,
    15_000,
  );

/** Holds 32 MiB, ignores SIGHUP and runs until killed; `marker` names it. */
const HOG_SCRIPT = `process.on('SIGHUP',()=>{});globalThis.b=Buffer.alloc(${String(32 * MiB)},1);setInterval(()=>{},1e6)`;
const hog = (marker: string): string => `${process.execPath} -e "${HOG_SCRIPT}" ${marker}`;

/** Whether `pid` has installed a SIGHUP handler; node resets inherited dispositions at startup, so until then a hangup kills it. */
const catchesHup = (pid: number): boolean => {
  const status = `/proc/${String(pid)}/status`;
  const mask = existsSync(status) ? /^SigCgt:\t([0-9a-f]+)$/m.exec(readFileSync(status, 'utf8'))?.[1] : undefined;
  return mask !== undefined && (BigInt(`0x${mask}`) & 1n) === 1n;
};

/** Parent pid of `pid`. */
const parentOf = (pid: number): number => {
  const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
  return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
};

/** Waits for the bytes of `path` to stay unchanged for 1 s, well over the sample interval. */
const expectNoMoreLines = async (path: string): Promise<void> => {
  const size = statSync(path).size;
  await sleep(5 * SAMPLE_MS);
  expect(statSync(path).size).toBe(size);
};

describe('daemon memory log', () => {
  let host: DaemonHost;
  let daemon: WtdProcess;
  let client: DaemonClient;
  let instance: string;
  let repo: string;
  let wt: string;

  beforeEach(async () => {
    host = DaemonHost.create();
    repo = makeRepo(join(host.dir, 'repo'));
    wt = addWorktree(repo, join(host.dir, 'wt'), 'wt');
    daemon = await host.start(ENV);
    client = await host.rawClient();
    instance = (await client.handshake()).instance;
    await client.watch(repo);
  });

  afterEach(async () => {
    // Also kills every process left behind with this host's HOME, escaped ones included.
    await host.cleanup();
  });

  const log = (): string => join(host.stateDir, 'memory.log');
  const tagOf = (termId: number): string => `${String(daemon.pid)}/${instance}/${String(termId)}`;

  /** An interactive shell in the worktree that has run a command. */
  const shell = async (): Promise<Terminal> => {
    const term = await client.create(wt);
    await client.attach(term.termId);
    client.sendInput(term.termId, 'echo READY-$((6*7))\r');
    await client.waitOutput(term.termId, 'READY-42\r\n', 10_000);
    return term;
  };

  /** The pid of the live process of this host whose argv is `argv`. */
  const pidOf = (argv: readonly string[]): Promise<number> =>
    waitUntil(
      () =>
        livePidsWhere(
          (cmdline, environ) => cmdline.slice(0, -1).join('\0') === argv.join('\0') && environ.includes(`HOME=${host.home}`),
        )[0],
      argv.join(' '),
      10_000,
    );

  /** The pid of the hog named `marker`, once it ignores hangups. */
  const hogPid = (marker: string): Promise<number> =>
    waitUntil(
      () =>
        livePidsWhere(
          (cmdline, environ) => cmdline[0] === process.execPath && cmdline.includes(marker) && environ.includes(`HOME=${host.home}`),
        ).find(catchesHup),
      marker,
      10_000,
    );

  it('appends samples of the daemon, with its identity and own memory, to an owner-only memory.log', async () => {
    const line = await sampleWhere(log(), daemonLine, () => true);
    expect(line).toMatchObject({
      source: 'daemon',
      pid: daemon.pid,
      instance,
      version: packageVersion(),
      intervalMs: SAMPLE_MS,
      terminals: [],
    });
    expect(line.mirrors).toEqual({ count: 0, bytes: 0 });
    expect(Number.isNaN(Date.parse(line.ts))).toBe(false);
    expect(line.self.rss).toBeGreaterThan(0);
    expect(line.self.heapUsed).toBeGreaterThan(0);
    expect(statSync(log()).mode & 0o777).toBe(0o600);
  });

  it("tags a terminal's environment with the daemon's pid, its instance and the terminal id", async () => {
    const term = await shell();
    client.sendInput(term.termId, 'echo "tag=$WTD_TERMINAL"\r');
    await expect(client.waitOutput(term.termId, `tag=${tagOf(term.termId)}\r\n`)).resolves.toBeUndefined();
  });

  it("logs a terminal's tree with its members' memory", async () => {
    const term = await shell();
    client.sendInput(term.termId, 'sleep 1001\r');
    const sleeping = await pidOf(['sleep', '1001']);
    const line = await sampleWhere(log(), daemonLine, (l) =>
      l.terminals.some((t) => t.members?.top.some((m) => m.pid === sleeping) === true),
    );
    const entry = line.terminals.find((t) => t.termId === term.termId);
    expect(entry).toMatchObject({
      termId: term.termId,
      repo,
      worktree: wt,
      preset: 'shell',
      pid: sessionOf(sleeping),
      mirror: { cols: 80 },
    });
    expect(entry?.members?.top.find((m) => m.pid === sleeping)?.rss).toBeGreaterThan(0);
    expect(line.mirrors.count).toBe(1);
  });

  it('logs a setsid child of a closed terminal as escaped with its terminal id and worktree', async () => {
    const term = await shell();
    client.sendInput(term.termId, `setsid ${hog('wtd-memory-setsid')} &\r`);
    const escaped = await hogPid('wtd-memory-setsid');
    await client.ok({ t: 'closeTerm', termId: term.termId });
    const line = await sampleWhere(log(), daemonLine, (l) => l.escaped?.some((g) => g.top.some((t) => t.pid === escaped)) === true);
    expect(line.escaped?.find((g) => g.top.some((t) => t.pid === escaped))).toMatchObject({
      tag: tagOf(term.termId),
      termId: term.termId,
      worktree: wt,
      preset: 'shell',
    });
  });

  it('logs a job that ignores SIGHUP in its own process group and survives closeTerm as escaped', async () => {
    const term = await shell();
    client.sendInput(term.termId, `(trap '' HUP; exec ${hog('wtd-memory-nohup')}) &\r`);
    const job = await hogPid('wtd-memory-nohup');
    await client.ok({ t: 'closeTerm', termId: term.termId });
    const line = await sampleWhere(log(), daemonLine, (l) => l.escaped?.some((g) => g.top.some((t) => t.pid === job)) === true);
    expect(line.escaped?.find((g) => g.top.some((t) => t.pid === job))).toMatchObject({ tag: tagOf(term.termId), termId: term.termId });
  });

  it('logs a setsid child of a live terminal as detached under it, not escaped', async () => {
    const term = await shell();
    client.sendInput(term.termId, `setsid ${hog('wtd-memory-detached')} &\r`);
    const detached = await hogPid('wtd-memory-detached');
    const line = await sampleWhere(log(), daemonLine, (l) =>
      l.terminals.some((t) => t.termId === term.termId && t.detached?.top.some((d) => d.pid === detached) === true),
    );
    expect(line.escaped?.filter((g) => g.tag === tagOf(term.termId))).toEqual([]);
  });

  it('logs a process tagged by a daemon that is gone as escaped, with no worktree', async () => {
    const dead = spawnSync('true').pid;
    const tag = `${String(dead)}/gone/7`;
    const child = spawn(process.execPath, ['-e', HOG_SCRIPT, 'wtd-memory-earlier'], {
      env: { ...host.env(), WTD_TERMINAL: tag },
      stdio: 'ignore',
    });
    try {
      const line = await sampleWhere(log(), daemonLine, (l) => l.escaped?.some((g) => g.tag === tag) === true);
      expect(line.escaped?.find((g) => g.tag === tag)).toMatchObject({ termId: 7, worktree: null, preset: null, processes: 1 });
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('appends nothing once the daemon has shut down', async () => {
    await sampleWhere(log(), daemonLine, () => true);
    client.send({ t: 'shutdown' });
    await daemon.exited;
    await expectNoMoreLines(log());
  });
});

describe('hub memory log', () => {
  let host: HubHost;
  let ssh: FakeSsh;
  let repo: string;

  beforeEach(async () => {
    host = await HubHost.createHub();
    ssh = new FakeSsh(join(host.dir, 'ssh'));
    host.sshProgram = ssh.program;
    repo = makeRepo(join(host.dir, 'repo'));
    host.writeRepos([repo]);
  });

  afterEach(async () => {
    for (const pid of host.hubPids()) process.kill(pid, 'SIGKILL');
    await waitUntil(() => host.hubPids().length === 0, 'hubs to exit').catch(() => undefined);
    await ssh.cleanup();
    await host.cleanup();
  });

  const log = (): string => join(host.stateDir, 'hub-memory.log');

  it('appends samples of the hub, with its identity and own memory, to hub-memory.log', async () => {
    const hub = await host.startHub(ENV);
    const line = await sampleWhere(log(), hubLine, () => true);
    expect(line).toMatchObject({
      source: 'hub',
      pid: hub.pid,
      instance: (await host.identity()).instance,
      version: packageVersion(),
      intervalMs: SAMPLE_MS,
    });
    expect(line.self.heapUsed).toBeGreaterThan(0);
    expect(statSync(log()).mode & 0o777).toBe(0o600);
  });

  it("counts an SSH link's process among the hub's children", async () => {
    ssh.addHost('box');
    ssh.hangHost('box');
    host.writeConfig({ port: host.port, repos: [repo], hosts: [{ name: 'box', ssh: 'box' }] });
    await host.startHub(ENV);
    await host.session();
    const link = await waitUntil(() => ssh.livePids('box')[0], 'the SSH link to box', 10_000);
    const line = await sampleWhere(log(), hubLine, (l) => l.children?.top.some((t) => t.pid === link) === true);
    expect(line.children?.top.find((t) => t.pid === link)?.rss).toBeGreaterThan(0);
  });

  it("counts neither the daemon it started nor its terminals' processes among the hub's children", async () => {
    const hub = await host.startHub(ENV);
    const client = await host.session();
    await client.waitHost(0, (h) => h.status === 'connected', { timeout: 10_000 });
    await client.watch(0, repo);
    const term = await client.create(0, repo);
    await client.attach(0, term.termId);
    client.sendInput(0, term.termId, 'sleep 1006\r');
    const sleeping = await waitUntil(
      () =>
        livePidsWhere((cmdline, environ) => cmdline.slice(0, -1).join(' ') === 'sleep 1006' && environ.includes(`HOME=${host.home}`))[0],
      'sleep 1006',
      10_000,
    );
    const [daemon] = host.daemonPids();
    if (daemon === undefined) throw new Error('no daemon');
    expect(parentOf(daemon)).toBe(hub.pid);
    const line = await sampleWhere(log(), hubLine, () => true, linesOf(log()).length);
    const children = line.children?.top.map((t) => t.pid) ?? [];
    expect(children).not.toContain(daemon);
    expect(children).not.toContain(sessionOf(sleeping));
    expect(children).not.toContain(sleeping);
    expect(line.children?.processes).toBe(line.children?.top.length);
  });

  it('appends nothing once the hub has shut down', async () => {
    const hub = await host.startHub(ENV);
    await sampleWhere(log(), hubLine, () => true);
    hub.kill('SIGTERM');
    await hub.exited;
    await expectNoMoreLines(log());
  });
});
