import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrStatus, Worktree } from '../../protocol/index.js';
import { createPrs, prIntervalMs, type Fetch, type FetchOutcome, type Prs } from './index.js';

const INTERVAL = 60_000;

interface FetchCall {
  repo: string;
  worktrees: readonly Worktree[];
  signal: AbortSignal;
  settle: (outcome: FetchOutcome) => void;
}

const worktree = (path: string, branch: string | null, fields: Partial<Worktree> = {}): Worktree => ({
  path,
  head: null,
  branch,
  detached: branch === null,
  locked: false,
  prunable: false,
  bare: false,
  main: false,
  ...fields,
});

const status = (branch: string, number: number, state: PrStatus['state'] = 'open'): PrStatus => ({
  branch,
  number,
  url: `https://github.com/acme/app/pull/${String(number)}`,
  state,
  checks: 'passing',
  conflicts: false,
  review: null,
});

const ok = (prs: PrStatus[]): FetchOutcome => ({ ok: true, prs });
const failed = (failure: Extract<FetchOutcome, { ok: false }>['failure']): FetchOutcome => ({ ok: false, failure });

const REPO = '/r';
const WORKTREES = [worktree(REPO, 'main', { main: true }), worktree('/r.wt/x', 'feature/x')];

let fetches: FetchCall[];
let logged: string[];
let prs: Prs;

const fetch: Fetch = (repo, worktrees, signal) =>
  new Promise((resolve) => {
    fetches.push({ repo, worktrees, signal, settle: resolve });
  });

/** Lets settled fetches and due timers run. */
const flush = async (ms = 0): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
};

/** Settles the `i`th fetch (the latest by default) and lets its result land. */
const settle = async (outcome: FetchOutcome, i = fetches.length - 1): Promise<void> => {
  const call = fetches[i];
  if (call === undefined) throw new Error(`no fetch ${String(i)}`);
  call.settle(outcome);
  await flush();
};

beforeEach(() => {
  vi.useFakeTimers();
  fetches = [];
  logged = [];
  prs = createPrs({
    fetch,
    intervalMs: INTERVAL,
    log: (line) => {
      logged.push(line);
    },
  });
});

afterEach(async () => {
  const closing = prs.close();
  for (const call of fetches) call.settle(failed('timeout'));
  await closing;
  vi.useRealTimers();
});

describe('triggers', () => {
  it('refreshes when the watch starts, with the worktree list', async () => {
    prs.watch(REPO, WORKTREES, () => undefined);
    await flush();
    expect(fetches.map((f) => [f.repo, f.worktrees])).toEqual([[REPO, WORKTREES]]);
  });

  it('refreshes when a worktree is added or its branch changes', async () => {
    const watch = prs.watch(REPO, WORKTREES, () => undefined);
    await settle(ok([]));
    const added = [...WORKTREES, worktree('/r.wt/y', 'fix/y')];
    watch.update(added);
    await flush();
    expect(fetches).toHaveLength(2);
    expect(fetches[1]?.worktrees).toEqual(added);
    await settle(ok([]));
    watch.update([...WORKTREES.slice(0, 1), worktree('/r.wt/x', 'feature/z'), worktree('/r.wt/y', 'fix/y')]);
    await flush();
    expect(fetches).toHaveLength(3);
  });

  it('refreshes when a worktree goes', async () => {
    const watch = prs.watch(REPO, WORKTREES, () => undefined);
    await settle(ok([]));
    watch.update(WORKTREES.slice(0, 1));
    await flush();
    expect(fetches).toHaveLength(2);
  });

  it('does not refresh when only head, locked or prunable change', async () => {
    const watch = prs.watch(REPO, WORKTREES, () => undefined);
    await settle(ok([]));
    watch.update(WORKTREES.map((w) => ({ ...w, head: 'a'.repeat(40), locked: true, prunable: true })));
    await flush();
    expect(fetches).toHaveLength(1);
  });

  it('refreshes every interval while watched, and stops when the watch closes', async () => {
    const watch = prs.watch(REPO, WORKTREES, () => undefined);
    await settle(ok([]));
    await flush(INTERVAL);
    expect(fetches).toHaveLength(2);
    await settle(ok([]));
    await flush(INTERVAL);
    expect(fetches).toHaveLength(3);
    await settle(ok([]));
    watch.close();
    await flush(5 * INTERVAL);
    expect(fetches).toHaveLength(3);
  });

  it('takes the interval it is given', async () => {
    const quick = createPrs({ fetch, intervalMs: 250, log: () => undefined });
    quick.watch(REPO, WORKTREES, () => undefined);
    await settle(ok([]));
    await flush(250);
    expect(fetches).toHaveLength(2);
    const closing = quick.close();
    await settle(ok([]));
    await closing;
  });
});

