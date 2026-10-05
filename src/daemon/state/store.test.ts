import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Layout } from '../../protocol/index.js';
import { StateStore } from './index.js';

const REPO = '/home/u/repo';
const OTHER = '/home/u/other';
const WT1 = '/home/u/repo.worktrees/one';
const WT2 = '/home/u/repo.worktrees/two';
const WT3 = '/home/u/repo.worktrees/three';
const EMPTY: Layout = { tabs: [], active: 0 };
const SPLIT: Layout = { tabs: [{ id: 'a', root: { split: 'right', ratio: 0.5, a: { term: 1 }, b: { term: 2 } } }], active: 0 };

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wtd-state-'));
  file = join(dir, 'state.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface PendingWrite {
  path: string;
  data: string;
  resolve: () => void;
  reject: (error: Error) => void;
}

/** A writer whose writes complete only when the test says so. */
class ManualWrites {
  readonly pending: PendingWrite[] = [];
  count = 0;

  readonly write = (path: string, data: string): Promise<void> =>
    new Promise((resolve, reject) => {
      this.count++;
      this.pending.push({ path, data, resolve, reject });
    });

  /** The oldest write still in flight. */
  next(): PendingWrite {
    const write = this.pending.shift();
    if (write === undefined) throw new Error('no write in flight');
    return write;
  }
}

/** Tracks whether a promise has settled, without awaiting it. */
const settled = <T>(promise: Promise<T>): { readonly done: boolean; readonly failed: boolean } => {
  const state = { done: false, failed: false };
  promise.then(
    () => (state.done = true),
    () => (state.failed = true),
  );
  return state;
};

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

const fileSchema = z.object({
  repos: z.array(z.object({ repo: z.string(), worktrees: z.array(z.object({ path: z.string(), checked: z.boolean() })) })),
});

/** The checked worktree paths in written state-file text. */
const checkedIn = (data: string): string[] =>
  fileSchema
    .parse(JSON.parse(data))
    .repos.flatMap((r) => r.worktrees.filter((w) => w.checked).map((w) => w.path))
    .sort();

const sorted = (values: readonly string[]): string[] => [...values].sort();

describe('loading', () => {
  it('starts empty without a state file and creates none', async () => {
    const store = await StateStore.load(file);
    expect(store.checked(REPO)).toEqual([]);
    expect(store.layouts(REPO)).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it.each([
    ['invalid JSON', '{"version":1,'],
    ['an unknown version', JSON.stringify({ version: 2, repos: [] })],
    ['an extra field', JSON.stringify({ version: 1, repos: [], extra: true })],
    [
      'a relative worktree path',
      JSON.stringify({ version: 1, repos: [{ repo: REPO, worktrees: [{ path: 'rel', checked: true, layout: EMPTY }] }] }),
    ],
    [
      'an invalid layout',
      JSON.stringify({ version: 1, repos: [{ repo: REPO, worktrees: [{ path: WT1, checked: true, layout: { tabs: [], active: 3 } }] }] }),
    ],
  ])('moves a state file holding %s aside and starts empty', async (_name, content) => {
    writeFileSync(file, content);
    const store = await StateStore.load(file);
    expect(store.checked(REPO)).toEqual([]);
    const names = readdirSync(dir);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^state\.json\.corrupt-/);
    expect(readFileSync(join(dir, names[0] ?? ''), 'utf8')).toBe(content);
  });

  it('drops every terminal leaf from stored layouts, keeping checked state', async () => {
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        repos: [
          {
            repo: REPO,
            worktrees: [
              { path: WT1, checked: true, layout: SPLIT },
              { path: WT2, checked: false, layout: SPLIT },
            ],
          },
        ],
      }),
    );
    const store = await StateStore.load(file);
    expect(store.checked(REPO)).toEqual([WT1]);
    expect(store.layout(REPO, WT1)).toEqual(EMPTY);
    expect(store.layout(REPO, WT2)).toEqual(EMPTY);
    expect(store.layouts(REPO)).toEqual([]);
  });
});

describe('persisted format', () => {
  it('stores checked worktrees and layouts as version 1, owner-only', async () => {
    const store = await StateStore.load(file);
    await store.setChecked(REPO, WT1, true);
    await store.setLayout(REPO, WT2, SPLIT);
    await store.setChecked(OTHER, '/home/u/other', true);
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    const worktrees: unknown = expect.arrayContaining([
      { path: WT1, checked: true, layout: EMPTY },
      { path: WT2, checked: false, layout: SPLIT },
    ]);
    const repos: unknown = expect.arrayContaining([
      { repo: REPO, worktrees },
      { repo: OTHER, worktrees: [{ path: '/home/u/other', checked: true, layout: EMPTY }] },
    ]);
    expect(parsed).toEqual({ version: 1, repos });
    expect(fileSchema.parse(parsed).repos).toHaveLength(2);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('does not store entries with default values', async () => {
    const store = await StateStore.load(file);
    await store.setChecked(REPO, WT1, true);
    await store.setLayout(REPO, WT2, SPLIT);
    await store.setChecked(REPO, WT1, false);
    await store.setLayout(REPO, WT2, EMPTY);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1, repos: [] });
  });

  it('survives a reload', async () => {
    const first = await StateStore.load(file);
    await first.setChecked(REPO, WT1, true);
    await first.setChecked(REPO, WT2, true);
    const second = await StateStore.load(file);
    expect(sorted(second.checked(REPO))).toEqual(sorted([WT1, WT2]));
    expect(second.checked(OTHER)).toEqual([]);
  });

  it('reports layouts per worktree', async () => {
    const store = await StateStore.load(file);
    await store.setLayout(REPO, WT1, SPLIT);
    expect(store.layouts(REPO)).toEqual([{ worktree: WT1, layout: SPLIT }]);
    expect(store.layout(REPO, WT1)).toEqual(SPLIT);
    expect(store.layout(REPO, WT2)).toEqual(EMPTY);
  });
});

