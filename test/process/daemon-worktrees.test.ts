import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Worktree } from '../../src/protocol/index.js';
import type { DaemonClient, EventOf } from '../support/daemon-client.js';
import { addWorktree, DaemonHost, fakeWorktrees, git, makeRepo, sleep } from '../support/daemon-host.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

const ANY_REQ: unknown = expect.any(Number);

/** The issue's end-to-end budget for a worktree change to reach watchers. */
const BUDGET_MS = 250;

let host: DaemonHost;
let repo: string;

beforeEach(async () => {
  host = DaemonHost.create();
  repo = makeRepo(join(host.dir, 'repo'));
  await host.start();
});

afterEach(async () => {
  await host.cleanup();
});

const find = (worktrees: readonly Worktree[], path: string): Worktree | undefined => worktrees.find((w) => w.path === path);

/**
 * Runs `change` and resolves with the first worktreesChanged satisfying `done`, asserting it
 * arrived within the budget; logs the measured latency.
 */
const expectEvent = async (
  client: DaemonClient,
  what: string,
  change: () => void,
  done: (worktrees: readonly Worktree[]) => boolean,
): Promise<EventOf<'worktreesChanged'>> => {
  const from = client.mark();
  change();
  const changedAt = Date.now();
  const event = await client.waitFor('worktreesChanged', (m) => m.repo === repo && done(m.worktrees), { from, timeout: 3000 });
  const latency = Date.now() - changedAt;
  console.log(`worktree event latency (${what}): ${String(latency)} ms`);
  expect(latency).toBeLessThanOrEqual(BUDGET_MS);
  return event;
};

describe('watchRepo', () => {
  it('sends repoState listing every worktree, main first, then done', async () => {
    const wt = addWorktree(repo, join(host.dir, 'wt'), 'feature/x');
    const client = await host.client();
    const from = client.mark();
    const state = await client.watch(repo);
    const head = git(repo, 'rev-parse', 'HEAD');
    expect(state).toEqual({
      t: 'repoState',
      repo,
      worktrees: [
        { path: repo, head, branch: 'main', detached: false, locked: false, prunable: false, bare: false, main: true },
        { path: wt, head, branch: 'feature/x', detached: false, locked: false, prunable: false, bare: false, main: false },
      ],
      terminals: [],
      checked: [],
      layouts: [],
    });
    expect(client.messages.slice(from).map((m) => m.t)).toEqual(['repoState', 'done']);
  });

  it('sends repoState and done again when watched again', async () => {
    const client = await host.client();
    await client.watch(repo);
    const from = client.mark();
    await client.watch(repo);
    expect(client.messages.slice(from).map((m) => m.t)).toEqual(['repoState', 'done']);
  });

  it('reports a bare repository with a null head and branch', async () => {
    const bare = join(host.dir, 'bare.git');
    git(host.dir, 'init', '-q', '--bare', bare);
    const client = await host.client();
    const state = await client.watch(bare);
    expect(state.worktrees).toEqual([
      { path: bare, head: null, branch: null, detached: false, locked: false, prunable: false, bare: true, main: true },
    ]);
  });

  it('reports an unborn branch with a null head', async () => {
    const empty = join(host.dir, 'empty');
    mkdirSync(empty);
    git(empty, 'init', '-q', '-b', 'trunk');
    const state = await (await host.client()).watch(empty);
    expect(state.worktrees[0]).toMatchObject({ path: empty, head: null, branch: 'trunk', main: true });
  });

  it('reports detached, locked and prunable worktrees', async () => {
    const detached = join(host.dir, 'detached');
    git(repo, 'worktree', 'add', '-q', '--detach', detached);
    const locked = addWorktree(repo, join(host.dir, 'locked'), 'locked');
    git(repo, 'worktree', 'lock', '--reason', 'on a stick', locked);
    const gone = addWorktree(repo, join(host.dir, 'gone'), 'gone');
    rmSync(gone, { recursive: true });
    const state = await (await host.client()).watch(repo);
    expect(find(state.worktrees, detached)).toMatchObject({ detached: true, branch: null, locked: false, prunable: false });
    expect(find(state.worktrees, locked)).toMatchObject({ detached: false, locked: true, prunable: false });
    expect(find(state.worktrees, gone)).toMatchObject({ prunable: true, locked: false });
  });

  it.each([
    ['spaces', 'with space'],
    ['a newline', 'new\nline'],
  ])('reports a worktree path with %s exactly', async (_name, dirName) => {
    const path = addWorktree(repo, join(host.dir, dirName), 'odd');
    const state = await (await host.client()).watch(repo);
    expect(state.worktrees.map((w) => w.path)).toContain(path);
  });

  it('fails with not-a-repo for a directory that is not a repository', async () => {
    const plain = join(host.dir, 'plain');
    mkdirSync(plain);
    expect(await (await host.client()).fails({ t: 'watchRepo', repo: plain })).toBe('not-a-repo');
  });

  it('fails with not-a-repo for a missing directory', async () => {
    expect(await (await host.client()).fails({ t: 'watchRepo', repo: join(host.dir, 'missing') })).toBe('not-a-repo');
  });

  it('fails with not-a-repo for the path of a linked worktree', async () => {
    const wt = addWorktree(repo, join(host.dir, 'wt'), 'wt');
    expect(await (await host.client()).fails({ t: 'watchRepo', repo: wt })).toBe('not-a-repo');
  });

  it('fails with not-a-repo for a subdirectory of a repository', async () => {
    const sub = join(repo, 'sub');
    mkdirSync(sub);
    expect(await (await host.client()).fails({ t: 'watchRepo', repo: sub })).toBe('not-a-repo');
  });

  it('fails with internal for a repo with more than 1024 worktrees', async () => {
    fakeWorktrees(repo, 1024);
    expect(await (await host.client()).fails({ t: 'watchRepo', repo })).toBe('internal');
  });

  it('accepts a repo with exactly 1024 worktrees', async () => {
    fakeWorktrees(repo, 1023);
    expect((await (await host.client()).watch(repo)).worktrees).toHaveLength(1024);
  });
});

