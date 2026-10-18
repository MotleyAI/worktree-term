import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { forwardToHub, type HubForward } from '../../src/hub/links/index.js';
import { hostPaths } from '../../src/platform/files/index.js';
import { DAEMON_PROTOCOL_VERSION, decodePrintCode, decodeRemoteFragment } from '../../src/protocol/index.js';
import { alive, makeRepo, waitUntil } from '../support/daemon-host.js';
import { exec, REPO_ROOT } from '../support/exec.js';
import { FakeDaemon } from '../support/fake-daemon.js';
import { FakeRemote, shellQuote } from '../support/fake-ssh.js';
import { HubClient } from '../support/hub-client.js';
import { freePort, HubHost, rawHttp } from '../support/hub-host.js';

// Opt-in: needs sshd on localhost accepting this user's key with BatchMode.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 300_000 });

const ALIAS = 'localhost';
const REMOTE = 1;

/**
 * `WTD_SSH` wrapper: the real `ssh` with every option the caller gave, the remote command run under
 * `home` so the test never touches this user's own installation; a `-W` forward is passed through as given.
 */
const sshWrapper = (dir: string, home: string): string => {
  const path = join(dir, 'ssh');
  writeFileSync(
    path,
    `#!/bin/sh
for a do
  if [ "$a" = -W ]; then exec ssh "$@"; fi
done
n=$#
for a do
  shift
  n=$((n - 1))
  if [ "$n" -eq 0 ]; then last=$a; else set -- "$@" "$a"; fi
done
q=$(printf '%s' "$last" | sed "s/'/'\\\\\\\\''/g")
exec ssh "$@" "exec env -u XDG_STATE_HOME -u XDG_CONFIG_HOME -u XDG_DATA_HOME HOME=${shellQuote(home)} /bin/sh -c '$q'"
`,
  );
  chmodSync(path, 0o755);
  return path;
};

const packageVersion = (): string => {
  const pkg: unknown = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  if (typeof pkg !== 'object' || pkg === null || !('version' in pkg) || typeof pkg.version !== 'string') throw new Error('no version');
  return pkg.version;
};

/** Pids of processes whose argv[0] is `ssh` and whose parent is `parent`. */
const sshChildrenOf = (parent: number): number[] =>
  procs()
    .filter((p) => p.ppid === parent && (p.argv[0] === 'ssh' || p.argv[0]?.endsWith('/ssh') === true))
    .map((p) => p.pid);

/** Pids of SSH control masters whose control path lies in `runDir`. */
const mastersIn = (runDir: string): number[] =>
  procs()
    .filter((p) => p.argv.join(' ').startsWith(`ssh: ${runDir}/`) && p.argv.join(' ').includes('[mux]'))
    .map((p) => p.pid);

const procs = (): { pid: number; ppid: number; argv: string[] }[] => {
  const found: { pid: number; ppid: number; argv: string[] }[] = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      const argv = readFileSync(`/proc/${name}/cmdline`, 'utf8')
        .split('\0')
        .filter((a) => a !== '');
      if (alive(Number(name))) found.push({ pid: Number(name), ppid, argv });
    } catch {
      // The process exited while we looked.
    }
  }
  return found;
};

let host: HubHost;
let remote: FakeRemote;
const servers: Server[] = [];
let remoteHome: string;

beforeAll(() => {
  const probe = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', ALIAS, 'true'], { encoding: 'utf8' });
  if (probe.status !== 0) throw new Error(`these tests need sshd on ${ALIAS} with key authentication: ${probe.stderr.trim()}`);
  const build = exec('pnpm', ['build']);
  if (build.status !== 0) throw new Error(`pnpm build failed:\n${build.stdout}${build.stderr}`);
});

