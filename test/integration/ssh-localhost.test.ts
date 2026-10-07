import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION } from '../../src/protocol/index.js';
import { alive, makeRepo, waitUntil } from '../support/daemon-host.js';
import { exec, REPO_ROOT } from '../support/exec.js';
import { FakeDaemon } from '../support/fake-daemon.js';
import { FakeRemote, shellQuote } from '../support/fake-ssh.js';
import type { HubClient } from '../support/hub-client.js';
import { HubHost } from '../support/hub-host.js';

// Opt-in: needs sshd on localhost accepting this user's key with BatchMode.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 300_000 });

const ALIAS = 'localhost';
const REMOTE = 1;

/**
 * `WTD_SSH` wrapper: the real `ssh` with every option the caller gave, the remote command run under
 * `home` so the test never touches this user's own installation.
 */
const sshWrapper = (dir: string, home: string): string => {
  const path = join(dir, 'ssh');
  writeFileSync(
    path,
    `#!/bin/sh
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
    const fake = await FakeDaemon.listen(remote.socket, { protocol: PROTOCOL_VERSION - 1, version: '0.0.1-old', instance: 'old_remote' });
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
