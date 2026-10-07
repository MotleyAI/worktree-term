import { test as base, expect, type BrowserContext, type ElementHandle, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DaemonClient } from '../support/daemon-client.js';
import { addWorktree, alive, git, makeRepo, waitUntil } from '../support/daemon-host.js';
import { currentNodeDir, FakeSsh, type FakeRemote } from '../support/fake-ssh.js';
import { HubHost } from '../support/hub-host.js';
import { byTestId, hostBanner, repoTab, terminalBox, TID, worktreeEntry } from './contract.js';
import { installWebglProbe } from './webgl.js';
import { WireRecorder, type HubMessage } from './wire.js';

type HostEntry = Extract<HubMessage, { t: 'hosts' }>['hosts'][number];

export { expect };

/** The local host's index. */
export const LOCAL = 0;

/** The index of the first configured remote host. */
export const REMOTE = 1;

/** Presets every e2e hub is configured with: a plain shell and a command preset. */
export const PRESETS = [
  { name: 'shell', command: null },
  { name: 'cat', command: 'echo PRESET-CAT; exec cat -v' },
] as const;

export interface Fixtures {
  /** An isolated hub host on a free port; nothing started yet. */
  hub: HubHost;
  /** Records the default page's WebSocket traffic from its first navigation. */
  wire: WireRecorder;
  /** A fake `ssh` the hub uses as `WTD_SSH`; requesting it is what makes a test's hub use it. */
  ssh: FakeSsh;
}

export const test = base.extend<Fixtures>({
  page: async ({ page }, use) => {
    await page.addInitScript(installWebglProbe);
    await use(page);
  },
  // eslint-disable-next-line no-empty-pattern -- Playwright fixtures must destructure their dependencies
  hub: async ({}, use) => {
    const hub = await HubHost.createHub();
    hub.presets = PRESETS;
    await use(hub);
    await hub.cleanup();
  },
  wire: async ({ page }, use) => {
    await use(new WireRecorder(page));
  },
  ssh: async ({ hub }, use) => {
    const ssh = new FakeSsh(join(hub.dir, 'ssh'));
    hub.sshProgram = ssh.program;
    await use(ssh);
    // The hub would start new SSH runs while the remotes are torn down.
    for (const pid of hub.hubPids()) process.kill(pid, 'SIGKILL');
    await waitUntil(() => hub.hubPids().every((pid) => !alive(pid)), 'hubs to exit').catch(() => undefined);
    await ssh.cleanup();
  },
});

/** A configured remote host: its `name`, SSH alias, absolute repos and discovery roots. */
export interface HostConfig {
  name: string;
  ssh: string;
  repos?: readonly string[];
  roots?: readonly string[];
}

/** Writes `config.json` with the e2e presets, the local `repos` and `roots`, and remote `hosts`. */
export const writeHubConfig = (
  hub: HubHost,
  { repos = [], roots, hosts }: { repos?: readonly string[]; roots?: readonly string[]; hosts?: readonly HostConfig[] },
): void => {
  hub.writeConfig({
    port: hub.port,
    presets: PRESETS,
    repos,
    ...(roots === undefined ? {} : { roots }),
    ...(hosts === undefined ? {} : { hosts }),
  });
};

/** A reachable fake remote whose PATH offers this runner's Node, so the hub can install there. */
export const nodeRemote = (ssh: FakeSsh, alias: string): FakeRemote =>
  ssh.addHost(alias, { path: `${currentNodeDir(join(ssh.dir, `node-${alias}`))}:${ssh.pathWithoutNode}` });

/** Clicks the action of `host`'s banner and waits for the confirmation dialog. */
export const openHostAction = async (page: Page, host: number, label: string): Promise<void> => {
  const action = page.locator(hostBanner(host)).locator(byTestId(TID.hostAction));
  await expect(action).toHaveText(label);
  await action.click();
  await expect(page.locator(byTestId(TID.confirmDialog))).toBeVisible();
};

