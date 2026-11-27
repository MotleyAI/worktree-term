import { test as base, expect, type Page } from '@playwright/test';
import { join } from 'node:path';
import type { DaemonClient } from '../support/daemon-client.js';
import { addWorktree, git, makeRepo, waitUntil } from '../support/daemon-host.js';
import { FakeGh } from '../support/fake-gh.js';
import { HubHost } from '../support/hub-host.js';
import { bestOf, describeRound, frameInterval, frames, ROUNDS, withinMs, type Budget, type Verdict } from './budget.js';
import { byTestId, DRAG_MOVE, DRAG_PAINT, SWITCH_END, SWITCH_START, terminalBox, TID, worktreeEntry } from './contract.js';
import { createShells, LOCAL, openUi, selectWorktree } from './fixture.js';
import { balanced, boxOf, createTerms, divider, storeTabs } from './panes.js';
import { holdsWebgl, installWebglProbe, webglRenderer } from './webgl.js';

const WORKTREES = 58;
const SWITCHES = 20;
const PANES = 8;
/** Worktrees no other test views, turned into one tab of 8 panes by `eightPanes`. */
const EIGHT_PANE_WORKTREES = [56, 57] as const;
const DRAG_MOVES = 60;
/** Animation frame gaps collected to estimate the page's frame interval. */
const FRAME_GAPS = 60;
const RECENT = [0, 1, 2, 3] as const;
/** The first of the 20 worktrees switched to while they render via DOM. */
const REATTACH_FIRST = 4;
/** Worktrees viewed after the reattach targets so that every target falls back to DOM; the LRU holds 8. */
const REATTACH_EVICT = 9;
/** The daemon's pull request refresh interval here: a hanging request starts again within a second of being killed. */
const PR_INTERVAL_MS = '1000';

interface PerfRepo {
  hub: HubHost;
  repo: string;
  worktrees: string[];
  /** Terminal ids per worktree; the first is the active tab. */
  terms: number[][];
  /** The daemon's `gh`, which never returns; it runs only while the repo has an origin. */
  gh: FakeGh;
}

declare global {
  interface Window {
    __wtdSidebar?: { appeared: number | null; gone: number | null; observer: MutationObserver };
    __wtdSlowdownMs?: number;
  }
}

const test = base.extend<{ page: Page }, { perf: PerfRepo }>({
  page: async ({ page }, use) => {
    await page.addInitScript(installWebglProbe);
    await use(page);
  },
  perf: [
    // eslint-disable-next-line no-empty-pattern -- Playwright fixtures must destructure their dependencies
    async ({}, use) => {
      const hub = await HubHost.createHub();
      let client: DaemonClient | null = null;
      try {
        const gh = new FakeGh(join(hub.dir, 'gh'));
        gh.behave({ kind: 'hang' });
        hub.extraEnv = { ...hub.extraEnv, PATH: gh.path, WTD_PR_INTERVAL_MS: PR_INTERVAL_MS };
        const repo = makeRepo(join(hub.dir, 'repos', 'big'));
        const worktrees = Array.from({ length: WORKTREES }, (_, i) =>
          addWorktree(repo, join(hub.dir, 'repos', 'big.worktrees', `w${String(i).padStart(2, '0')}`), `w${String(i).padStart(2, '0')}`),
        );
        hub.writeRepos([repo]);
        await hub.start();
        client = await hub.client();
        await client.watch(repo);
        const terms = await createShells(client, worktrees, 2);
        await use({ hub, repo, worktrees, terms, gh });
      } finally {
        client?.close();
        await hub.cleanup();
      }
    },
    { scope: 'worker', timeout: 300_000 },
  ],
});

test.describe.configure({ mode: 'serial' });

/** Opens the UI and returns its frame interval, estimated from FRAME_GAPS animation frame gaps. */
const openTimed = async (perf: PerfRepo, page: Page): Promise<number> => {
  await openUi(perf.hub, page);
  const gaps = await page.evaluate(
    (count) =>
      new Promise<number[]>((resolve) => {
        const collected: number[] = [];
        let last: number | null = null;
        const tick = (now: number): void => {
          if (last !== null) collected.push(now - last);
          last = now;
          if (collected.length < count) requestAnimationFrame(tick);
          else resolve(collected);
        };
        requestAnimationFrame(tick);
      }),
    FRAME_GAPS,
  );
  const interval = frameInterval(gaps);
  const description = `${interval.toFixed(2)} ms`;
  console.log(`frame interval: ${description}`);
  test.info().annotations.push({ type: 'frame interval', description });
  return interval;
};

