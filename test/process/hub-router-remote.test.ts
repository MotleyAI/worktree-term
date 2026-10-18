import { hostname } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { alive, residentBytes, waitUntil } from '../support/daemon-host.js';
import { loginRun } from '../support/fake-ssh.js';
import type { HostEntry, HubClient } from '../support/hub-client.js';
import {
  ANY_INSTANCE,
  configure,
  connectedHost,
  fx,
  installedBox,
  MiB,
  packageVersion,
  REMOTE_TIMEOUT,
  remoteInstance,
  useHubRouterHost,
} from '../support/hub-router.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });
useHubRouterHost();

const LOGIN_URL: unknown = expect.stringMatching(/^https:\/\/login\.tailscale\.com\/a\/wtd\d+$/);

/** Host `idx`'s entries in every `hosts` message from `from` on. */
const entriesOf = (client: HubClient, idx: number, from = 0): HostEntry[] =>
  client.messages.slice(from).flatMap((m) => (m.t === 'hosts' ? m.hosts.filter((h) => h.idx === idx) : []));

/** Host `idx`'s statuses from `from` on, without consecutive repeats. */
const statusesOf = (client: HubClient, idx: number, from = 0): string[] =>
  entriesOf(client, idx, from)
    .map((h) => h.status)
    .filter((status, i, all) => i === 0 || all[i - 1] !== status);

/** The SSH runs of `box` that ran the connect command. */
const connectRuns = (): number[] =>
  fx.ssh
    .calls()
    .filter((call) => call.alias === 'box' && call.command.includes('connect'))
    .map((call) => call.pid);

/** Host 1's entry once it needs login, and the login URL. */
const needsLogin = async (client: HubClient, from = 0): Promise<{ entry: HostEntry; url: string }> => {
  const entry = await client.waitHost(1, (h) => h.status === 'needs-login', { from, timeout: REMOTE_TIMEOUT });
  if (entry.login === null) throw new Error('needs-login without a login URL');
  return { entry, url: entry.login };
};

