import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DaemonClient } from '../../../test/support/daemon-client.js';
import { sleep } from '../../../test/support/daemon-host.js';
import type { Worktree } from '../../protocol/index.js';
import { StateStore } from '../state/index.js';
import { SpawnError, TerminalProcess, type TerminalEvents, type TerminalSpec } from '../terminals/index.js';
import type { WorktreeHandlers, WorktreeRisks, WorktreeWatch } from '../worktrees/index.js';
import { Daemon, type DaemonServices } from './daemon.js';

const REPO = '/r';
const MAX_TERMINALS = 1024;
const WT = '/r.worktrees/feat';
const worktrees: Worktree[] = [
  { path: REPO, head: null, branch: 'main', detached: false, locked: false, prunable: false, bare: false, main: true },
  { path: WT, head: null, branch: 'feat', detached: false, locked: false, prunable: false, bare: false, main: false },
];
const NO_RISK: WorktreeRisks = { base: 'origin/main', ahead: 0, changes: 0 };

interface PendingSpawn {
  spec: TerminalSpec;
  events: TerminalEvents;
  resolve: (process: TerminalProcess) => void;
  reject: (error: Error) => void;
}

let dir: string;
let socketPath: string;
let server: Server;
let daemon: Daemon;
let store: StateStore;
let clients: DaemonClient[];
/** Spawns that have not finished; they finish only when a test settles them. */
let spawns: PendingSpawn[];
/** Watch starts held back until released, when set. */
let heldWatches: (() => void)[] | null;
let watchHandlers: WorktreeHandlers[];
/** What the risk check answers; a held promise keeps a removal in progress. */
let risks: Promise<WorktreeRisks>;
let removed: string[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wtd-daemon-'));
  socketPath = join(dir, 'd.sock');
  clients = [];
  spawns = [];
  heldWatches = null;
  watchHandlers = [];
  risks = Promise.resolve(NO_RISK);
  removed = [];
  const services: DaemonServices = {
    watchWorktrees: async (_repo, handlers) => {
      watchHandlers.push(handlers);
      if (heldWatches !== null) {
        const held = heldWatches;
        await new Promise<void>((resolve) => held.push(resolve));
      }
      const watch: WorktreeWatch = { worktrees, close: () => undefined };
      return watch;
    },
    listWorktrees: () => Promise.resolve(worktrees),
    discoverRepos: () => Promise.resolve([]),
    worktreeRisks: () => risks,
    removeWorktree: (_repo, worktree) => {
      removed.push(worktree.path);
      return Promise.resolve();
    },
    spawnTerminal: (spec, events) =>
      new Promise((resolve, reject) => {
        spawns.push({ spec, events, resolve, reject });
      }),
  };
  store = await StateStore.load(join(dir, 'state.json'));
  daemon = new Daemon({
    services,
    version: '0.0.0-test',
    instance: 'test_daemon',
    store,
    env: process.env,
    shutdown: () => undefined,
    report: () => undefined,
  });
  server = createServer((socket) => {
    daemon.accept(socket);
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
});

afterEach(async () => {
  for (const client of clients) client.close();
  await new Promise((resolve) => server.close(resolve));
  // A state write still in flight would add a file while the directory is removed.
  await store.flush();
  rmSync(dir, { recursive: true, force: true });
});

const connected = async (): Promise<DaemonClient> => {
  const client = await DaemonClient.connect(socketPath);
  clients.push(client);
  await client.handshake();
  return client;
};

const create = (client: DaemonClient, req: number): void => {
  client.send({ t: 'createTerm', req, worktree: REPO, preset: 'shell', command: null, cols: 80, rows: 24 });
};

it('counts terminals still starting against the per-repo limit, and frees the slot of a failed start', async () => {
  const client = await connected();
  await client.watch(REPO);
  const from = client.mark();
  for (let req = 1; req <= MAX_TERMINALS + 1; req++) create(client, req);
  expect(await client.waitFor('error', (m) => m.code === 'busy', { from })).toMatchObject({ req: MAX_TERMINALS + 1 });
  expect(spawns).toHaveLength(MAX_TERMINALS);

  spawns[0]?.reject(new SpawnError('no shell'));
  expect(await client.waitFor('error', (m) => m.req === 1, { from })).toMatchObject({ code: 'spawn-failed' });
  create(client, MAX_TERMINALS + 2);
  await sleep(100);
  expect(spawns).toHaveLength(MAX_TERMINALS + 1);
});

it('closes a terminal whose start was in flight when shutdown began', async () => {
  const client = await connected();
  await client.watch(REPO);
  create(client, 1);
  await vi.waitFor(() => {
    expect(spawns).toHaveLength(1);
  });
  const pending = spawns[0];
  if (pending === undefined) throw new Error('no spawn');
  const process = await TerminalProcess.spawn({ ...pending.spec, cwd: dir, command: 'exec sleep 60' }, pending.events);
  const close = vi.spyOn(process, 'close');
  const stopped = daemon.shutdown();
  pending.resolve(process);
  await stopped;
  expect(close).toHaveBeenCalledTimes(1);
});

it('refuses requests once shutting down', async () => {
  const client = await connected();
  await client.watch(REPO);
  create(client, 1);
  await vi.waitFor(() => {
    expect(spawns).toHaveLength(1);
  });
  // The start in flight holds shutdown open while the request arrives.
  const stopped = daemon.shutdown();
  expect(await client.fails({ t: 'watchRepo', repo: REPO })).toBe('internal');
  spawns[0]?.reject(new SpawnError('no shell'));
  await stopped;
});

it('keeps a starting watch for a connection still waiting when another one left', async () => {
  heldWatches = [];
  const leaving = await connected();
  const staying = await connected();
  leaving.send({ t: 'watchRepo', req: 1, repo: REPO });
  await vi.waitFor(() => {
    expect(heldWatches).toHaveLength(1);
  });
  const watched = staying.watch(REPO);
  leaving.close();
  await sleep(100);
  for (const release of heldWatches) release();
  await watched;
  const from = staying.mark();
  watchHandlers[0]?.changed(worktrees);
  expect(await staying.waitFor('worktreesChanged', () => true, { from })).toMatchObject({ repo: REPO });
});

it('prunes state of vanished worktrees before the first repoState', async () => {
  await store.setChecked(REPO, '/r.worktrees/gone', true);
  await store.setChecked(REPO, REPO, true);
  const client = await connected();
  expect((await client.watch(REPO)).checked).toEqual([REPO]);
});

it('waits for a terminal still starting in a worktree being removed, and reports it as running', async () => {
  const client = await connected();
  await client.watch(REPO);
  client.send({ t: 'createTerm', req: 1, worktree: WT, preset: 'shell', command: null, cols: 80, rows: 24 });
  await vi.waitFor(() => {
    expect(spawns).toHaveLength(1);
  });
  const from = client.mark();
  client.send({ t: 'removeWorktree', req: 2, worktree: WT, force: false });
  await client.expectNone('worktreeAtRisk', () => true, 200);
  const pending = spawns[0];
  if (pending === undefined) throw new Error('no spawn');
  const process = await TerminalProcess.spawn({ ...pending.spec, cwd: dir, command: 'exec sleep 60' }, pending.events);
  pending.resolve(process);
  const created = await client.waitFor('termCreated', (m) => m.req === 1, { from });
  expect(await client.waitFor('worktreeAtRisk', (m) => m.req === 2, { from })).toMatchObject({ running: [created.term.termId] });
  expect(removed).toEqual([]);
  await process.close();
});

it('refuses to start a terminal in a worktree while it is being removed', async () => {
  const client = await connected();
  await client.watch(REPO);
  let release: (value: WorktreeRisks) => void = () => undefined;
  risks = new Promise((resolve) => {
    release = resolve;
  });
  const from = client.mark();
  client.send({ t: 'removeWorktree', req: 1, worktree: WT, force: false });
  await sleep(50);
  expect(await client.fails({ t: 'createTerm', worktree: WT, preset: 'shell', command: null, cols: 80, rows: 24 })).toBe('busy');
  expect(spawns).toHaveLength(0);
  release(NO_RISK);
  await client.waitFor('done', (m) => m.req === 1, { from });
  expect(removed).toEqual([WT]);
});
