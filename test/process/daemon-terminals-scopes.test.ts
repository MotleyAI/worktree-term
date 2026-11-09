import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DaemonClient } from '../support/daemon-client.js';
import {
  addWorktree,
  alive,
  BUNDLE,
  canConnect,
  DaemonHost,
  livePidsWhere,
  makeRepo,
  waitUntil,
  type WtdProcess,
} from '../support/daemon-host.js';
import {
  cgroupFile,
  cgroupOf,
  failingSystemdRun,
  failUnit,
  fakeProgram,
  HOG,
  isFailed,
  NO_USER_MANAGER,
  oomScoreAdj,
  resetFailed,
  scopePath,
  SLICE,
  SMALL,
  terminalUnit,
  unitState,
  userManagerEnv,
  withUserManager,
} from '../support/scopes.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

const SCOPES_OFF = 'memory limits ignored: terminal scopes are off';
/** Forks a child before anything else. */
const FORKS_AT_ONCE = 'sleep 1000 & echo $! > child.pid; echo $$ > sh.pid; wait';

let host: DaemonHost;
let daemon: WtdProcess;
let client: DaemonClient;
let instance: string;
let repo: string;
let wt: string;
const others: DaemonHost[] = [];

/** Starts this test's daemon with `env` and a watching client. */
const startDaemon = async (env: Record<string, string | undefined>): Promise<void> => {
  daemon = await host.start(env);
  client = await host.rawClient();
  instance = (await client.handshake()).instance;
  await client.watch(repo);
};

beforeEach(() => {
  host = DaemonHost.create();
  repo = makeRepo(join(host.dir, 'repo'));
  wt = addWorktree(repo, join(host.dir, 'wt'), 'wt');
});

afterEach(async () => {
  for (const other of others.splice(0)) await other.cleanup();
  await host.cleanup();
});

/** The number in the file `name` of the worktree, once written. */
const pidIn = (name: string): Promise<number> =>
  waitUntil(() => {
    const file = join(wt, name);
    if (!existsSync(file)) return undefined;
    const text = readFileSync(file, 'utf8');
    if (!text.endsWith('\n')) return undefined;
    if (!/^\d+\n$/.test(text)) throw new Error(`${name} holds ${JSON.stringify(text)}, not a pid`);
    return Number(text);
  }, `pid file ${name}`);

/** The pid of the live process of this host whose argv is `argv`. */
const pidOf = (argv: readonly string[]): Promise<number> =>
  waitUntil(
    () =>
      livePidsWhere((cmdline, environ) => cmdline.slice(0, -1).join(' ') === argv.join(' ') && environ.includes(`HOME=${host.home}`))[0],
    argv.join(' '),
    10_000,
  );

/** Lines of the daemon's standard error that `match` matches. */
const stderrLines = (match: RegExp): string[] => daemon.stderr.split('\n').filter((l) => match.test(l));

/** Creates a terminal running `command` once attached and given a line, so its output follows the snapshot. */
const run = async (command: string, memory: Record<string, string> = {}): Promise<number> => {
  const term = await client.create(wt, { command: `read -r _; ${command}`, memory });
  await client.attach(term.termId);
  client.sendInput(term.termId, '\r');
  return term.termId;
};

/** A terminal echoing its input; resolves once it has echoed a first line. */
const echoing = async (): Promise<number> => {
  const termId = await run('exec cat');
  client.sendInput(termId, 'first\r');
  await client.waitOutput(termId, 'first', 10_000);
  return termId;
};