describe('durable writes', () => {
  it('resolves a change only after a write containing it completes', async () => {
    const writes = new ManualWrites();
    const store = await StateStore.load(file, { write: writes.write });
    const change = settled(store.setChecked(REPO, WT1, true));
    await tick();
    const write = writes.next();
    expect(write.path).toBe(file);
    expect(checkedIn(write.data)).toEqual([WT1]);
    expect(change.done).toBe(false);
    write.resolve();
    await tick();
    expect(change.done).toBe(true);
  });

  it('coalesces changes made while a write is in flight into one later write', async () => {
    const writes = new ManualWrites();
    const store = await StateStore.load(file, { write: writes.write });
    const first = settled(store.setChecked(REPO, WT1, true));
    await tick();
    const firstWrite = writes.next();
    const second = settled(store.setChecked(REPO, WT2, true));
    const third = settled(store.setChecked(REPO, WT3, true));
    await tick();
    expect(writes.count).toBe(1);
    firstWrite.resolve();
    await tick();
    expect([first.done, second.done, third.done]).toEqual([true, false, false]);
    const secondWrite = writes.next();
    expect(checkedIn(secondWrite.data)).toEqual(sorted([WT1, WT2, WT3]));
    secondWrite.resolve();
    await tick();
    expect([second.done, third.done]).toEqual([true, true]);
    expect(writes.count).toBe(2);
  });

  it('rejects a change whose write fails and rolls it back', async () => {
    const writes = new ManualWrites();
    const store = await StateStore.load(file, { write: writes.write });
    const change = store.setChecked(REPO, WT1, true);
    await tick();
    writes.next().reject(new Error('disk full'));
    await expect(change).rejects.toThrow();
    expect(store.checked(REPO)).toEqual([]);
  });

  it('rolls back only the failed change when a later one is queued behind it', async () => {
    const writes = new ManualWrites();
    const store = await StateStore.load(file, { write: writes.write });
    const first = store.setChecked(REPO, WT1, true);
    await tick();
    const failing = writes.next();
    const second = settled(store.setChecked(REPO, WT2, true));
    failing.reject(new Error('disk full'));
    await expect(first).rejects.toThrow();
    await tick();
    const retry = writes.next();
    expect(checkedIn(retry.data)).toEqual([WT2]);
    retry.resolve();
    await tick();
    expect(second.done).toBe(true);
    expect(store.checked(REPO)).toEqual([WT2]);
  });

  it('rolls back a failed layout change', async () => {
    const writes = new ManualWrites();
    const store = await StateStore.load(file, { write: writes.write });
    const change = store.setLayout(REPO, WT1, SPLIT);
    await tick();
    writes.next().reject(new Error('disk full'));
    await expect(change).rejects.toThrow();
    expect(store.layout(REPO, WT1)).toEqual(EMPTY);
  });

  it('flush waits for writes in flight', async () => {
    const writes = new ManualWrites();
    const store = await StateStore.load(file, { write: writes.write });
    void store.setChecked(REPO, WT1, true).catch(() => undefined);
    await tick();
    const flushed = settled(store.flush());
    await tick();
    expect(flushed.done).toBe(false);
    writes.next().resolve();
    await tick();
    expect(flushed.done).toBe(true);
  });
});

describe('pruning', () => {
  it('removes entries of a repo that are not kept, durably', async () => {
    const store = await StateStore.load(file);
    await store.setChecked(REPO, WT1, true);
    await store.setLayout(REPO, WT2, SPLIT);
    await store.setChecked(OTHER, '/home/u/other', true);
    await store.prune(REPO, new Set([WT2]));
    expect(store.checked(REPO)).toEqual([]);
    expect(store.layouts(REPO)).toEqual([{ worktree: WT2, layout: SPLIT }]);
    expect(store.checked(OTHER)).toEqual(['/home/u/other']);
    const written = fileSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
    expect(written.repos.find((r) => r.repo === REPO)?.worktrees.map((w) => w.path)).toEqual([WT2]);
    expect(checkedIn(readFileSync(file, 'utf8'))).toEqual(['/home/u/other']);
  });

  it('writes nothing when nothing is pruned', async () => {
    const writes = new ManualWrites();
    const store = await StateStore.load(file, { write: writes.write });
    const change = store.setChecked(REPO, WT1, true);
    await tick();
    writes.next().resolve();
    await change;
    await store.prune(REPO, new Set([WT1, WT2]));
    expect(writes.count).toBe(1);
  });
});
