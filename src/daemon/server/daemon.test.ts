import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DaemonClient } from '../../../test/support/daemon-client.js';
import { sleep } from '../../../test/support/daemon-host.js';
import type { Layout, Worktree } from '../../protocol/index.js';
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
const ANY_REQ: unknown = expect.any(Number);

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
let reported: unknown[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wtd-daemon-'));
  socketPath = join(dir, 'd.sock');
  clients = [];
  spawns = [];
  heldWatches = null;
  watchHandlers = [];
  risks = Promise.resolve(NO_RISK);
  removed = [];
  reported = [];
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
    report: (error) => {
      reported.push(error);
    },
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

describe('ending terminals', () => {
  afterEach(async () => {
    await daemon.shutdown();
  });

  const twoPanes = (a: number, b: number): Layout => ({
    tabs: [{ id: 'main', root: { split: 'right', ratio: 0.5, a: { term: a }, b: { term: b } } }],
    active: 0,
  });

  /** Creates a terminal in `worktree` whose spawn runs `command` in bash; resolves with its id. */
  const start = async (client: DaemonClient, worktree: string, command: string): Promise<number> => {
    const count = spawns.length;
    const reply = client.request({ t: 'createTerm', worktree, preset: 'shell', command: null, cols: 80, rows: 24 });
    await vi.waitFor(() => {
      expect(spawns).toHaveLength(count + 1);
    });
    const pending = spawns[count];
    if (pending === undefined) throw new Error('no spawn');
    const env = { ...process.env, HOME: dir, SHELL: '/bin/bash' };
    pending.resolve(await TerminalProcess.spawn({ ...pending.spec, cwd: dir, command, env }, pending.events));
    const created = await reply;
    if (created.t !== 'termCreated') throw new Error(`createTerm failed: ${JSON.stringify(created)}`);
    return created.term.termId;
  };

  it('closes a cleanly exited terminal: its split gives way to the other half, then termClosed, and no termExited', async () => {
    const client = await connected();
    await client.watch(REPO);
    const leaving = await start(client, WT, 'read -r _; exit 0');
    const staying = await start(client, WT, 'exec sleep 60');
    await client.ok({ t: 'setLayout', worktree: WT, layout: twoPanes(leaving, staying) });
    const from = client.mark();
    client.sendInput(leaving, '\r');
    await client.waitFor('termClosed', (m) => m.termId === leaving, { from, timeout: 3000 });
    await client.expectNone('termExited', () => true, 300);
    expect(client.messages.slice(from).filter((m) => m.t !== 'activity')).toEqual([
      { t: 'layoutChanged', worktree: WT, layout: { tabs: [{ id: 'main', root: { term: staying } }], active: 0 } },
      { t: 'termClosed', termId: leaving },
    ]);
    expect((await (await connected()).watch(REPO)).terminals.map((t) => t.termId)).toEqual([staying]);
  });

  it.each([
    ['a non-zero code', 'read -r _; exit 1', { code: 1, signal: null }],
    ['a signal', 'read -r _; kill -KILL $$', { signal: 'SIGKILL' }],
  ])('keeps a terminal that exited with %s, sending termExited', async (_name, command, exit) => {
    const client = await connected();
    await client.watch(REPO);
    const term = await start(client, WT, command);
    const from = client.mark();
    client.sendInput(term, '\r');
    expect(await client.waitFor('termExited', (m) => m.termId === term, { from })).toMatchObject(exit);
    await client.expectNone('termClosed', () => true, 300);
    expect((await (await connected()).watch(REPO)).terminals.find((t) => t.termId === term)?.exit).toMatchObject(exit);
  });

  it('sends termClosed for a cleanly exited terminal whose layout cannot be saved, and reports the failure', async () => {
    const client = await connected();
    await client.watch(REPO);
    const leaving = await start(client, WT, 'read -r _; exit 0');
    const staying = await start(client, WT, 'exec sleep 60');
    await client.ok({ t: 'setLayout', worktree: WT, layout: twoPanes(leaving, staying) });
    const failure = new Error('disk full');
    vi.spyOn(store, 'setLayout').mockRejectedValue(failure);
    const from = client.mark();
    client.sendInput(leaving, '\r');
    await client.waitFor('termClosed', (m) => m.termId === leaving, { from, timeout: 3000 });
    expect(client.messages.slice(from).filter((m) => m.t === 'layoutChanged' || m.t === 'termExited')).toEqual([]);
    expect(store.layout(REPO, WT)).toEqual(twoPanes(leaving, staying));
    expect(reported).toContain(failure);
  });

  it('writes the layout of a removed worktree once, then sends termClosed for each of its terminals', async () => {
    const client = await connected();
    await client.watch(REPO);
    const one = await start(client, WT, 'exec sleep 60');
    const two = await start(client, WT, 'exec sleep 60');
    await client.ok({ t: 'setLayout', worktree: WT, layout: twoPanes(one, two) });
    const write = vi.spyOn(store, 'setLayout');
    const from = client.mark();
    await client.ok({ t: 'removeWorktree', worktree: WT, force: true });
    const empty: Layout = { tabs: [], active: 0 };
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(REPO, WT, empty);
    expect(client.messages.slice(from).filter((m) => m.t !== 'activity')).toEqual([
      { t: 'layoutChanged', worktree: WT, layout: empty },
      { t: 'termClosed', termId: one },
      { t: 'termClosed', termId: two },
      { t: 'done', req: ANY_REQ },
    ]);
    expect(removed).toEqual([WT]);
  });
});