beforeEach(async () => {
  host = await HubHost.createHub();
  remoteHome = realpathSync(mkdtempSync(join(tmpdir(), 'wtd-it-home-')));
  remote = new FakeRemote(ALIAS, remoteHome);
  host.sshProgram = sshWrapper(host.dir, remoteHome);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const server of servers.splice(0)) server.close();
  for (const pid of host.hubPids()) process.kill(pid, 'SIGKILL');
  for (const pid of mastersIn(host.runDir)) process.kill(pid, 'SIGTERM');
  await remote.cleanup();
  await host.cleanup();
  rmSync(remoteHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** Installs this checkout's bundle on localhost under the throwaway home. */
const install = async (): Promise<void> => {
  const run = host.wtd(['install-remote', ALIAS, '--node', process.execPath]).captureStdout();
  const exit = await run.exited;
  if (exit.code !== 0) throw new Error(`wtd install-remote failed: ${run.stderr}`);
};

/** Configures `localhost` as remote host `lh` with `repos`, and starts the hub. */
const startHub = async (repos: readonly string[] = []): Promise<void> => {
  host.writeConfig({ port: host.port, hosts: [{ name: 'lh', ssh: ALIAS, repos }] });
  await host.startHub();
};

const connectedInstance = async (client: HubClient, from = 0): Promise<string> => {
  const entry = await client.waitHost(REMOTE, (h) => h.status === 'connected', { from, timeout: 30_000 });
  if (entry.instance === null) throw new Error('connected without an instance');
  return entry.instance;
};

describe('remote host over real ssh', () => {
  it('installs with install-remote and round-trips a terminal through the remote daemon', async () => {
    await install();
    const repo = makeRepo(join(remoteHome, 'repo'));
    await startHub([repo]);
    const client = await host.session();
    const entry = await client.waitHost(REMOTE, (h) => h.status === 'connected', { timeout: 30_000 });
    expect(entry).toMatchObject({ idx: REMOTE, name: 'lh', remote: true, reason: null, daemonVersion: packageVersion(), repos: [repo] });
    await client.watch(REMOTE, repo);
    const term = await client.create(REMOTE, repo, { command: 'echo remote-$((6*7)); exec sleep 60' });
    await client.attach(REMOTE, term.termId);
    await client.waitOutput(REMOTE, term.termId, 'remote-42', 15_000);
    expect(remote.daemonPids()).toHaveLength(1);
  });

  it('reconnects to the same daemon after the hub’s ssh process is killed', async () => {
    await install();
    await startHub();
    const client = await host.session();
    const instance = await connectedInstance(client);
    const hub = host.record()?.pid ?? 0;
    const [pid] = sshChildrenOf(hub);
    if (pid === undefined) throw new Error('the hub runs no ssh process');
    const from = client.mark();
    process.kill(pid, 'SIGKILL');
    await client.waitHost(REMOTE, (h) => h.status === 'reconnecting', { from, timeout: 10_000 });
    expect(await connectedInstance(client, from)).toBe(instance);
    expect(remote.daemonPids()).toHaveLength(1);
  });

  it('reinstalls and restarts an outdated remote daemon', async () => {
    await install();
    const fake = await FakeDaemon.listen(remote.socket, {
      protocol: DAEMON_PROTOCOL_VERSION - 1,
      version: '0.0.1-old',
      instance: 'old_remote',
    });
    await startHub();
    const client = await host.session();
    expect(await client.waitHost(REMOTE, (h) => h.status === 'outdated', { timeout: 30_000 })).toMatchObject({ instance: 'old_remote' });
    const from = client.mark();
    const reply = await client.hubRequest({ t: 'reinstallDaemon', host: REMOTE }, 150_000);
    expect(reply).toEqual({ from: 'hub', m: { t: 'done', req: 1 } });
    expect(fake.shutdowns).toBeGreaterThanOrEqual(1);
    const entry = await client.waitHost(REMOTE, (h) => h.status === 'connected', { from, timeout: 30_000 });
    expect(entry.daemonVersion).toBe(packageVersion());
    expect(entry.instance).not.toBe('old_remote');
    expect(remote.releases()).toHaveLength(2);
  });

  it('spares the shared control master when one session closes', async () => {
    await install();
    await startHub();
    const first = await host.session();
    await connectedInstance(first);
    const masters = await waitUntil(
      () => {
        const found = mastersIn(host.runDir);
        return found.length === 1 ? found : undefined;
      },
      'one control master',
      10_000,
    );
    const hub = host.record()?.pid ?? 0;
    const firstClients = sshChildrenOf(hub);
    expect(firstClients).toHaveLength(1);
    first.close();
    await waitUntil(() => firstClients.every((pid) => !alive(pid)), 'the closed session’s ssh process to end', 10_000);
    expect(mastersIn(host.runDir)).toEqual(masters);
    const second = await host.session();
    await connectedInstance(second);
    expect(mastersIn(host.runDir)).toEqual(masters);
    expect(sshChildrenOf(hub).filter((pid) => !firstClients.includes(pid))).toHaveLength(1);
  });
});

/** Pids of `ssh -W` forwards whose parent is `parent`. */
const forwardsOf = (parent: number): number[] =>
  procs()
    .filter((p) => p.ppid === parent && p.argv.includes('-W'))
    .map((p) => p.pid);

/** Starts localhost's hub under the throwaway home with `wtd ui --print-code`, without a control master; returns its port and code. */
const printCode = (): { port: number; code: string } => {
  const run = spawnSync(host.sshProgram ?? 'ssh', ['-o', 'BatchMode=yes', ALIAS, '"$HOME/.local/bin/wtd" ui --print-code'], {
    encoding: 'utf8',
  });
  if (run.status !== 0) throw new Error(`wtd ui --print-code failed: ${run.stderr}`);
  return decodePrintCode(run.stdout);
};

/** A local listener on a free port relaying each connection to `remotePort` on localhost with `forwardToHub`. */
const tunnel = async (remotePort: number): Promise<{ port: number; forwards: HubForward[] }> => {
  vi.stubEnv('WTD_SSH', host.sshProgram ?? 'ssh');
  const paths = hostPaths({ env: { XDG_STATE_HOME: host.stateHome }, home: host.home, host: 'local' });
  const forwards: HubForward[] = [];
  const server = createServer((socket) => {
    forwards.push(forwardToHub(paths, ALIAS, remotePort, socket));
  });
  servers.push(server);
  const port = await freePort();
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { port, forwards };
};

/** An open connection to 127.0.0.1:`port` and a promise of its close. */
const held = async (port: number): Promise<{ socket: Socket; closed: Promise<void> }> => {
  const socket = connect(port, '127.0.0.1');
  socket.on('error', () => undefined);
  const closed = new Promise<void>((resolve) => {
    socket.once('close', () => {
      resolve();
    });
  });
  await new Promise<void>((resolve) => {
    socket.once('connect', () => {
      resolve();
    });
  });
  return { socket, closed };
};

/** Configures localhost's hub with a repo and a free port, and the local hub with `lh` on the tunnel port `tunnelPort`. */
const configureHubs = async (): Promise<{ repo: string; remotePort: number; tunnelPort: number }> => {
  await install();
  const repo = makeRepo(join(remoteHome, 'repo'));
  const remotePort = await freePort();
  let tunnelPort = await freePort();
  while (tunnelPort === remotePort) tunnelPort = await freePort(); // NOSONAR(S9382) — retries until the ports differ
  remote.writeHubConfig({ port: remotePort, repos: [repo] });
  host.writeConfig({ port: host.port, hosts: [{ name: 'lh', ssh: ALIAS, port: tunnelPort }] });
  return { repo, remotePort, tunnelPort };
};

/** Sends `openHub` for `lh` and returns the opened page's port and code. */
const openLh = async (client: HubClient): Promise<{ port: number; code: string }> => {
  const from = client.mark();
  client.send({ t: 'openHub', req: 1000, host: REMOTE });
  const reply = await client.waitFor(['hubOpened', 'error'], (m) => m.req === 1000, { from, timeout: 60_000 });
  if (reply.t !== 'hubOpened') throw new Error(`openHub failed: ${JSON.stringify(reply)}`);
  const url = new URL(reply.url);
  return { port: Number(url.port), code: decodeRemoteFragment(url.hash.slice(1)).code };
};

describe('remote hub over real ssh', () => {
  it('forwards to the remote hub with ssh -W when no control master exists', async () => {
    const { remotePort } = await configureHubs();
    expect(printCode().port).toBe(remotePort);
    expect(mastersIn(host.runDir)).toEqual([]);
    const { port, forwards } = await tunnel(remotePort);
    const response = await rawHttp(port, 'GET', '/');
    expect(response.status).toBe(200);
    expect(forwards).toHaveLength(1);
    await expect(forwards[0]?.ended).resolves.not.toMatch(/open failed|forwarding failed/);
  });

  it('opens the remote hub through the local hub over the existing control master', async () => {
    const { repo, tunnelPort } = await configureHubs();
    await host.startHub();
    const client = await host.session();
    await connectedInstance(client);
    const masters = mastersIn(host.runDir);
    expect(masters).toHaveLength(1);

    const { port, code } = await openLh(client);
    expect(port).toBe(tunnelPort);
    expect((await rawHttp(port, 'GET', '/')).status).toBe(200);
    const page = await HubClient.open(`ws://127.0.0.1:${String(port)}/ws`, {
      protocols: ['wtd', `wtd.code.${code}`],
      origin: `http://127.0.0.1:${String(port)}`,
    });
    const { hosts } = await page.handshake();
    expect(hosts.hosts[0]?.repos).toEqual([repo]);
    expect(mastersIn(host.runDir)).toEqual(masters);
    page.close();
  });

  it('reports a forward to a port nothing listens on with the line ssh wrote', async () => {
    await install();
    const { port, forwards } = await tunnel(await freePort());
    const { closed } = await held(port);
    await closed;
    await expect(forwards[0]?.ended).resolves.toMatch(/open failed|forwarding failed/);
  });

  it('ends the forwards when the control master is lost', async () => {
    await configureHubs();
    await host.startHub();
    const client = await host.session();
    await connectedInstance(client);
    const { port } = await openLh(client);
    const { closed } = await held(port);
    const hub = host.record()?.pid ?? 0;
    const forwards = await waitUntil(() => {
      const found = forwardsOf(hub);
      return found.length > 0 ? found : undefined;
    }, 'a forward of the held connection');

    for (const pid of mastersIn(host.runDir)) process.kill(pid, 'SIGTERM');
    await closed;
    await waitUntil(() => forwards.every((pid) => !alive(pid)), 'the forwards to end', 10_000);
  });

  it('leaves no ssh process behind once the hub stops', async () => {
    await configureHubs();
    await host.startHub();
    const client = await host.session();
    await connectedInstance(client);
    const { port } = await openLh(client);
    const { closed } = await held(port);
    const hub = host.record()?.pid ?? 0;
    await waitUntil(() => forwardsOf(hub).length > 0, 'a forward of the held connection');
    const children = sshChildrenOf(hub);

    process.kill(hub, 'SIGTERM');
    await closed;
    await waitUntil(() => host.hubPids().length === 0, 'the hub to exit', 10_000);
    await waitUntil(() => children.every((pid) => !alive(pid)), 'the hub’s ssh processes to end', 10_000);
    await expect(rawHttp(port, 'GET', '/')).rejects.toThrow();
  });
});