/** Confirms the open confirmation dialog. */
export const confirmAction = async (page: Page): Promise<void> => {
  const dialog = page.locator(byTestId(TID.confirmDialog));
  await dialog.locator(byTestId(TID.confirmOk)).click();
  await expect(dialog).toHaveCount(0);
};

/** Hub-level requests (not `host` envelopes or `hello`) the page sent since `from`, without their `req`. */
export const hubRequests = (wire: WireRecorder, from = 0): { t: string; host: number }[] =>
  wire.sentMessages(from).flatMap((m) => (m.t === 'hello' || m.t === 'host' ? [] : [{ t: m.t, host: m.host }]));

/** Every entry of `host` in the `hosts` messages the page received since `from`. */
export const hostEntries = (wire: WireRecorder, host: number, from = 0): HostEntry[] =>
  wire.receivedMessages(from).flatMap((m) => (m.t === 'hosts' ? m.hosts.filter((h) => h.idx === host) : []));

/** Records the browser dialogs (such as `window.confirm`) the page opens, dismissing each. */
export const refuseBrowserDialogs = (page: Page): string[] => {
  const seen: string[] = [];
  page.on('dialog', (dialog) => {
    seen.push(dialog.message());
    void dialog.dismiss();
  });
  return seen;
};

/** Runs `wtd ui` with the stub browser and returns the URL it opened. */
export const runUi = async (hub: HubHost): Promise<string> => {
  const before = hub.browserCalls().length;
  const ui = hub.wtd(['ui']);
  const exit = await ui.exited;
  if (exit.code !== 0) throw new Error(`wtd ui exited ${JSON.stringify(exit)}: ${ui.stderr}`);
  // The browser runs detached; wait until it has recorded its call.
  await waitUntil(() => hub.browserCalls().length > before, 'the browser to start');
  const call = hub.browserCalls()[before];
  const arg = call?.args[0];
  if (arg?.startsWith('--app=') !== true) throw new Error(`unexpected browser call ${JSON.stringify(call)}`);
  return arg.slice('--app='.length);
};

/** Opens the UI the way a user does: `wtd ui`, then the URL the browser was given. */
export const openUi = async (hub: HubHost, page: Page): Promise<void> => {
  await page.goto(await runUi(hub));
  await expect(page.locator(byTestId(TID.authMessage))).toHaveCount(0);
};

/** A further page in `context` with the WebGL probe and a recorder, opened with a fresh code. */
export const openPage = async (hub: HubHost, context: BrowserContext): Promise<{ page: Page; wire: WireRecorder }> => {
  const page = await context.newPage();
  await page.addInitScript(installWebglProbe);
  const wire = new WireRecorder(page);
  await page.goto(await hub.pageUrl());
  return { page, wire };
};

/** Makes a repo under the host's directory with linked worktrees on the given branches; returns real paths. */
export const makeRepoWith = (hub: HubHost, name: string, branches: readonly string[]): { repo: string; worktrees: string[] } => {
  const repo = makeRepo(join(hub.dir, 'repos', name));
  const worktrees = branches.map((branch) =>
    addWorktree(repo, join(hub.dir, 'repos', `${name}.worktrees`, branch.replaceAll('/', '-')), branch),
  );
  return { repo, worktrees };
};

/** Adds a detached worktree at `<repo>.worktrees/<dir>` and returns its real path and head. */
export const detachedWorktree = (repo: string, dir: string): { path: string; head: string } => {
  const path = `${repo}.worktrees/${dir}`;
  git(repo, 'worktree', 'add', '-q', '--detach', path);
  return { path: git(path, 'rev-parse', '--show-toplevel'), head: git(path, 'rev-parse', 'HEAD') };
};

/** A daemon client that watches `repo` (the daemon must be running). */
export const watcher = async (hub: HubHost, repo: string): Promise<DaemonClient> => {
  await waitUntil(() => existsSync(hub.socket), 'the daemon socket', 10_000);
  const client = await hub.client();
  await client.watch(repo);
  return client;
};

