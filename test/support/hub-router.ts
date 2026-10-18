import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect } from 'vitest';
import type { Terminal } from '../../src/protocol/index.js';
import { addWorktree, makeRepo, sleep, waitUntil, type WtdProcess } from './daemon-host.js';
import { currentNodeDir, FakeSsh, installRemote, type FakeRemote } from './fake-ssh.js';
import type { HubClient } from './hub-client.js';
import { HubHost } from './hub-host.js';
import { REPO_ROOT } from './exec.js';

export let host: HubHost;
export let hub: WtdProcess;
export let repo: string;
export let wt: string;
export let ssh: FakeSsh;

/** Registers the per-test setup and cleanup. */
export const useHubRouterHost = (): void => {
  beforeEach(async () => {
    host = await HubHost.createHub();
    ssh = new FakeSsh(join(host.dir, 'ssh'));
    host.sshProgram = ssh.program;
    repo = makeRepo(join(host.dir, 'repo'));
    wt = addWorktree(repo, join(host.dir, 'wt'), 'wt');
    host.writeRepos([repo]);
    hub = await host.startHub();
  });

  afterEach(async () => {
    // Stop the hub first, so it starts no SSH runs while the fake remotes go away.
    for (const pid of host.hubPids()) process.kill(pid, 'SIGKILL');
    await waitUntil(() => host.hubPids().length === 0, 'hubs to exit').catch(() => undefined);
    await ssh.cleanup();
    await host.cleanup();
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
export const started = async (client: HubClient, command: string | null, worktree = wt): Promise<Terminal> => {
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
  const client = await host.session();
  await connected(client);
  await client.watch(0, repo);
  return client;
};

export const REMOTE_TIMEOUT = 20_000;
export const INSTALL_TIMEOUT = 150_000;

export interface RemoteHostConfig {
  name: string;
  ssh: string;
  repos?: readonly string[];
  roots?: readonly string[];
}

/** Writes `config.json` with the local repo, `hosts` and any other keys. */
export const configure = (hosts: readonly RemoteHostConfig[], extra: Record<string, unknown> = {}): void => {
  host.writeConfig({ port: host.port, repos: [repo], hosts, ...extra });
};

/** A remote whose PATH offers this runner's Node, so the hub's installer finds one there. */
export const nodeRemote = (alias: string): FakeRemote =>
  ssh.addHost(alias, { path: `${currentNodeDir(join(ssh.dir, `node-${alias}`))}:${ssh.pathWithoutNode}` });

/** The remote `box`, installed, holding one repo, configured as host 1. */
export const installedBox = async (): Promise<{ remote: FakeRemote; remoteRepo: string }> => {
  const remote = nodeRemote('box');
  await installRemote(host, ssh, 'box');
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