describe.skipIf(NO_USER_MANAGER !== null)(withUserManager('terminal scopes on'), () => {
  beforeEach(async () => {
    await startDaemon(userManagerEnv());
  });

  it('says terminal scopes are on at start', async () => {
    await waitUntil(() => stderrLines(/^terminal scopes:/).length > 0, 'the terminal scopes line');
    expect(stderrLines(/^terminal scopes:/)).toEqual(['terminal scopes: on']);
  });

  it("runs a terminal's shell and every process it starts, detached ones included, in that terminal's own scope", async () => {
    const termId = await run("echo $$ > sh.pid; sleep 1000 & sh -c 'sleep 1001' & setsid sleep 1002 & wait");
    const shell = await pidIn('sh.pid');
    const sleeps = await Promise.all(['1000', '1001', '1002'].map((s) => pidOf(['sleep', s])));
    const other = await run('echo $$ > other.pid; exec sleep 60');
    const scope = cgroupOf(shell);
    expect(scope.endsWith(`/${SLICE}/${terminalUnit(host.stateDir, instance, termId)}`)).toBe(true);
    for (const pid of sleeps) expect(cgroupOf(pid)).toBe(scope);
    expect(cgroupOf(daemon.pid)).not.toBe(scope);
    expect(cgroupOf(await pidIn('other.pid')).endsWith(`/${terminalUnit(host.stateDir, instance, other)}`)).toBe(true);
  });

  it("applies the createTerm's memory limits to the terminal's scope", async () => {
    await run('echo $$ > sh.pid; exec sleep 60', SMALL);
    const scope = cgroupOf(await pidIn('sh.pid'));
    expect(cgroupFile(scope, 'memory.max')).toBe('67108864');
    expect(cgroupFile(scope, 'memory.swap.max')).toBe('0');
  });

  it('kills only the terminal that ran out of memory, telling every watcher, while the daemon and other terminals go on', async () => {
    const watcher = await host.client();
    await watcher.watch(repo);
    const survivor = await echoing();
    const from = client.mark();
    const fromWatcher = watcher.mark();
    const hog = await run(HOG, SMALL);
    const anyCode: unknown = expect.any(Number);
    const expected = { t: 'termExited', termId: hog, code: anyCode, signal: 'SIGKILL', oom: true };
    expect(await client.waitFor('termExited', (m) => m.termId === hog, { from, timeout: 20_000 })).toEqual(expected);
    expect(await watcher.waitFor('termExited', (m) => m.termId === hog, { from: fromWatcher })).toEqual(expected);
    expect(client.view(hog).text()).not.toContain('SURVIVED');
    await client.ok({ t: 'setChecked', worktree: wt, checked: true });
    client.sendInput(survivor, 'still-here\r');
    await client.waitOutput(survivor, 'still-here', 10_000);
    expect(alive(daemon.pid)).toBe(true);
    const later = (await (await host.client()).watch(repo)).terminals.find((t) => t.termId === hog);
    expect(later?.exit).toMatchObject({ signal: 'SIGKILL', oom: true });
    expect(isFailed(terminalUnit(host.stateDir, instance, hog))).toBe(false);
  });

  it('reports a SIGKILL sent from outside the daemon as no out-of-memory kill', async () => {
    const termId = await run('echo $$ > sh.pid; exec sleep 600');
    const from = client.mark();
    process.kill(await pidIn('sh.pid'), 'SIGKILL');
    expect(await client.waitFor('termExited', (m) => m.termId === termId, { from, timeout: 10_000 })).toMatchObject({
      signal: 'SIGKILL',
      oom: false,
    });
  });

  it('reports an exit code with oom false', async () => {
    const termId = await run('exit 3');
    expect(await client.waitFor('termExited', (m) => m.termId === termId, { timeout: 10_000 })).toEqual({
      t: 'termExited',
      termId,
      code: 3,
      signal: null,
      oom: false,
    });
  });

  it('raises the oom_score_adj of the shell and of a child it forks at once to at least 500', async () => {
    await client.create(wt, { command: FORKS_AT_ONCE });
    expect(oomScoreAdj(await pidIn('sh.pid'))).toBeGreaterThanOrEqual(500);
    expect(oomScoreAdj(await pidIn('child.pid'))).toBeGreaterThanOrEqual(500);
  });

  it('logs no memory-limits line for terminals with limits', async () => {
    await run('exec sleep 60', SMALL);
    await run('exec sleep 60', SMALL);
    expect(stderrLines(new RegExp(SCOPES_OFF))).toEqual([]);
  });
});