/** Creates an idle shell in each worktree through `client`, as the only tab of its layout; returns the ids in order. */
export const createShells = async (client: DaemonClient, worktrees: readonly string[], tabsEach = 1): Promise<number[][]> => {
  const ids: number[][] = [];
  for (const worktree of worktrees) {
    const terms: number[] = [];
    for (let i = 0; i < tabsEach; i++) terms.push((await client.create(worktree)).termId); // NOSONAR(S9382) — sequential setup
    const layout = { tabs: terms.map((term) => ({ id: `t${String(term)}`, root: { term } })), active: 0 };
    await client.ok({ t: 'setLayout', worktree, layout }); // NOSONAR(S9382) — sequential setup
    ids.push(terms);
  }
  return ids;
};

export const selectRepo = async (page: Page, path: string): Promise<void> => {
  await page.locator(repoTab(path)).click();
  await expect(page.locator(repoTab(path))).toHaveAttribute('aria-selected', 'true');
};

export const selectWorktree = async (page: Page, path: string): Promise<void> => {
  await page.locator(worktreeEntry(path)).locator(byTestId(TID.worktreeLabel)).click();
  await expect(page.locator(worktreeEntry(path))).toHaveAttribute('aria-selected', 'true');
};

/** Paths of the listed sidebar entries, in order. */
export const listedWorktrees = (page: Page): Promise<string[]> =>
  page.locator(byTestId(TID.worktree)).evaluateAll((entries) => entries.map((e) => e.getAttribute('title') ?? ''));

/** The terminal id of the selected terminal tab. */
export const activeTerm = async (page: Page): Promise<number> => {
  const tab = page.locator(`${byTestId(TID.termTab)}[aria-selected="true"]`);
  await expect(tab).toHaveCount(1);
  return Number(await tab.getAttribute('data-term'));
};

export type PresetName = (typeof PRESETS)[number]['name'];

/** Chooses `preset` in the open preset picker by clicking it. */
export const pickPreset = async (page: Page, preset: PresetName): Promise<void> => {
  const picker = page.locator(byTestId(TID.presetPicker));
  await expect(picker).toBeVisible();
  await picker.locator(byTestId(TID.presetOption), { hasText: preset }).click();
  await expect(picker).toHaveCount(0);
};

/** Terminal ids of the panes of the shown tab. */
export const paneIds = async (page: Page): Promise<number[]> =>
  (
    await page
      .locator(byTestId(TID.pane))
      .evaluateAll((panes) => panes.map((p) => (p instanceof HTMLElement ? (p.dataset['term'] ?? '') : '')))
  ).map(Number);

/** The terminal id of the focused pane. */
export const focusedPane = async (page: Page): Promise<number> => {
  const focused = page.locator(`${byTestId(TID.pane)}[data-focused="true"]`);
  await expect(focused).toHaveCount(1);
  return Number(await focused.getAttribute('data-term'));
};

/** Waits for a pane holding a terminal not in `before` and returns its id once its container is visible. */
const newPane = async (page: Page, before: readonly number[], host = LOCAL): Promise<number> => {
  let termId = 0;
  await expect
    .poll(async () => {
      termId = (await paneIds(page)).find((id) => !before.includes(id)) ?? 0;
      return termId;
    })
    .toBeGreaterThan(0);
  await expect(page.locator(terminalBox(host, termId))).toBeVisible();
  return termId;
};

/** Clicks new-tab, picks `preset`, and resolves with the new active terminal's id once its container is visible. */
export const newTerminal = async (page: Page, preset: PresetName = 'shell', host = LOCAL): Promise<number> => {
  const before = await page
    .locator(byTestId(TID.termTab))
    .evaluateAll((tabs) => tabs.map((t) => (t instanceof HTMLElement ? (t.dataset['term'] ?? null) : null)));
  await page.locator(byTestId(TID.newTab)).click();
  await pickPreset(page, preset);
  const tab = page.locator(`${byTestId(TID.termTab)}[aria-selected="true"]`);
  await expect.poll(async () => (await tab.count()) === 1 && !before.includes(await tab.getAttribute('data-term'))).toBe(true);
  const termId = Number(await tab.getAttribute('data-term'));
  await expect(page.locator(terminalBox(host, termId))).toBeVisible();
  return termId;
};