/** Measures up to 3 rounds against `budget`, logging and annotating each round as it completes. */
const judge = (name: string, budget: Budget, round: (index: number) => Promise<readonly number[]>): Promise<Verdict> =>
  bestOf(budget, round, (result, index) => {
    const description = describeRound(budget, result, index);
    console.log(`${name}: ${description}`);
    test.info().annotations.push({ type: name, description });
  });

/** Fails unless at least one of up to 3 rounds meets `budget`. */
const holds = async (name: string, budget: Budget, round: (index: number) => Promise<readonly number[]>): Promise<void> => {
  const verdict = await judge(name, budget, round);
  expect(verdict.met, `${name}: no round met ${budget.label}`).toBe(true);
};

/** Clicks the worktree and returns the switch duration from the `wtd:switch` marks. */
const timedSwitch = async (page: Page, path: string): Promise<number> => {
  const ends = await page.evaluate((name) => performance.getEntriesByName(name).length, SWITCH_END);
  await page.locator(worktreeEntry(path)).locator(byTestId(TID.worktreeLabel)).click();
  await expect.poll(() => page.evaluate((name) => performance.getEntriesByName(name).length, SWITCH_END)).toBeGreaterThan(ends);
  return page.evaluate(
    ([startName, endName]) => {
      const start = performance.getEntriesByName(startName).at(-1);
      const end = performance.getEntriesByName(endName).at(-1);
      if (start === undefined || end === undefined || end.startTime < start.startTime) return Number.NaN;
      return end.startTime - start.startTime;
    },
    [SWITCH_START, SWITCH_END] as const,
  );
};

/** Shows the worktree and waits until its active terminal renders with WebGL. */
const view = async (page: Page, perf: PerfRepo, index: number): Promise<void> => {
  const term = perf.terms[index]?.[0] ?? 0;
  await selectWorktree(page, perf.worktrees[index] ?? '');
  await expect(page.locator(terminalBox(LOCAL, term))).toBeVisible();
  await expect.poll(() => holdsWebgl(page, LOCAL, term)).toBe(true);
};

/** An 8-pane worktree: its path and the terminals of its active tab. */
interface EightPanes {
  path: string;
  terms: number[];
}

let eightPaneSetup: Promise<EightPanes[]> | null = null;

/** Once per worker: makes each of EIGHT_PANE_WORKTREES hold one tab of 8 panes, its 2 shells and 6 more. */
const eightPanes = (perf: PerfRepo): Promise<EightPanes[]> => {
  eightPaneSetup ??= (async () => {
    const client = await perf.hub.client();
    try {
      await client.watch(perf.repo);
      const result: EightPanes[] = [];
      for (const index of EIGHT_PANE_WORKTREES) {
        const path = perf.worktrees[index] ?? '';
        const existing = perf.terms[index] ?? [];
        const terms = [...existing, ...(await createTerms(client, path, PANES - existing.length))]; // NOSONAR(S9382) — sequential setup
        await storeTabs(client, path, [balanced(terms)]); // NOSONAR(S9382) — sequential setup
        result.push({ path, terms });
      }
      return result;
    } finally {
      client.close();
    }
  })();
  return eightPaneSetup;
};

/** Shows the worktree and waits until every pane of its 8-pane tab renders with WebGL. */
const viewPanes = async (page: Page, target: EightPanes): Promise<void> => {
  await selectWorktree(page, target.path);
  for (const term of target.terms) await expect(page.locator(terminalBox(LOCAL, term))).toBeVisible();
  for (const term of target.terms) await expect.poll(() => holdsWebgl(page, LOCAL, term)).toBe(true);
};

const entries = (page: Page, name: string): Promise<number> => page.evaluate((n) => performance.getEntriesByName(n).length, name);

/** Init script: busy-waits `window.__wtdSlowdownMs` right after every `startName` mark, inside the caller's handler. */
const injectSwitchSlowdown = (startName: string): void => {
  const mark = performance.mark.bind(performance);
  performance.mark = (name: string, options?: PerformanceMarkOptions): PerformanceMark => {
    const entry = mark(name, options);
    if (name === startName) {
      const until = performance.now() + (window.__wtdSlowdownMs ?? 0);
      while (performance.now() < until) {
        // busy-wait
      }
    }
    return entry;
  };
};

