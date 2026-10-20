import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect } from 'vitest';
import type { Terminal } from '../../src/protocol/index.js';
import { addWorktree, makeRepo, sleep, waitUntil, type WtdProcess } from './daemon-host.js';
import { currentNodeDir, FakeSsh, installRemote, type FakeRemote } from './fake-ssh.js';
import type { HubClient } from './hub-client.js';
import { HubHost } from './hub-host.js';
import { REPO_ROOT } from './exec.js';

/** Hub budgets for opening a remote hub, probing its forward and installing, shortened for every hub started here. */
const OPEN_MS = 10_000;
const PROBE_MS = 3000;
const INSTALL_MS = 30_000;
const HUB_ENV = { WTD_HUB_OPEN_MS: String(OPEN_MS), WTD_HUB_PROBE_MS: String(PROBE_MS), WTD_HUB_INSTALL_MS: String(INSTALL_MS) };

/** Per-test values, refilled by the `beforeEach` that `useHubRouterHost` registers. */
class HubRouterFixture {
  host!: HubHost;
  hub!: WtdProcess;
  repo!: string;
  wt!: string;
  ssh!: FakeSsh;
}

export const fx = new HubRouterFixture();

/** Registers the per-test setup and cleanup. */
export const useHubRouterHost = (): void => {
  beforeEach(async () => {
    fx.host = await HubHost.createHub();
    fx.ssh = new FakeSsh(join(fx.host.dir, 'ssh'));
    fx.host.sshProgram = fx.ssh.program;
    fx.repo = makeRepo(join(fx.host.dir, 'repo'));
    fx.wt = addWorktree(fx.repo, join(fx.host.dir, 'wt'), 'wt');
    fx.host.writeRepos([fx.repo]);
    fx.hub = await fx.host.startHub(HUB_ENV);
  });

  afterEach(async () => {
    // Stop the hub first, so it starts no SSH runs while the fake remotes go away.
    for (const pid of fx.host.hubPids()) process.kill(pid, 'SIGKILL');
    await waitUntil(() => fx.host.hubPids().length === 0, 'hubs to exit').catch(() => undefined);
    await fx.ssh.cleanup();
    await fx.host.cleanup();
  });
};

export const ANY_TEXT: unknown = expect.any(String);
export const ANY_INSTANCE: unknown = expect.stringMatching(/^[A-Za-z0-9_-]{1,64}$/);

export const KiB = 1024;
export const MiB = 1024 * KiB;

export const packageVersion = (): string => {
  const pkg: unknown = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  if (typeof pkg !== 'object' || pkg === null || !('version' in pkg) || typeof pkg.version !== 'string') throw new Error('no version');
  return pkg.version;
};

export const connected = (client: HubClient, from = 0, timeout = 10_000): Promise<{ instance: string | null }> =>
  client.waitHost(0, (h) => h.status === 'connected', { from, timeout });

/** Instance of host 0 once `connected`. */
export const instanceOf = async (client: HubClient, from = 0): Promise<string> => {
  const { instance } = await connected(client, from);
  if (instance === null) throw new Error('connected without an instance');
  return instance;
};

/** Creates a terminal, attaches, and for a shell waits until it ran a command. */
export const started = async (client: HubClient, command: string | null, worktree = fx.wt): Promise<Terminal> => {
  const term = await client.create(0, worktree, { command });
  await client.attach(0, term.termId);
  if (command === null) {
    client.sendInput(0, term.termId, 'echo READY-$((6*7))\r');
    await client.waitOutput(0, term.termId, 'READY-42\r\n', 10_000);
    await sleep(300);
  }
  return term;
};

/** A connected session watching the repo. */
export const watching = async (): Promise<HubClient> => {
  const client = await fx.host.session();
  await connected(client);
  await client.watch(0, fx.repo);
  return client;
};

export const REMOTE_TIMEOUT = 20_000;
export const INSTALL_TIMEOUT = INSTALL_MS + 15_000;

export interface RemoteHostConfig {
  name: string;
  ssh: string;
  port?: number;
  repos?: readonly string[];
  roots?: readonly string[];
}

/** Writes `config.json` with the local repo, `hosts` and any other keys. */
export const configure = (hosts: readonly RemoteHostConfig[], extra: Record<string, unknown> = {}): void => {
  fx.host.writeConfig({ port: fx.host.port, repos: [fx.repo], hosts, ...extra });
};

/** A remote whose PATH offers this runner's Node, so the hub's installer finds one there. */
export const nodeRemote = (alias: string): FakeRemote => {
  const nodeDir = currentNodeDir(join(fx.ssh.dir, 'node-' + alias));
  return fx.ssh.addHost(alias, { path: `${nodeDir}:${fx.ssh.pathWithoutNode}` });
};

/** The remote `box`, installed, holding one repo, configured as host 1. */
export const installedBox = async (): Promise<{ remote: FakeRemote; remoteRepo: string }> => {
  const remote = nodeRemote('box');
  await installRemote(fx.host, fx.ssh, 'box');
  const remoteRepo = makeRepo(join(remote.home, 'src', 'app'));
  configure([{ name: 'box', ssh: 'box', repos: [remoteRepo] }]);
  return { remote, remoteRepo };
};

export const connectedHost = (client: HubClient, idx: number, from = 0, timeout = REMOTE_TIMEOUT): Promise<{ instance: string | null }> =>
  client.waitHost(idx, (h) => h.status === 'connected', { from, timeout });

/** Instance of host `idx` once `connected`. */
export const remoteInstance = async (client: HubClient, idx: number, from = 0): Promise<string> => {
  const { instance } = await connectedHost(client, idx, from);
  if (instance === null) throw new Error('connected without an instance');
  return instance;
};

export const PRINT_CODE = '"$HOME/.local/bin/wtd" ui --print-code';

/** Restarts the hub with `env` over the usual budgets, e.g. a shorter `WTD_HUB_OPEN_MS`. */
export const restartHub = async (env: Record<string, string>): Promise<void> => {
  fx.hub.kill('SIGTERM');
  await fx.hub.exited;
  fx.hub = await fx.host.startHub({ ...HUB_ENV, ...env });
};

/** The SSH runs of `box` that ran the connect command. */
export const connectRuns = (): number[] =>
  fx.ssh
    .calls()
    .filter((call) => call.alias === 'box' && call.command.includes('connect'))
    .map((call) => call.pid);

export const LOGIN_URL: unknown = expect.stringMatching(/^https:\/\/login\.tailscale\.com\/a\/wtd\d+$/);

/** Reads `config.json` as JSON. */
export const configFile = (): unknown => JSON.parse(readFileSync(fx.host.configPath, 'utf8'));