describe('coalescing', () => {
  it('runs a refresh asked for while one runs once after it, however often asked', async () => {
    const watch = prs.watch(REPO, WORKTREES, () => undefined);
    await flush();
    watch.update([...WORKTREES, worktree('/r.wt/y', 'fix/y')]);
    watch.update([...WORKTREES, worktree('/r.wt/z', 'fix/z')]);
    await flush();
    expect(fetches).toHaveLength(1);
    await settle(ok([]), 0);
    expect(fetches).toHaveLength(2);
    expect(fetches[1]?.worktrees).toEqual([...WORKTREES, worktree('/r.wt/z', 'fix/z')]);
    await settle(ok([]), 1);
    expect(fetches).toHaveLength(2);
  });

  it('skips a timed refresh due while one runs', async () => {
    prs.watch(REPO, WORKTREES, () => undefined);
    await flush(INTERVAL + 1);
    expect(fetches).toHaveLength(1);
    await settle(ok([]));
    await flush();
    expect(fetches).toHaveLength(1);
  });

  it('runs one refresh per repo at a time, also across a watch closed and started again', async () => {
    const first = prs.watch(REPO, WORKTREES, () => undefined);
    await flush();
    first.close();
    prs.watch(REPO, WORKTREES, () => undefined);
    await flush();
    expect(fetches).toHaveLength(1);
    await settle(ok([]));
    expect(fetches).toHaveLength(2);
  });
});

describe('concurrency', () => {
  const repos = Array.from({ length: 6 }, (_, i) => `/repo${String(i)}`);
  const watchAll = () => repos.map((repo) => prs.watch(repo, [worktree(repo, 'main', { main: true })], () => undefined));

  it('runs at most 4 refreshes at a time, the others in the order asked', async () => {
    watchAll();
    await flush();
    expect(fetches.map((f) => f.repo)).toEqual(repos.slice(0, 4));
    await settle(ok([]), 2);
    expect(fetches.map((f) => f.repo)).toEqual(repos.slice(0, 5));
    await settle(ok([]), 0);
    expect(fetches.map((f) => f.repo)).toEqual(repos);
  });

  it('drops a waiting refresh of a repo no longer watched', async () => {
    const watches = watchAll();
    await flush();
    watches[4]?.close();
    await settle(ok([]), 0);
    expect(fetches.map((f) => f.repo)).toEqual([...repos.slice(0, 4), repos[5]]);
  });
});

describe('cache and changes', () => {
  it('has nothing for a repo before its first success', async () => {
    prs.watch(REPO, WORKTREES, () => undefined);
    await flush();
    expect(prs.cached(REPO)).toBeNull();
    expect(prs.cached('/elsewhere')).toBeNull();
  });

  it('always sends the first success, also when empty, and keeps it', async () => {
    const changed = vi.fn<(prs: PrStatus[]) => void>();
    prs.watch(REPO, WORKTREES, changed);
    await settle(ok([]));
    expect(changed.mock.calls).toEqual([[[]]]);
    expect(prs.cached(REPO)).toEqual([]);
  });

  it('sends a success only when it differs from the kept one', async () => {
    const changed = vi.fn<(prs: PrStatus[]) => void>();
    prs.watch(REPO, WORKTREES, changed);
    await settle(ok([status('feature/x', 1)]));
    await flush(INTERVAL);
    await settle(ok([status('feature/x', 1)]));
    await flush(INTERVAL);
    await settle(ok([status('feature/x', 1, 'merged')]));
    expect(changed.mock.calls).toEqual([[[status('feature/x', 1)]], [[status('feature/x', 1, 'merged')]]]);
    expect(prs.cached(REPO)).toEqual([status('feature/x', 1, 'merged')]);
  });

  it('keeps the status and sends nothing when a refresh fails', async () => {
    const changed = vi.fn<(prs: PrStatus[]) => void>();
    prs.watch(REPO, WORKTREES, changed);
    await settle(ok([status('feature/x', 1)]));
    await flush(INTERVAL);
    await settle(failed('exit'));
    expect(changed).toHaveBeenCalledTimes(1);
    expect(prs.cached(REPO)).toEqual([status('feature/x', 1)]);
  });

  it('keeps the status after the watch closed, and does not resend it to a new watch', async () => {
    const first = prs.watch(REPO, WORKTREES, () => undefined);
    await flush();
    first.close();
    await settle(ok([status('feature/x', 1)]));
    expect(prs.cached(REPO)).toEqual([status('feature/x', 1)]);
    const changed = vi.fn<(prs: PrStatus[]) => void>();
    prs.watch(REPO, WORKTREES, changed);
    await settle(ok([status('feature/x', 1)]));
    expect(changed).not.toHaveBeenCalled();
  });

  it('completes a refresh whose watch closed meanwhile into the cache, without sending it', async () => {
    const changed = vi.fn<(prs: PrStatus[]) => void>();
    const watch = prs.watch(REPO, WORKTREES, changed);
    await flush();
    watch.close();
    await settle(ok([status('feature/x', 1)]));
    expect(changed).not.toHaveBeenCalled();
    expect(prs.cached(REPO)).toEqual([status('feature/x', 1)]);
  });
});