/** Clicks a split button, picks `preset`, and resolves with the new pane's terminal id once its container is visible. */
export const splitPane = async (page: Page, dir: 'right' | 'down', preset: PresetName = 'shell'): Promise<number> => {
  const before = await paneIds(page);
  await page.locator(byTestId(dir === 'right' ? TID.splitRight : TID.splitDown)).click();
  await pickPreset(page, preset);
  return newPane(page, before);
};

/** Confirms the open close dialog. */
export const confirmClose = async (page: Page): Promise<void> => {
  const dialog = page.locator(byTestId(TID.closeDialog));
  await expect(dialog).toBeVisible();
  await dialog.locator(byTestId(TID.closeConfirm)).click();
  await expect(dialog).toHaveCount(0);
};

/** The mark shown inside the element `selector` finds; null without one. Reads in one step, so a mark vanishing meanwhile cannot stall it. */
export const markOf = (page: Page, selector: string): Promise<string | null> =>
  page
    .locator(selector)
    .locator(byTestId(TID.mark))
    .evaluateAll((marks) => (marks[0] instanceof HTMLElement ? (marks[0].dataset['mark'] ?? null) : null));

/** Types `line` and Enter into the terminal. */
export const typeLine = async (page: Page, termId: number, line: string, host = LOCAL): Promise<void> => {
  await page.locator(terminalBox(host, termId)).click();
  await page.keyboard.type(line);
  await page.keyboard.press('Enter');
};

/** The terminal's text through the inspection hook; null without a terminal object. */
export const screenOf = (page: Page, termId: number, host = LOCAL): Promise<string | null> =>
  page.evaluate(([h, t]) => window.__wtdInspect?.screen(h, t) ?? null, [host, termId] as const);

/** Waits until the terminal's text contains `pattern`. */
export const waitScreen = async (page: Page, termId: number, pattern: string, timeout = 10_000, host = LOCAL): Promise<string> => {
  await expect.poll(async () => (await screenOf(page, termId, host)) ?? '', { timeout }).toContain(pattern);
  return (await screenOf(page, termId, host)) ?? '';
};

/** Waits until the shell prompt of a fresh terminal settled, by echoing a marker. */
export const ready = async (page: Page, termId: number, host = LOCAL): Promise<void> => {
  await typeLine(page, termId, "echo READY''-MARK", host);
  await waitScreen(page, termId, 'READY-MARK', 10_000, host);
};

/** The terminal's `.xterm` element. */
export const xtermOf = (page: Page, termId: number, host = LOCAL): Promise<ElementHandle<Element>> => {
  return page.locator(terminalBox(host, termId)).locator('.xterm').elementHandle();
};

/** Whether `handle` is in the document and is what `selector` finds. */
export const isCurrent = (page: Page, handle: ElementHandle<Element>, selector: string): Promise<boolean> =>
  page.evaluate(([element, sel]) => element.isConnected && document.querySelector(sel) === element, [handle, selector] as const);

/** The pid of this host's daemon once exactly one runs. */
export const oneDaemon = (hub: HubHost): Promise<number> =>
  waitUntil(() => {
    const pids = hub.daemonPids();
    return pids.length === 1 ? pids[0] : undefined;
  }, 'exactly one daemon');

/** Sends SIGTERM to the hub named by the hub record and waits until it is gone. */
export const stopHub = async (hub: HubHost): Promise<void> => {
  const record = hub.record();
  if (record === null) throw new Error('no hub record');
  process.kill(record.pid, 'SIGTERM');
  await waitUntil(() => hub.hubPids().length === 0, 'the hub to exit', 10_000);
};