describe('remote hosts', () => {
  it('lists configured remote hosts after the local host, in configuration order', async () => {
    fx.ssh.failHost('b-alias', 'ssh: Could not resolve hostname b-alias');
    fx.ssh.failHost('a-alias', 'ssh: Could not resolve hostname a-alias');
    configure([
      { name: 'b', ssh: 'b-alias' },
      { name: 'a', ssh: 'a-alias', repos: ['/srv/a'] },
    ]);
    const client = await fx.host.session();
    expect(client.hosts().map((h) => [h.idx, h.name, h.remote, h.repos])).toEqual([
      [0, hostname().slice(0, 64) || 'local', false, [fx.repo]],
      [1, 'b', true, []],
      [2, 'a', true, ['/srv/a']],
    ]);
  });

  it('connects a remote host through its SSH command, reporting its name, index and the remote daemon’s instance', async () => {
    const { remote, remoteRepo } = await installedBox();
    const client = await fx.host.session();
    const entry = await connectedHost(client, 1);
    expect(entry).toEqual({
      idx: 1,
      name: 'box',
      remote: true,
      status: 'connected',
      reason: null,
      daemonVersion: packageVersion(),
      instance: ANY_INSTANCE,
      login: null,
      repos: [remoteRepo],
    });
    expect(remote.daemonPids()).toHaveLength(1);
    expect((await remote.hello()).instance).toBe(entry.instance);
    const link = fx.ssh.calls().find((call) => call.alias === 'box' && call.command.includes('connect'));
    expect(link?.command).toBe('"$HOME/.local/bin/wtd" connect');
    expect(link?.args.slice(0, 12)).toEqual([
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=10',
      '-o',
      'ControlMaster=auto',
      '-o',
      'ControlPersist=10m',
      '-o',
      `ControlPath=${fx.host.runDir}/ssh-%C`,
      '-o',
      'ServerAliveInterval=15',
    ]);
  });

  it('round-trips requests, terminals and output through a remote host', async () => {
    const { remoteRepo } = await installedBox();
    const client = await fx.host.session();
    await connectedHost(client, 1);
    const state = await client.watch(1, remoteRepo);
    expect(state.worktrees.map((w) => w.path)).toEqual([remoteRepo]);
    const term = await client.create(1, remoteRepo);
    await client.attach(1, term.termId);
    client.sendInput(1, term.termId, 'echo remote-$((40+2))-trip\r');
    await client.waitOutput(1, term.termId, 'remote-42-trip', 10_000);
    expect(client.daemonEvents(0, 'termCreated')).toEqual([]);
  });

  it('reports reconnecting, then connected to the same daemon, when the SSH process is killed', async () => {
    await installedBox();
    const client = await fx.host.session();
    const first = await remoteInstance(client, 1);
    const pids = await waitUntil(() => {
      const live = fx.ssh.livePids('box');
      return live.length > 0 ? live : undefined;
    }, 'the hub’s SSH process');
    const from = client.mark();
    for (const pid of pids) process.kill(pid, 'SIGKILL');
    expect(await client.waitHost(1, (h) => h.status === 'reconnecting', { from })).toMatchObject({ instance: null });
    expect(await remoteInstance(client, 1, from)).toBe(first);
  });

  it('reports a host whose SSH command keeps failing as down, naming SSH’s last error line', async () => {
    fx.ssh.failHost('box', 'ssh: Could not resolve hostname box');
    configure([{ name: 'box', ssh: 'box' }]);
    const client = await fx.host.session();
    expect(await client.waitHost(1, (h) => h.status === 'reconnecting')).toMatchObject({
      reason: 'ssh: Could not resolve hostname box',
      instance: null,
    });
    expect(await client.waitHost(1, (h) => h.status === 'down', { timeout: 10_000 })).toMatchObject({
      reason: 'ssh: Could not resolve hostname box',
      daemonVersion: null,
      instance: null,
    });
    expect(client.hosts()[0]?.status).toBe('connected');
  });

  it('reports a remote without wtd as down, with a reason', async () => {
    fx.ssh.addHost('box');
    configure([{ name: 'box', ssh: 'box' }]);
    const client = await fx.host.session();
    const entry = await client.waitHost(1, (h) => h.status === 'down', { timeout: 10_000 });
    expect(entry.reason).toEqual(expect.stringMatching(/\S/));
  });

  it('keeps its memory bounded and the reason short when SSH writes 8 MiB to standard error without a newline', async () => {
    const before = residentBytes(fx.hub.pid);
    fx.ssh.spewHost('box', 8 * MiB);
    configure([{ name: 'box', ssh: 'box' }]);
    const client = await fx.host.session();
    const entry = await client.waitHost(1, (h) => h.status === 'down', { timeout: 30_000 });
    expect(entry.reason?.length ?? 0).toBeGreaterThan(0);
    expect(entry.reason?.length ?? 0).toBeLessThanOrEqual(1024);
    expect(residentBytes(fx.hub.pid) - before).toBeLessThan(16 * MiB);
  });

  it('ends an SSH process that writes over 1 MiB to standard error instead of leaving its link stalled', async () => {
    await installedBox();
    fx.ssh.noisyHost('box', 2 * MiB);
    const client = await fx.host.session();
    const entry = await client.waitHost(1, (h) => h.status === 'reconnecting' || h.status === 'down', { timeout: REMOTE_TIMEOUT });
    expect(entry.reason).toMatch(/^x{1,1024}$/);
  });

  it('answers requests to a down remote host with host-unavailable', async () => {
    fx.ssh.failHost('box', 'ssh: Could not resolve hostname box');
    configure([{ name: 'box', ssh: 'box' }]);
    const client = await fx.host.session();
    await client.waitHost(1, (h) => h.status === 'reconnecting' || h.status === 'down');
    const reply = await client.request(1, { t: 'watchRepo', repo: '/srv/app' });
    expect(reply).toMatchObject({ from: 'hub', m: { t: 'error', req: 1, host: 1, code: 'host-unavailable' } });
  });

  it('kills SSH processes of a closed session that ignore SIGTERM', async () => {
    fx.ssh.addHost('box');
    fx.ssh.hangHost('box');
    configure([{ name: 'box', ssh: 'box' }]);
    const client = await fx.host.session();
    const pids = await waitUntil(() => {
      const live = fx.ssh.livePids('box');
      return live.length > 0 && live;
    }, 'an SSH process for box');
    client.close();
    await waitUntil(() => pids.every((pid) => !alive(pid)), 'the session’s SSH processes to be killed', 5000);
    expect(pids.filter(alive)).toEqual([]);
  });

  it('ends the SSH processes of a closed session', async () => {
    await installedBox();
    const client = await fx.host.session();
    await connectedHost(client, 1);
    const pids = fx.ssh.livePids('box');
    expect(pids.length).toBeGreaterThan(0);
    client.close();
    await waitUntil(() => pids.every((pid) => !alive(pid)), 'the session’s SSH processes to end', 5000);
  });
});

