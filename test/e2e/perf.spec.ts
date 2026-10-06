import { test as base, expect, type Page } from '@playwright/test';
import { join } from 'node:path';
import type { DaemonClient } from '../support/daemon-client.js';
import { addWorktree, git, makeRepo } from '../support/daemon-host.js';
import { HubHost } from '../support/hub-host.js';
import { byTestId, SWITCH_END, SWITCH_START, terminalBox, TID, worktreeEntry } from './contract.js';
import { createShells, LOCAL, openUi, selectWorktree } from './fixture.js';
import { holdsWebgl, installWebglProbe, webglRenderer } from './webgl.js';

const WORKTREES = 58;
const SWITCHES = 20;

interface PerfRepo {
  hub: HubHost;
  repo: string;
  worktrees: string[];
  /** Terminal ids per worktree; the first is the active tab. */
  terms: number[][];
}

declare global {
  interface Window {
    __wtdSidebar?: { appeared: number | null; gone: number | null };
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
        const repo = makeRepo(join(hub.dir, 'repos', 'big'));
        const worktrees = Array.from({ length: WORKTREES }, (_, i) =>
          addWorktree(repo, join(hub.dir, 'repos', 'big.worktrees', `w${String(i).padStart(2, '0')}`), `w${String(i).padStart(2, '0')}`),
        );
        hub.writeRepos([repo]);
        await hub.start();
        client = await hub.client();
        await client.watch(repo);
        const terms = await createShells(client, worktrees, 2);
        await use({ hub, repo, worktrees, terms });
      } finally {
        client?.close();
        await hub.cleanup();
      }
    },
    { scope: 'worker', timeout: 300_000 },
  ],
});

test.describe.configure({ mode: 'serial' });

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((x, y) => x - y);
  const mid = sorted.length / 2;
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : (sorted[Math.floor(mid)] ?? 0);
};

const percentile = (values: readonly number[], p: number): number => {
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
};

const report = (name: string, durations: readonly number[]): void => {
  const summary = `median ${median(durations).toFixed(2)} ms, p95 ${percentile(durations, 95).toFixed(2)} ms, max ${Math.max(...durations).toFixed(2)} ms`;
  console.log(`${name}: ${summary}`);
  test.info().annotations.push({ type: name, description: summary });
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

test('WebGL runs on a hardware renderer', async ({ perf, page }) => {
  await openUi(perf.hub, page);
  const renderer = await webglRenderer(page);
  console.log(`WebGL renderer: ${renderer}`);
  expect(renderer).not.toMatch(/swiftshader|llvmpipe|software|no webgl2/i);
});

test('switching between recently viewed worktrees takes at most 16 ms (median of 20)', async ({ perf, page }) => {
  await openUi(perf.hub, page);
  const recent = [0, 1, 2, 3];
  for (const index of recent) await view(page, perf, index);
  const durations: number[] = [];
  for (let i = 0; i < SWITCHES; i++) {
    const index = recent[i % recent.length] ?? 0;
    durations.push(await timedSwitch(page, perf.worktrees[index] ?? ''));
    expect(await holdsWebgl(page, LOCAL, perf.terms[index]?.[0] ?? 0)).toBe(true);
  }
  report('recently viewed switch', durations);
  expect(durations.every(Number.isFinite)).toBe(true);
  expect(median(durations)).toBeLessThanOrEqual(16);
});

test('switching to worktrees rendered via DOM takes at most 50 ms (median of 20)', async ({ perf, page }) => {
  await openUi(perf.hub, page);
  const first = 4;
  const viewed = SWITCHES + 8 + 1;
  for (let index = first; index < first + viewed; index++) await view(page, perf, index);
  const durations: number[] = [];
  for (let index = first; index < first + SWITCHES; index++) {
    const term = perf.terms[index]?.[0] ?? 0;
    expect(await holdsWebgl(page, LOCAL, term)).toBe(false);
    durations.push(await timedSwitch(page, perf.worktrees[index] ?? ''));
    await expect.poll(() => holdsWebgl(page, LOCAL, term)).toBe(true);
  }
  report('WebGL reattach switch', durations);
  expect(durations.every(Number.isFinite)).toBe(true);
  expect(median(durations)).toBeLessThanOrEqual(50);
});

test('worktrees added or removed with git show in the sidebar within 250 ms', async ({ perf, page }) => {
  await openUi(perf.hub, page);
  await expect(page.locator(worktreeEntry(perf.repo))).toBeVisible();
  const path = `${perf.repo}.worktrees/sidebar-probe`;
  await page.evaluate((selector) => {
    const state: { appeared: number | null; gone: number | null } = { appeared: null, gone: null };
    window.__wtdSidebar = state;
    new MutationObserver(() => {
      const present = document.querySelector(selector) !== null;
      if (present && state.appeared === null) state.appeared = Date.now();
      if (!present && state.appeared !== null && state.gone === null) state.gone = Date.now();
    }).observe(document, { subtree: true, childList: true, attributes: true });
  }, worktreeEntry(path));

  git(perf.repo, 'worktree', 'add', '-q', '-b', 'sidebar-probe', path);
  const added = Date.now();
  await expect.poll(() => page.evaluate(() => window.__wtdSidebar?.appeared ?? null), { timeout: 5000 }).not.toBeNull();
  const appeared = (await page.evaluate(() => window.__wtdSidebar?.appeared)) ?? Number.NaN;

  git(perf.repo, 'worktree', 'remove', path);
  const removed = Date.now();
  await expect.poll(() => page.evaluate(() => window.__wtdSidebar?.gone ?? null), { timeout: 5000 }).not.toBeNull();
  const gone = (await page.evaluate(() => window.__wtdSidebar?.gone)) ?? Number.NaN;

  console.log(`sidebar: add ${String(appeared - added)} ms, remove ${String(gone - removed)} ms`);
  expect(appeared - added).toBeLessThanOrEqual(250);
  expect(gone - removed).toBeLessThanOrEqual(250);
});