describe('failure log', () => {
  it.each(['timeout', 'exit', 'network', 'invalid-json', 'invalid-response'] as const)(
    'logs failure class %s of a repo once until a success, naming the repo and class',
    async (failure) => {
      prs.watch(REPO, WORKTREES, () => undefined);
      for (const outcome of [failed(failure), failed(failure), ok([]), failed(failure)]) {
        await settle(outcome);
        await flush(INTERVAL);
      }
      expect(logged).toHaveLength(2);
      for (const line of logged) {
        expect(line).toContain(REPO);
        expect(line).toContain(failure);
      }
    },
  );

  it('logs another class too, but each class once until a success', async () => {
    prs.watch(REPO, WORKTREES, () => undefined);
    for (const outcome of [failed('timeout'), failed('exit'), failed('timeout'), ok([]), failed('timeout')]) {
      await settle(outcome);
      await flush(INTERVAL);
    }
    expect(logged.map((line) => ['timeout', 'exit'].find((c) => line.includes(c)))).toEqual(['timeout', 'exit', 'timeout']);
  });

  it('logs per repo', async () => {
    prs.watch('/a', [worktree('/a', 'main', { main: true })], () => undefined);
    prs.watch('/b', [worktree('/b', 'main', { main: true })], () => undefined);
    await flush();
    await settle(failed('network'), 0);
    await settle(failed('network'), 1);
    expect(logged).toHaveLength(2);
  });
});

describe('close', () => {
  it('aborts running refreshes and settles only after they ended', async () => {
    prs.watch(REPO, WORKTREES, () => undefined);
    await flush();
    const [running] = fetches;
    let closed = false;
    const closing = prs.close().then(() => (closed = true));
    await flush();
    expect(running?.signal.aborted).toBe(true);
    expect(closed).toBe(false);
    running?.settle(failed('timeout'));
    await closing;
    expect(closed).toBe(true);
  });

  it('starts nothing afterwards and suppresses callbacks and logs', async () => {
    const changed = vi.fn<(prs: PrStatus[]) => void>();
    prs.watch(REPO, WORKTREES, changed);
    await flush();
    const closing = prs.close();
    await settle(ok([status('feature/x', 1)]));
    await closing;
    prs.watch('/other', WORKTREES, changed);
    await flush(5 * INTERVAL);
    expect(fetches).toHaveLength(1);
    expect(changed).not.toHaveBeenCalled();
    expect(logged).toEqual([]);
  });

  it('drops waiting refreshes', async () => {
    for (let i = 0; i < 6; i++) prs.watch(`/repo${String(i)}`, WORKTREES, () => undefined);
    await flush();
    const closing = prs.close();
    for (const call of fetches) call.settle(failed('timeout'));
    await closing;
    expect(fetches).toHaveLength(4);
  });
});

describe('prIntervalMs', () => {
  it.each([
    [undefined, 60_000],
    ['250', 250],
    ['1', 1],
    ['007', 7],
    ['0', 60_000],
    ['000', 60_000],
    ['-5', 60_000],
    ['1.5', 60_000],
    ['abc', 60_000],
    ['', 60_000],
    ['2147483647', 2_147_483_647],
    ['2147483648', 2_147_483_647],
    ['99999999999999999999', 2_147_483_647],
  ])('WTD_PR_INTERVAL_MS %j gives %d ms', (value, ms) => {
    expect(prIntervalMs(value)).toBe(ms);
  });
});
