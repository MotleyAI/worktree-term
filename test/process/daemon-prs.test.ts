import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrStatus } from '../../src/protocol/index.js';
import type { DaemonClient, EventOf } from '../support/daemon-client.js';
import { addWorktree, alive, DaemonHost, git, makeRepo, sleep, waitUntil } from '../support/daemon-host.js';
import { FakeGh, fakePrUrl } from '../support/fake-gh.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

const ORIGIN = 'https://github.com/acme/app.git';
/** The end-to-end budget for a worktree change to reach watchers. */
const BUDGET_MS = 250;

let host: DaemonHost;
let gh: FakeGh;
let repo: string;

beforeEach(() => {
  host = DaemonHost.create();
  gh = new FakeGh(join(host.dir, 'gh'));
  repo = makeRepo(join(host.dir, 'repo'));
  git(repo, 'remote', 'add', 'origin', ORIGIN);
});

afterEach(async () => {
  await host.cleanup();
});

const start = async (env: Record<string, string> = {}): Promise<void> => {
  await host.start({ PATH: gh.path, ...env });
};

const openPr = (branch: string, number: number, fields: Partial<PrStatus> = {}): PrStatus => ({
  branch,
  number,
  url: fakePrUrl(number),
  state: 'open',
  checks: 'passing',
  conflicts: false,
  review: null,
  ...fields,
});

/** The next prStatus for `repo` from message `from` on that satisfies `done`. */
const prStatus = (
  client: DaemonClient,
  from: number,
  done: (prs: readonly PrStatus[]) => boolean = () => true,
  timeout = 10_000,
  of = repo,
): Promise<EventOf<'prStatus'>> => client.waitFor('prStatus', (m) => m.repo === of && done(m.prs), { from, timeout });

const callsSettle = async (count: number, timeout = 10_000): Promise<void> => {
  await waitUntil(() => gh.calls().length >= count, `${String(count)} gh calls`, timeout);
};

const typesSince = (client: DaemonClient, from: number): string[] => client.messages.slice(from).map((m) => m.t);

/** Registers `count` linked worktrees on distinct new branches whose directories do not exist; far faster than `git worktree add`. */
const branchWorktrees = (count: number): string[] => {
  const head = git(repo, 'rev-parse', 'HEAD');
  const branches = Array.from({ length: count }, (_, i) => `wt-${String(i).padStart(3, '0')}`);
  for (const branch of branches) {
    const admin = join(repo, '.git', 'worktrees', branch);
    mkdirSync(admin, { recursive: true });
    writeFileSync(join(admin, 'gitdir'), `/nonexistent/${branch}/.git\n`);
    writeFileSync(join(admin, 'HEAD'), `ref: refs/heads/${branch}\n`);
    writeFileSync(join(admin, 'commondir'), '../..\n');
    git(repo, 'update-ref', `refs/heads/${branch}`, head);
  }
  return branches;
};