describe('Tailscale SSH check login', () => {
  it('reports needs-login with the URL within 1 s of the banner, then connects over the same SSH process once approved', async () => {
    await installedBox();
    fx.ssh.loginHost('box');
    const before = connectRuns().length;
    const client = await fx.host.session();
    await waitUntil(() => connectRuns().length > before, 'the hub’s SSH process for box');
    const entry = await client.waitHost(1, (h) => h.status === 'needs-login', { timeout: 5000 });
    const receivedAt = Date.now();
    expect(entry).toMatchObject({ status: 'needs-login', login: LOGIN_URL, reason: null, daemonVersion: null, instance: null });
    const url = entry.login ?? '';
    expect(receivedAt - fx.ssh.loginWrittenAt(url)).toBeLessThanOrEqual(1000);
    expect(connectRuns()).toHaveLength(before + 1);
    fx.ssh.approveLogin(url);
    expect(await connectedHost(client, 1)).toMatchObject({ login: null, reason: null });
    expect(connectRuns()).toHaveLength(before + 1);
    expect(alive(loginRun(url))).toBe(true);
    expect(statusesOf(client, 1)).toEqual(['connecting', 'needs-login', 'connected']);
  });

  it('reports reconnecting with SSH’s reason and a null login when the check expires, then the next run’s URL', async () => {
    await installedBox();
    fx.ssh.loginHost('box');
    const client = await fx.host.session();
    const { url: first } = await needsLogin(client);
    const from = client.mark();
    fx.ssh.expireLogin(first, 'Tailscale SSH check timed out');
    expect(await client.waitHost(1, (h) => h.status === 'reconnecting', { from })).toMatchObject({
      reason: 'Tailscale SSH check timed out',
      login: null,
    });
    const { url: second } = await needsLogin(client, from);
    expect(second).not.toBe(first);
  });

  it('answers a request to a needs-login host with host-unavailable', async () => {
    await installedBox();
    fx.ssh.loginHost('box');
    const client = await fx.host.session();
    await needsLogin(client);
    const reply = await client.request(1, { t: 'watchRepo', repo: '/srv/app' });
    expect(reply).toMatchObject({ from: 'hub', m: { t: 'error', req: 1, host: 1, code: 'host-unavailable' } });
  });

  it('redials every other needs-login session once one session’s link greets, leaving connected sessions alone', async () => {
    await installedBox();
    const c = await fx.host.session();
    const cEntry = await connectedHost(c, 1);
    fx.ssh.loginHost('box');
    const a = await fx.host.session();
    const { url: aUrl } = await needsLogin(a);
    const b = await fx.host.session();
    const { url: bUrl } = await needsLogin(b);
    const bRun = loginRun(bUrl);
    expect(bRun).not.toBe(loginRun(aUrl));
    const runsBefore = connectRuns().length;
    const fromB = b.mark();
    const fromC = c.mark();
    fx.ssh.skipLogin('box');
    fx.ssh.approveLogin(aUrl);
    await connectedHost(a, 1);
    expect(await connectedHost(b, 1, fromB)).toMatchObject({ login: null });
    expect(statusesOf(b, 1, fromB)).toEqual(['connecting', 'connected']);
    expect(entriesOf(b, 1, fromB)[0]).toMatchObject({ status: 'connecting', login: null });
    await waitUntil(() => !alive(bRun), 'B’s original SSH process to end', 5000);
    expect(connectRuns().length).toBeGreaterThan(runsBefore);
    for (const entry of entriesOf(c, 1, fromC)) expect(entry).toEqual(cEntry);
  });
});