describe('unwatchRepo', () => {
  it('fails with not-watched for a repo this connection does not watch', async () => {
    const a = await host.client();
    const b = await host.client();
    await a.watch(repo);
    expect(await b.fails({ t: 'unwatchRepo', repo })).toBe('not-watched');
  });

  it('ends the subscription', async () => {
    const client = await host.client();
    await client.watch(repo);
    await client.ok({ t: 'unwatchRepo', repo });
    git(repo, 'worktree', 'add', '-q', '-b', 'later', join(host.dir, 'later'));
    await client.expectNone('worktreesChanged', () => true, 600);
    expect(await client.fails({ t: 'unwatchRepo', repo })).toBe('not-watched');
  });

  it('keeps reporting to the remaining watchers', async () => {
    const a = await host.client();
    const b = await host.client();
    await a.watch(repo);
    await b.watch(repo);
    await a.ok({ t: 'unwatchRepo', repo });
    const path = join(host.dir, 'after-unwatch');
    await expectEvent(
      b,
      'add after another watcher left',
      () => git(repo, 'worktree', 'add', '-q', '-b', 'after-unwatch', path),
      (wts) => find(wts, path) !== undefined,
    );
  });
});

describe('worktree change events', () => {
  let a: DaemonClient;
  let b: DaemonClient;

  beforeEach(async () => {
    a = await host.client();
    b = await host.client();
    await a.watch(repo);
    await b.watch(repo);
  });

  it('reports an added worktree to every watcher', async () => {
    const path = join(host.dir, 'added');
    const from = b.mark();
    await expectEvent(
      a,
      'add',
      () => git(repo, 'worktree', 'add', '-q', '-b', 'added', path),
      (wts) => wts.some((w) => w.path.endsWith('/added')),
    );
    const event = await b.waitFor('worktreesChanged', () => true, { from });
    expect(event.worktrees.map((w) => w.path)).toEqual([repo, join(host.dir, 'added')]);
  });

  it('reports a removed worktree', async () => {
    const wt = addWorktree(repo, join(host.dir, 'wt'), 'wt');
    await a.waitFor('worktreesChanged', (m) => find(m.worktrees, wt) !== undefined);
    await expectEvent(
      a,
      'remove',
      () => git(repo, 'worktree', 'remove', wt),
      (wts) => find(wts, wt) === undefined,
    );
  });

  it('reports a branch switch', async () => {
    const wt = addWorktree(repo, join(host.dir, 'wt'), 'wt');
    await a.waitFor('worktreesChanged', (m) => find(m.worktrees, wt) !== undefined);
    await expectEvent(
      a,
      'switch',
      () => git(wt, 'switch', '-q', '-c', 'other'),
      (wts) => find(wts, wt)?.branch === 'other',
    );
  });

  it('reports a commit in the main worktree', async () => {
    let head = '';
    await expectEvent(
      a,
      'commit main',
      () => {
        git(repo, 'commit', '-q', '--allow-empty', '-m', 'next');
        head = git(repo, 'rev-parse', 'HEAD');
      },
      (wts) => find(wts, repo)?.head === head,
    );
  });

  it('reports a commit on a nested branch whose ref was packed', async () => {
    const wt = addWorktree(repo, join(host.dir, 'wt'), 'feature/deep/x');
    git(repo, 'pack-refs', '--all');
    await a.waitFor('worktreesChanged', (m) => find(m.worktrees, wt) !== undefined);
    await sleep(300);
    let head = '';
    await expectEvent(
      a,
      'commit packed nested',
      () => {
        git(wt, 'commit', '-q', '--allow-empty', '-m', 'next');
        head = git(wt, 'rev-parse', 'HEAD');
      },
      (wts) => find(wts, wt)?.head === head,
    );
  });

  it('reports locking and unlocking', async () => {
    const wt = addWorktree(repo, join(host.dir, 'wt'), 'wt');
    await a.waitFor('worktreesChanged', (m) => find(m.worktrees, wt) !== undefined);
    await expectEvent(
      a,
      'lock',
      () => git(repo, 'worktree', 'lock', wt),
      (wts) => find(wts, wt)?.locked === true,
    );
    await expectEvent(
      a,
      'unlock',
      () => git(repo, 'worktree', 'unlock', wt),
      (wts) => find(wts, wt)?.locked === false,
    );
  });

  it('reports a deleted worktree directory as prunable', async () => {
    const wt = addWorktree(repo, join(host.dir, 'wt'), 'wt');
    await a.waitFor('worktreesChanged', (m) => find(m.worktrees, wt) !== undefined);
    await expectEvent(
      a,
      'delete dir',
      () => {
        rmSync(wt, { recursive: true });
      },
      (wts) => find(wts, wt)?.prunable === true,
    );
  });

  it('keeps watching after git removes and recreates the worktrees admin directory', async () => {
    const first = addWorktree(repo, join(host.dir, 'first'), 'first');
    await a.waitFor('worktreesChanged', (m) => find(m.worktrees, first) !== undefined);
    git(repo, 'worktree', 'remove', first);
    await a.waitFor('worktreesChanged', (m) => find(m.worktrees, first) === undefined);
    expect(existsSync(join(repo, '.git', 'worktrees'))).toBe(false);
    const second = join(host.dir, 'second');
    await expectEvent(
      a,
      'add after admin dir recreated',
      () => git(repo, 'worktree', 'add', '-q', '-b', 'second', second),
      (wts) => find(wts, second) !== undefined,
    );
  });

  it('keeps watching commits after a nested branch ref directory is removed and recreated', async () => {
    const wt = addWorktree(repo, join(host.dir, 'wt'), 'feature/a/x');
    await a.waitFor('worktreesChanged', (m) => find(m.worktrees, wt) !== undefined);
    git(wt, 'switch', '-q', '-c', 'plain');
    git(repo, 'branch', '-D', 'feature/a/x');
    await a.waitFor('worktreesChanged', (m) => find(m.worktrees, wt)?.branch === 'plain');
    expect(existsSync(join(repo, '.git', 'refs', 'heads', 'feature'))).toBe(false);
    await expectEvent(
      a,
      'switch to recreated nested',
      () => git(wt, 'switch', '-q', '-c', 'feature/a/y'),
      (wts) => find(wts, wt)?.branch === 'feature/a/y',
    );
    await sleep(300);
    let head = '';
    await expectEvent(
      a,
      'commit in recreated nested',
      () => {
        git(wt, 'commit', '-q', '--allow-empty', '-m', 'nested');
        head = git(wt, 'rev-parse', 'HEAD');
      },
      (wts) => find(wts, wt)?.head === head,
    );
  });

  it('sends nothing when a file inside a worktree is edited or staged', async () => {
    writeFileSync(join(repo, 'file.txt'), 'one');
    git(repo, 'add', 'file.txt');
    writeFileSync(join(repo, 'file.txt'), 'two');
    await a.expectNone('worktreesChanged', () => true, 800);
  });

  it('ends every subscription with internal when the repo directory is deleted', async () => {
    rmSync(repo, { recursive: true, force: true });
    for (const client of [a, b]) {
      expect(await client.waitFor('error', (m) => m.req === null, { timeout: 3000 })).toMatchObject({ code: 'internal' });
      expect(await client.fails({ t: 'unwatchRepo', repo })).toBe('not-watched');
    }
  });

  it('ends every subscription with internal when the list grows past 1024 worktrees', async () => {
    fakeWorktrees(repo, 1024);
    for (const client of [a, b]) {
      expect(await client.waitFor('error', (m) => m.req === null, { timeout: 3000 })).toMatchObject({ code: 'internal' });
      expect(await client.fails({ t: 'unwatchRepo', repo })).toBe('not-watched');
    }
  });
});

describe('discoverRepos', () => {
  it('reports repositories below the roots, sorted', async () => {
    const root = join(host.dir, 'roots');
    const one = makeRepo(join(root, 'b-one'));
    const two = makeRepo(join(root, 'a', 'two'));
    makeRepo(join(root, 'x', 'y', 'too-deep'));
    const client = await host.client();
    const reply = await client.request({ t: 'discoverRepos', roots: [root, join(host.dir, 'missing')], depth: 2 });
    expect(reply).toEqual({ t: 'reposDiscovered', req: ANY_REQ, repos: [two, one] });
  });
});