describe('pull request status', () => {
  it('sends watchers the status of an open pull request whose checks fail', async () => {
    addWorktree(repo, join(host.dir, 'wt'), 'feature/x');
    gh.behave({ kind: 'answer', prs: { 'feature/x': { number: 12, checks: 'FAILURE' } } });
    await start();
    const client = await host.client();
    await client.watch(repo);
    expect((await prStatus(client, 0)).prs).toEqual([openPr('feature/x', 12, { checks: 'failing' })]);
    expect(gh.calls()[0]?.args).toEqual(['api', 'graphql', '--hostname', 'github.com', '--input', '-']);
  });

  it('runs gh once per refresh for 58 worktrees', async () => {
    const branches = branchWorktrees(57);
    await start({ WTD_PR_INTERVAL_MS: '1500' });
    const client = await host.client();
    await client.watch(repo);
    await prStatus(client, 0);
    expect(gh.calls()).toHaveLength(1);
    expect(gh.calls()[0]?.branches).toEqual(['main', ...branches].sort((a, b) => a.localeCompare(b)));
    await callsSettle(2, 5000);
    await sleep(300);
    expect(gh.calls()).toHaveLength(2);
  });

  it('serves a second connection from memory after repoState and before done, without running gh', async () => {
    addWorktree(repo, join(host.dir, 'wt'), 'feature/x');
    gh.behave({ kind: 'answer', prs: { 'feature/x': { number: 12 } } });
    await start();
    const first = await host.client();
    await first.watch(repo);
    await prStatus(first, 0);
    const second = await host.client();
    const from = second.mark();
    await second.watch(repo);
    expect(typesSince(second, from)).toEqual(['repoState', 'prStatus', 'done']);
    expect((await prStatus(second, from)).prs).toEqual([openPr('feature/x', 12)]);
    await sleep(300);
    expect(gh.calls()).toHaveLength(1);
  });

  it('runs gh again at once when a worktree on a new branch is added', async () => {
    await start();
    const client = await host.client();
    await client.watch(repo);
    await prStatus(client, 0);
    addWorktree(repo, join(host.dir, 'wt'), 'fix/y');
    await callsSettle(2, 5000);
    expect(gh.calls()[1]?.branches).toEqual(['fix/y', 'main']);
  });

  it('does not run gh for a commit before the interval elapses', async () => {
    await start();
    const client = await host.client();
    await client.watch(repo);
    await prStatus(client, 0);
    const from = client.mark();
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'more');
    await client.waitFor('worktreesChanged', () => true, { from, timeout: 3000 });
    await sleep(500);
    expect(gh.calls()).toHaveLength(1);
  });

  it('sends a changed status within one interval', async () => {
    addWorktree(repo, join(host.dir, 'wt'), 'feature/x');
    gh.behave({ kind: 'answer', prs: { 'feature/x': { number: 12 } } });
    await start({ WTD_PR_INTERVAL_MS: '1000' });
    const client = await host.client();
    await client.watch(repo);
    await prStatus(client, 0);
    const from = client.mark();
    gh.behave({ kind: 'answer', prs: { 'feature/x': { number: 12, state: 'MERGED' } } });
    const changed = await prStatus(client, from, (prs) => prs.some((p) => p.state === 'merged'), 2500);
    expect(changed.prs).toEqual([openPr('feature/x', 12, { state: 'merged' })]);
  });

  it('sends nothing when a refresh finds the same statuses', async () => {
    addWorktree(repo, join(host.dir, 'wt'), 'feature/x');
    gh.behave({ kind: 'answer', prs: { 'feature/x': { number: 12 } } });
    await start({ WTD_PR_INTERVAL_MS: '300' });
    const client = await host.client();
    await client.watch(repo);
    await prStatus(client, 0);
    const from = client.mark();
    await callsSettle(4);
    await sleep(100);
    expect(typesSince(client, from)).not.toContain('prStatus');
  });

  it('stops running gh for a repo once the last connection unwatched it', async () => {
    await start({ WTD_PR_INTERVAL_MS: '300' });
    const client = await host.client();
    await client.watch(repo);
    await prStatus(client, 0);
    await client.ok({ t: 'unwatchRepo', repo });
    await sleep(100);
    const after = gh.calls().length;
    await sleep(1200);
    expect(gh.calls()).toHaveLength(after);
  });

  it.each([
    ['gh is missing', (): Record<string, string> => ({ PATH: gh.pathWithoutGh() })],
    [
      'gh reports no login',
      (): Record<string, string> => {
        gh.behave({ kind: 'exit', code: 4, stderr: 'To get started with GitHub CLI, please run:  gh auth login\n' });
        return {};
      },
    ],
  ])('sends prStatus without pull requests and never an error when %s', async (_name, env) => {
    addWorktree(repo, join(host.dir, 'wt'), 'feature/x');
    await start(env());
    const client = await host.client();
    await client.watch(repo);
    expect((await prStatus(client, 0)).prs).toEqual([]);
    await sleep(300);
    expect(typesSince(client, 0)).not.toContain('error');
  });

  it('sends prStatus without pull requests once origin is removed', async () => {
    addWorktree(repo, join(host.dir, 'wt'), 'feature/x');
    gh.behave({ kind: 'answer', prs: { 'feature/x': { number: 12 } } });
    await start({ WTD_PR_INTERVAL_MS: '300' });
    const client = await host.client();
    await client.watch(repo);
    await prStatus(client, 0, (prs) => prs.length === 1);
    const from = client.mark();
    git(repo, 'remote', 'remove', 'origin');
    await prStatus(client, from, (prs) => prs.length === 0, 3000);
  });

  it('keeps the status through failed refreshes, sending neither prStatus nor error, and gives it to a later watcher', async () => {
    addWorktree(repo, join(host.dir, 'wt'), 'feature/x');
    gh.behave({ kind: 'answer', prs: { 'feature/x': { number: 12 } } });
    await start({ WTD_PR_INTERVAL_MS: '300' });
    const first = await host.client();
    await first.watch(repo);
    await prStatus(first, 0);
    const from = first.mark();
    gh.behave({ kind: 'exit', code: 1, stderr: 'GraphQL: Something went wrong\n' });
    await callsSettle(gh.calls().length + 2);
    await sleep(100);
    expect(typesSince(first, from)).not.toContain('prStatus');
    expect(typesSince(first, from)).not.toContain('error');
    const later = await host.client();
    await later.watch(repo);
    expect((await prStatus(later, 0)).prs).toEqual([openPr('feature/x', 12)]);
  });

  it('delays neither watchRepo nor worktreesChanged while gh hangs, and kills gh after 20 s', async () => {
    gh.behave({ kind: 'hang' });
    await start();
    const client = await host.client();
    const watchStarted = Date.now();
    await client.watch(repo);
    expect(Date.now() - watchStarted).toBeLessThan(1000);
    const [hanging] = await waitUntil(() => gh.running().length === 1 && gh.running(), 'gh to run');
    const startedAt = Date.now();
    const from = client.mark();
    const added = Date.now();
    const wt = addWorktree(repo, join(host.dir, 'wt'), 'feature/x');
    await client.waitFor('worktreesChanged', (m) => m.worktrees.some((w) => w.path === wt), { from, timeout: 3000 });
    expect(Date.now() - added).toBeLessThanOrEqual(BUDGET_MS);
    await waitUntil(() => hanging !== undefined && !alive(hanging), 'the hanging gh to be killed', 30_000);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(15_000);
    expect(Date.now() - startedAt).toBeLessThanOrEqual(24_000);
  });

  it('runs at most 4 gh at a time while a connection watches 10 repos', async () => {
    gh.behave({ kind: 'hang' });
    await start();
    const client = await host.client();
    for (let i = 0; i < 10; i++) {
      const other = makeRepo(join(host.dir, `repo${String(i)}`));
      git(other, 'remote', 'add', 'origin', ORIGIN);
      await client.watch(other);
    }
    await waitUntil(() => gh.running().length >= 4, '4 gh runs');
    await sleep(1000);
    expect(gh.running()).toHaveLength(4);
    expect(gh.calls()).toHaveLength(4);
  });
});
