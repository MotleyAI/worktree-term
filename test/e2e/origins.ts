import type { Locator, Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { addWorktree, git, makeRepo } from '../support/daemon-host.js';
import { currentNodeDir, installRemote, pathWithout, type FakeRemote, type FakeSsh } from '../support/fake-ssh.js';
import type { HubHost } from '../support/hub-host.js';
import { byTestId, groupTab, TID, worktreeAt } from './contract.js';
import { expect, hostEntries, hubRequests, LOCAL } from './fixture.js';
import type { WireRecorder } from './wire.js';

/** Programs kept off a remote's PATH, Node aside: Node's tools, `gh`, which an origin would make the daemon run, and `sshfs`. */
const OFF_REMOTE_PATH = new Set(['node', 'nodejs', 'npm', 'npx', 'corepack', 'pnpm', 'yarn', 'gh', 'sshfs']);

/** `origin` URL of the project `name`, on a host that never resolves. */
export const originUrl = (name: string): string => `https://git.invalid/acme/${name}.git`;

/** A repo at `path` with `origin` set to the project `origin`'s URL (none when null) and a linked worktree `<path>-<branch>` per branch; real paths. */
export const cloneAt = (path: string, origin: string | null, branches: readonly string[] = []): { repo: string; worktrees: string[] } => {
  const repo = makeRepo(path);
  if (origin !== null) git(repo, 'remote', 'add', 'origin', originUrl(origin));
  return { repo, worktrees: branches.map((branch) => addWorktree(repo, `${repo}-${branch}`, branch)) };
};

/** Puts the hub and its local daemon on a PATH without `gh` and `sshfs`. */
export const plainPath = (hub: HubHost): void => {
  hub.extraEnv = { ...hub.extraEnv, PATH: pathWithout(join(hub.dir, 'plain-bin'), new Set(['gh', 'sshfs'])) };
};

/** Makes `alias` reachable with this runner's Node and without `gh`; called again after `failHost`, it makes it reachable again. */
export const reachable = (ssh: FakeSsh, alias: string): FakeRemote => {
  const nodeDir = join(ssh.dir, `node-${alias}`);
  if (!existsSync(nodeDir)) currentNodeDir(nodeDir);
  return ssh.addHost(alias, { path: `${nodeDir}:${pathWithout(join(ssh.dir, 'plain-bin'), OFF_REMOTE_PATH)}` });
};

/** A reachable remote `alias` with this checkout installed. */
export const installedRemote = async (hub: HubHost, ssh: FakeSsh, alias: string): Promise<FakeRemote> => {
  const remote = reachable(ssh, alias);
  await installRemote(hub, ssh, alias);
  return remote;
};

/** A sidebar row as `<host index> <path>`. */
export const row = (host: number, path: string): string => `${String(host)} ${path}`;

/** The listed sidebar rows, in order, as `row` gives them. */
export const listedRows = (page: Page): Promise<string[]> =>
  page
    .locator(byTestId(TID.worktree))
    .evaluateAll((rows: HTMLElement[]) => rows.map((r) => `${r.dataset['host'] ?? '?'} ${r.dataset['path'] ?? ''}`));

/** The pill of `host`'s row at `path`. */
export const pillOf = (page: Page, host: number, path: string): Locator =>
  page.locator(worktreeAt(host, path)).locator(byTestId(TID.hostPill));

/** Clicks the tab listing `entry`, once shown, and waits until it is selected. */
export const selectGroup = async (page: Page, entry: string): Promise<void> => {
  await expect(page.locator(groupTab(entry))).toBeVisible({ timeout: 20_000 });
  await page.locator(groupTab(entry)).click();
  await expect(page.locator(groupTab(entry))).toHaveAttribute('aria-selected', 'true');
};

/** Clicks the label of `host`'s row at `path`, once shown, and waits until it is selected. */
export const selectRow = async (page: Page, host: number, path: string): Promise<void> => {
  await expect(page.locator(worktreeAt(host, path))).toBeVisible({ timeout: 20_000 });
  await page.locator(worktreeAt(host, path)).locator(byTestId(TID.worktreeLabel)).click();
  await expect(page.locator(worktreeAt(host, path))).toHaveAttribute('aria-selected', 'true');
};

/** Repos the page asked `host` to watch since `from`, in order. */
export const watchesSent = (wire: WireRecorder, host: number, from = 0): string[] =>
  wire.sentToHost(host, from).flatMap((m) => (m.t === 'watchRepo' ? [m.repo] : []));

/** How many `discoverRepos` the page sent for `host`. */
export const discoveriesSent = (wire: WireRecorder, host: number): number =>
  hubRequests(wire).filter((m) => m.t === 'discoverRepos' && m.host === host).length;

/** Whether a `reposDiscovered` for `host` has arrived. */
export const discoveredOn = (wire: WireRecorder, host: number): boolean =>
  wire.receivedMessages().some((m) => m.t === 'reposDiscovered' && m.host === host);

/** Text messages the page sent since `from`, parsed but not decoded, for shapes this checkout's protocol may not know yet. */
export const sentJson = (wire: WireRecorder, from = 0): Record<string, unknown>[] =>
  wire.sent.slice(from).flatMap((f) => {
    const parsed: unknown = 'text' in f ? JSON.parse(f.text) : null;
    return typeof parsed === 'object' && parsed !== null ? [Object.fromEntries(Object.entries(parsed))] : [];
  });

/** This machine's name as the hub lists it. */
export const localName = async (wire: WireRecorder): Promise<string> => {
  await expect.poll(() => hostEntries(wire, LOCAL).length).toBeGreaterThan(0);
  return hostEntries(wire, LOCAL).at(-1)?.name ?? '';
};

/** Every SSH run for `alias` killed; the hub then sees the link lost. */
export const dropLinks = (ssh: FakeSsh, alias: string): void => {
  for (const pid of ssh.livePids(alias)) process.kill(pid, 'SIGKILL');
};