describe.skipIf(NO_USER_MANAGER !== null)(withUserManager('terminal scopes on, before the daemon starts'), () => {
  it('resets the failed terminal units of its state directory at start, and only those', async () => {
    const ours = terminalUnit(host.stateDir, 'oldinstance', 1);
    const theirs = terminalUnit(`${host.stateDir}-other`, 'oldinstance', 1);
    failUnit(ours);
    failUnit(theirs);
    try {
      await startDaemon(userManagerEnv());
      await waitUntil(() => !isFailed(ours), `${ours} to be reset`, 10_000);
      expect(isFailed(theirs)).toBe(true);
    } finally {
      resetFailed(ours);
      resetFailed(theirs);
    }
  });

  it('finds the user manager once, however many terminals it starts', async () => {
    const wrapper = fakeProgram(join(host.dir, 'systemd-run'), 'exec systemd-run "$@"');
    await startDaemon({ ...userManagerEnv(), WTD_SYSTEMD_RUN: wrapper.program });
    await run('exec sleep 60');
    await run('exec sleep 60');
    const probes = wrapper.calls().filter((args) => args.at(-1) === 'true' && args.includes('--collect'));
    expect(probes).toHaveLength(1);
  });
});

describe('terminal scopes off', () => {
  let systemdRun: ReturnType<typeof failingSystemdRun>;

  beforeEach(async () => {
    systemdRun = failingSystemdRun(host.dir);
    await startDaemon({ ...userManagerEnv(), WTD_SYSTEMD_RUN: systemdRun.program });
  });

  it("says once why terminal scopes are off, and starts terminals in the daemon's cgroup", async () => {
    await waitUntil(() => stderrLines(/^terminal scopes:/).length > 0, 'the terminal scopes line');
    const lines = stderrLines(/^terminal scopes:/);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^terminal scopes: off \(.*Failed to connect to bus: No medium found.*\)$/);
    await run('echo $$ > sh.pid; exec sleep 60');
    expect(cgroupOf(await pidIn('sh.pid'))).toBe(cgroupOf(daemon.pid));
  });

  it('reports a SIGKILL exit with oom false', async () => {
    const termId = await run('kill -KILL $$');
    expect(await client.waitFor('termExited', (m) => m.termId === termId, { timeout: 10_000 })).toMatchObject({
      signal: 'SIGKILL',
      oom: false,
    });
  });

  it('starts terminals with memory limits, saying once that it ignores them', async () => {
    await run('exec sleep 60');
    expect(stderrLines(new RegExp(SCOPES_OFF))).toEqual([]);
    await run('echo one > one.pid; exec sleep 60', SMALL);
    await run('echo two > two.pid; exec sleep 60', { high: '1G' });
    await waitUntil(() => existsSync(join(wt, 'one.pid')) && existsSync(join(wt, 'two.pid')), 'both terminals to run');
    expect(stderrLines(new RegExp(SCOPES_OFF))).toEqual([SCOPES_OFF]);
  });

  it('raises the oom_score_adj of the shell and of a child it forks at once to at least 500', async () => {
    await client.create(wt, { command: FORKS_AT_ONCE });
    expect(oomScoreAdj(await pidIn('sh.pid'))).toBeGreaterThanOrEqual(500);
    expect(oomScoreAdj(await pidIn('child.pid'))).toBeGreaterThanOrEqual(500);
  });

  it('serves from the cgroup it was started in', () => {
    expect(cgroupOf(daemon.pid)).toBe(cgroupOf('self'));
  });

  it('asks systemd-run only once, for the probe', async () => {
    await run('exec sleep 60', SMALL);
    await run('exec sleep 60');
    expect(systemdRun.calls()).toHaveLength(1);
  });
});