/** One round: views the recently viewed worktrees, then times 20 switches between them. */
const recentRound = async (page: Page, perf: PerfRepo): Promise<number[]> => {
  for (const index of RECENT) await view(page, perf, index);
  const durations: number[] = [];
  for (let i = 0; i < SWITCHES; i++) {
    const index = RECENT[i % RECENT.length] ?? 0;
    durations.push(await timedSwitch(page, perf.worktrees[index] ?? ''));
    expect(await holdsWebgl(page, LOCAL, perf.terms[index]?.[0] ?? 0)).toBe(true);
  }
  return durations;
};

/** One round: views the 20 targets and 9 more so the targets fall back to DOM, then times a switch to each target. */
const reattachRound = async (page: Page, perf: PerfRepo): Promise<number[]> => {
  for (let index = REATTACH_FIRST; index < REATTACH_FIRST + SWITCHES + REATTACH_EVICT; index++) await view(page, perf, index);
  const durations: number[] = [];
  for (let index = REATTACH_FIRST; index < REATTACH_FIRST + SWITCHES; index++) {
    const term = perf.terms[index]?.[0] ?? 0;
    expect(await holdsWebgl(page, LOCAL, term)).toBe(false);
    durations.push(await timedSwitch(page, perf.worktrees[index] ?? ''));
    await expect.poll(() => holdsWebgl(page, LOCAL, term)).toBe(true);
  }
  return durations;
};

/** One round: adds and removes a worktree on `branch` with git; returns how long the sidebar took to reflect each. */
const sidebarRound = async (page: Page, perf: PerfRepo, branch: string): Promise<number[]> => {
  await expect(page.locator(worktreeEntry(perf.repo))).toBeVisible();
  const path = `${perf.repo}.worktrees/${branch}`;
  await page.evaluate((selector) => {
    window.__wtdSidebar?.observer.disconnect();
    const observer = new MutationObserver(() => {
      const present = document.querySelector(selector) !== null;
      if (present && state.appeared === null) state.appeared = Date.now();
      if (!present && state.appeared !== null && state.gone === null) state.gone = Date.now();
    });
    const state: { appeared: number | null; gone: number | null; observer: MutationObserver } = { appeared: null, gone: null, observer };
    window.__wtdSidebar = state;
    observer.observe(document, { subtree: true, childList: true, attributes: true });
  }, worktreeEntry(path));

  git(perf.repo, 'worktree', 'add', '-q', '-b', branch, path);
  const added = Date.now();
  await expect.poll(() => page.evaluate(() => window.__wtdSidebar?.appeared ?? null), { timeout: 5000 }).not.toBeNull();
  const appeared = (await page.evaluate(() => window.__wtdSidebar?.appeared)) ?? Number.NaN;

  git(perf.repo, 'worktree', 'remove', path);
  const removed = Date.now();
  await expect.poll(() => page.evaluate(() => window.__wtdSidebar?.gone ?? null), { timeout: 5000 }).not.toBeNull();
  const gone = (await page.evaluate(() => window.__wtdSidebar?.gone)) ?? Number.NaN;
  return [appeared - added, gone - removed];
};

/** One round: views both 8-pane tabs, so the first falls back to DOM, then times 20 switches between them. */
const eightPaneRound = async (page: Page, targets: readonly EightPanes[]): Promise<number[]> => {
  // Each view takes all 8 WebGL contexts, so the other 8-pane tab falls back to DOM.
  for (const target of targets) await viewPanes(page, target);
  const durations: number[] = [];
  for (let i = 0; i < SWITCHES; i++) {
    const target = targets[i % targets.length];
    if (target === undefined) throw new Error('no 8-pane worktree');
    for (const term of target.terms) expect(await holdsWebgl(page, LOCAL, term)).toBe(false);
    durations.push(await timedSwitch(page, target.path));
    for (const term of target.terms) await expect.poll(() => holdsWebgl(page, LOCAL, term)).toBe(true);
  }
  return durations;
};

/** One round: drags a divider of the 8-pane tab across 60 pointer moves, timing each to its painted frame, and drags it back. */
const dragRound = async (page: Page, target: EightPanes): Promise<number[]> => {
  await viewPanes(page, target);
  // The root split of the balanced tab runs right, so its divider moves along x.
  const box = await boxOf(divider(page, ''));
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  const durations: number[] = [];
  for (let i = 0; i < DRAG_MOVES; i++) {
    const paints = await entries(page, DRAG_PAINT);
    // Every move differs from the previous one and keeps the ratio well inside 0.05-0.95.
    await page.mouse.move(x + ((i % 10) - 4.5) * 30, y);
    await expect.poll(() => entries(page, DRAG_PAINT)).toBeGreaterThan(paints);
    durations.push(
      await page.evaluate(
        ([moveName, paintName]) => {
          const move = performance.getEntriesByName(moveName).at(-1);
          const paint = performance.getEntriesByName(paintName).at(-1);
          if (move === undefined || paint === undefined || paint.startTime < move.startTime) return Number.NaN;
          return paint.startTime - move.startTime;
        },
        [DRAG_MOVE, DRAG_PAINT] as const,
      ),
    );
  }
  // Back where the round started, so the next round's moves stay inside the same range; its paint lands in this round.
  const paints = await entries(page, DRAG_PAINT);
  await page.mouse.move(x, y);
  await expect.poll(() => entries(page, DRAG_PAINT)).toBeGreaterThan(paints);
  await page.mouse.up();
  return durations;
};

test('WebGL runs on a hardware renderer', async ({ perf, page }) => {
  await openUi(perf.hub, page);
  const renderer = await webglRenderer(page);
  console.log(`WebGL renderer: ${renderer}`);
  expect(renderer).not.toMatch(/swiftshader|llvmpipe|software|no webgl2/i);
});

test('switching between recently viewed worktrees takes at most 1 frame (median of 20, best of 3 rounds)', async ({ perf, page }) => {
  const interval = await openTimed(perf, page);
  await holds('recently viewed switch', frames(1, interval), () => recentRound(page, perf));
});

test('a recently viewed switch slowed by 2 frames misses its 1-frame budget in all 3 rounds', async ({ perf, page }) => {
  await page.addInitScript(injectSwitchSlowdown, SWITCH_START);
  const interval = await openTimed(perf, page);
  await page.evaluate((ms) => {
    window.__wtdSlowdownMs = ms;
  }, 2 * interval);
  const verdict = await judge('slowed recently viewed switch', frames(1, interval), () => recentRound(page, perf));
  expect(verdict.met).toBe(false);
  expect(verdict.rounds).toHaveLength(ROUNDS);
  expect(verdict.rounds.every((round) => !round.met)).toBe(true);
});

test('switching to worktrees rendered via DOM takes at most 3 frames (median of 20, best of 3 rounds)', async ({ perf, page }) => {
  test.setTimeout(180_000);
  const interval = await openTimed(perf, page);
  await holds('WebGL reattach switch', frames(3, interval), () => reattachRound(page, perf));
});

test('worktrees added and removed with git show in, and leave, the sidebar within 250 ms (best of 3 rounds)', async ({ perf, page }) => {
  await openUi(perf.hub, page);
  await holds('sidebar', withinMs(250), (index) => sidebarRound(page, perf, `sidebar-probe-${String(index + 1)}`));
});

test('switching to an 8-pane tab rendered via DOM takes at most 6 frames (median of 20, best of 3 rounds)', async ({ perf, page }) => {
  test.setTimeout(300_000);
  const targets = await eightPanes(perf);
  const interval = await openTimed(perf, page);
  await holds('eight-pane switch', frames(6, interval), () => eightPaneRound(page, targets));
});

test('dragging a divider of an 8-pane tab paints each pointer move within 1 frame (median of 60, best of 3 rounds)', async ({
  perf,
  page,
}) => {
  test.setTimeout(300_000);
  const [target] = await eightPanes(perf);
  if (target === undefined) throw new Error('no 8-pane worktree');
  const interval = await openTimed(perf, page);
  await holds('divider drag', frames(1, interval), () => dragRound(page, target));
});

test('every budget holds while the status request never returns', async ({ perf, page }) => {
  test.setTimeout(900_000);
  const targets = await eightPanes(perf);
  const [target] = targets;
  if (target === undefined) throw new Error('no 8-pane worktree');
  git(perf.repo, 'remote', 'add', 'origin', 'https://github.com/acme/app.git');
  try {
    await waitUntil(() => perf.gh.running().length > 0, 'gh to hang', 10_000);
    const interval = await openTimed(perf, page);
    await holds('recently viewed switch', frames(1, interval), () => recentRound(page, perf));
    await holds('WebGL reattach switch', frames(3, interval), () => reattachRound(page, perf));
    await holds('sidebar', withinMs(250), (index) => sidebarRound(page, perf, `sidebar-probe-hanging-${String(index + 1)}`));
    await holds('eight-pane switch', frames(6, interval), () => eightPaneRound(page, targets));
    await holds('divider drag', frames(1, interval), () => dragRound(page, target));
  } finally {
    git(perf.repo, 'remote', 'remove', 'origin');
  }
});