describe.skipIf(NO_USER_MANAGER !== null)(withUserManager('daemon placement'), () => {
  /** The pid of the daemon serving `client`, from a terminal's WTD_TERMINAL. */
  const servingPid = async (via: DaemonClient): Promise<number> => {
    await via.watch(repo);
    const term = await via.create(wt, { command: 'echo "$WTD_TERMINAL" > tag; exec sleep 60' });
    const tag = await waitUntil(() => {
      const file = join(wt, 'tag');
      return existsSync(file) && readFileSync(file, 'utf8').endsWith('\n') ? readFileSync(file, 'utf8').trim() : undefined;
    }, 'the terminal tag');
    expect(tag.endsWith(`/${String(term.termId)}`)).toBe(true);
    return Number(tag.split('/')[0]);
  };

  it('puts a daemon started by dialing into a daemon scope of its own, not the dialing process’s cgroup', async () => {
    const bridge = host.wtd(['connect'], userManagerEnv());
    const { stdout, stdin } = bridge.child;
    if (stdout === null || stdin === null) throw new Error('wtd connect has no stdio pipes');
    const via = DaemonClient.over(stdout, stdin);
    await via.handshake();
    const pid = await servingPid(via);
    expect(cgroupOf(pid)).toMatch(scopePath(host.stateDir, 'daemon'));
    expect(cgroupOf(pid)).not.toBe(cgroupOf(bridge.pid));
    via.close();
  });

  it("puts a daemon started in a terminal of another daemon into a daemon scope, not that terminal's scope", async () => {
    await startDaemon(userManagerEnv());
    const inner = DaemonHost.create();
    others.push(inner);
    // A trailing command, so bash does not exec the daemon in place of the shell.
    await run(`echo $$ > sh.pid; XDG_STATE_HOME='${inner.stateHome}' HOME='${inner.home}' ${process.execPath} ${BUNDLE} daemon; true`);
    const shell = await pidIn('sh.pid');
    await waitUntil(() => canConnect(inner.socket), 'the inner daemon socket', 10_000);
    const [pid] = inner.daemonPids();
    if (pid === undefined) throw new Error('no inner daemon');
    expect(cgroupOf(pid)).toMatch(scopePath(inner.stateDir, 'daemon'));
    expect(cgroupOf(pid)).not.toBe(cgroupOf(shell));
  });

  const UNIT = 'worktree-term-daemon.service';
  const unitTaken = unitState(UNIT)['LoadState'] !== 'not-found';

  it.skipIf(unitTaken)(`leaves a daemon running as ${UNIT} in that unit's cgroup`, async () => {
    const env = host.env(userManagerEnv());
    const setenv = Object.entries(env).flatMap(([key, value]) => ['-E', `${key}=${value ?? ''}`]);
    const started = spawnSync(
      'systemd-run',
      ['--user', '--quiet', '--collect', `--unit=${UNIT}`, ...setenv, process.execPath, BUNDLE, 'daemon'],
      {
        encoding: 'utf8',
      },
    );
    expect(started.status, started.stderr).toBe(0);
    try {
      await waitUntil(() => canConnect(host.socket), 'the daemon socket', 10_000);
      const pid = await servingPid(await host.client());
      expect(cgroupOf(pid).endsWith(`/${UNIT}`)).toBe(true);
    } finally {
      spawnSync('systemctl', ['--user', 'stop', UNIT], { stdio: 'ignore' });
      resetFailed(UNIT);
    }
  });

  it('reports a failure to enter its scope and serves on from the cgroup it was started in', async () => {
    const systemdRun = fakeProgram(join(host.dir, 'systemd-run'), 'exit 0');
    const busctl = fakeProgram(join(host.dir, 'busctl'), "echo 'Call failed: Access denied' >&2; exit 1");
    await startDaemon({ ...userManagerEnv(), WTD_SYSTEMD_RUN: systemdRun.program, WTD_BUSCTL: busctl.program });
    expect(busctl.calls()).toHaveLength(1);
    await waitUntil(() => daemon.stderr.includes('Call failed: Access denied'), 'the reported failure');
    expect(cgroupOf(daemon.pid)).toBe(cgroupOf('self'));
    await client.ok({ t: 'setChecked', worktree: wt, checked: true });
  });
});
