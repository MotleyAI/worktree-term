import type { Locator, Page } from '@playwright/test';
import { git, sleep } from '../support/daemon-host.js';
import { fakePrUrl, type FakeGh, type FakePr } from '../support/fake-gh.js';
import type { HubHost } from '../support/hub-host.js';
import { byTestId, TID, worktreeEntry } from './contract.js';
import { createShells, expect, makeRepoWith, openPage, openUi, PR_INTERVAL_MS, selectWorktree, test, watcher } from './fixture.js';

const ORIGIN = 'https://github.com/acme/app.git';

const icon = (page: Page, path: string): Locator => page.locator(worktreeEntry(path)).locator(byTestId(TID.prIcon));
const badge = (page: Page, path: string): Locator => icon(page, path).locator(byTestId(TID.prBadge));

/** A repo whose origin is on GitHub, with linked worktrees on `branches`, listed in the hub's config. */
const githubRepo = (hub: HubHost, branches: readonly string[]): { repo: string; worktrees: string[] } => {
  const made = makeRepoWith(hub, 'app', branches);
  git(made.repo, 'remote', 'add', 'origin', ORIGIN);
  hub.writeRepos([made.repo]);
  return made;
};

const rightEdge = async (locator: Locator): Promise<number> => {
  const box = await locator.boundingBox();
  if (box === null) throw new Error('the element is not shown');
  return box.x + box.width;
};

type Hue = 'green' | 'grey' | 'purple' | 'red' | 'amber' | 'other';

/** The colour family of `locator`'s computed `color`. */
const hueOf = async (locator: Locator): Promise<Hue> => {
  const colour = await locator.evaluate((el) => getComputedStyle(el).color);
  const [r = 0, g = 0, b = 0] = (colour.match(/[\d.]+/g) ?? []).map(Number);
  if (Math.max(r, g, b) - Math.min(r, g, b) < 40) return 'grey';
  if (g > r && g > b) return 'green';
  if (r > 1.5 * g && r > 1.5 * b) return 'red';
  if (r > g && b > g) return 'purple';
  if (r > b && g > b) return 'amber';
  return 'other';
};

test.describe('pull request icons', () => {
  test('show the state glyph, a red ✕ for failing checks, and nothing for a branch without a pull request', async ({ hub, gh, page }) => {
    const { worktrees } = githubRepo(hub, ['passing', 'failing', 'merged', 'none']);
    const [passing = '', failing = '', merged = '', none = ''] = worktrees;
    const prs: Record<string, FakePr> = {
      passing: { number: 1, checks: 'SUCCESS' },
      failing: { number: 2, checks: 'FAILURE' },
      merged: { number: 3, state: 'MERGED' },
    };
    gh.behave({ kind: 'answer', prs });
    await openUi(hub, page);
    await expect(icon(page, passing)).toHaveAttribute('data-state', 'open');
    await expect(badge(page, passing)).toHaveCount(0);
    await expect(icon(page, failing)).toHaveAttribute('data-state', 'open');
    await expect(badge(page, failing)).toHaveAttribute('data-badge', 'alert');
    await expect(icon(page, merged)).toHaveAttribute('data-state', 'merged');
    await expect(badge(page, merged)).toHaveCount(0);
    await expect(icon(page, none)).toHaveCount(0);
  });

  test('are coloured as GitHub colours each state, the ✕ red and the dot amber', async ({ hub, gh, page }) => {
    const { worktrees } = githubRepo(hub, ['open', 'draft', 'merged', 'closed']);
    const [open = '', draft = '', merged = '', closed = ''] = worktrees;
    gh.behave({
      kind: 'answer',
      prs: {
        open: { number: 1, checks: 'FAILURE' },
        draft: { number: 2, isDraft: true, checks: 'PENDING' },
        merged: { number: 3, state: 'MERGED' },
        closed: { number: 4, state: 'CLOSED' },
      },
    });
    await openUi(hub, page);
    await expect(badge(page, open)).toBeVisible();
    await expect(badge(page, draft)).toBeVisible();
    await expect(icon(page, merged)).toBeVisible();
    await expect(icon(page, closed)).toBeVisible();
    expect(await hueOf(icon(page, open))).toBe('green');
    expect(await hueOf(icon(page, draft))).toBe('grey');
    expect(await hueOf(icon(page, merged))).toBe('purple');
    expect(await hueOf(icon(page, closed))).toBe('red');
    expect(await hueOf(badge(page, open))).toBe('red');
    expect(await hueOf(badge(page, draft))).toBe('amber');
  });

  test('show a draft with pending checks as the draft glyph with an amber dot', async ({ hub, gh, page }) => {
    const { worktrees } = githubRepo(hub, ['wip']);
    gh.behave({ kind: 'answer', prs: { wip: { number: 4, isDraft: true, checks: 'PENDING' } } });
    await openUi(hub, page);
    await expect(icon(page, worktrees[0] ?? '')).toHaveAttribute('data-state', 'draft');
    await expect(badge(page, worktrees[0] ?? '')).toHaveAttribute('data-badge', 'pending');
  });

  test('give one line on hover', async ({ hub, gh, page }) => {
    const { worktrees } = githubRepo(hub, ['feature/x', 'fix/y']);
    const [feature = '', fix = ''] = worktrees;
    gh.behave({
      kind: 'answer',
      prs: {
        'feature/x': { number: 123, checks: 'FAILURE', reviewDecision: 'CHANGES_REQUESTED' },
        'fix/y': { number: 7, state: 'MERGED', checks: null },
      },
    });
    await openUi(hub, page);
    await expect(icon(page, feature)).toHaveAttribute('title', '#123 open · checks failing · changes requested');
    await expect(icon(page, feature)).toHaveAttribute('aria-label', '#123 open · checks failing · changes requested');
    await expect(icon(page, fix)).toHaveAttribute('title', '#7 merged');
  });

  test('a click opens the pull request in a new window and keeps the selected worktree', async ({ hub, gh, page, context }) => {
    const { repo, worktrees } = githubRepo(hub, ['feature/x']);
    const feature = worktrees[0] ?? '';
    gh.behave({ kind: 'answer', prs: { 'feature/x': { number: 12 } } });
    await context.route('https://github.com/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<title>pull request</title>' }),
    );
    await openUi(hub, page);
    await selectWorktree(page, repo);
    await expect(icon(page, feature)).toHaveAttribute('href', fakePrUrl(12));
    await expect(icon(page, feature)).toHaveAttribute('target', '_blank');
    const rel = (await icon(page, feature).getAttribute('rel')) ?? '';
    expect(rel.split(/\s+/)).toEqual(expect.arrayContaining(['noopener', 'noreferrer']));
    const popup = context.waitForEvent('page');
    await icon(page, feature).click();
    const opened = await popup;
    await expect.poll(() => opened.url()).toBe(fakePrUrl(12));
    await expect(page.locator(worktreeEntry(repo))).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator(worktreeEntry(feature))).toHaveAttribute('aria-selected', 'false');
  });

  test('sit directly left of the mark or ring, and a row without a pull request reserves no space for one', async ({ hub, gh, page }) => {
    const { repo, worktrees } = githubRepo(hub, ['with-pr', 'without-pr']);
    const [withPr = '', withoutPr = ''] = worktrees;
    gh.behave({ kind: 'answer', prs: { 'with-pr': { number: 5 } } });
    await openUi(hub, page);
    const client = await watcher(hub, repo);
    await createShells(client, [withPr, withoutPr]);
    const attention = `${byTestId(TID.mark)}, ${byTestId(TID.ring)}`;
    const attentionOf = (path: string): Locator => page.locator(worktreeEntry(path)).locator(attention);
    await expect(attentionOf(withPr)).toBeVisible();
    await expect(attentionOf(withoutPr)).toBeVisible();
    await expect(icon(page, withPr)).toBeVisible();
    await expect(icon(page, withoutPr)).toHaveCount(0);
    expect(await icon(page, withPr).evaluate((el, selector) => el.nextElementSibling?.matches(selector) === true, attention)).toBe(true);
    const attentionBox = await attentionOf(withPr).boundingBox();
    expect(await rightEdge(icon(page, withPr))).toBeLessThanOrEqual(attentionBox?.x ?? 0);
    expect(await rightEdge(attentionOf(withPr))).toBeCloseTo(await rightEdge(attentionOf(withoutPr)), 0);
  });

  test('follow a state change on GitHub within one refresh interval, without a reload', async ({ hub, gh, page }) => {
    const { worktrees } = githubRepo(hub, ['feature/x']);
    const feature = worktrees[0] ?? '';
    gh.behave({ kind: 'answer', prs: { 'feature/x': { number: 12 } } });
    await openUi(hub, page);
    await expect(icon(page, feature)).toHaveAttribute('data-state', 'open');
    gh.behave({ kind: 'answer', prs: { 'feature/x': { number: 12, state: 'MERGED' } } });
    await expect(icon(page, feature)).toHaveAttribute('data-state', 'merged', { timeout: 2 * PR_INTERVAL_MS + 1000 });
    gh.behave({ kind: 'answer', prs: {} });
    await expect(icon(page, feature)).toHaveCount(0, { timeout: 2 * PR_INTERVAL_MS + 1000 });
  });

  test('show on a second page without a new status request', async ({ hub, gh, page, context }) => {
    const { worktrees } = githubRepo(hub, ['feature/x']);
    const feature = worktrees[0] ?? '';
    gh.behave({ kind: 'answer', prs: { 'feature/x': { number: 12 } } });
    hub.extraEnv = { ...hub.extraEnv, WTD_PR_INTERVAL_MS: '600000' };
    await openUi(hub, page);
    await expect(icon(page, feature)).toHaveAttribute('data-state', 'open');
    const calls = gh.calls().length;
    const second = await openPage(hub, context);
    await expect(icon(second.page, feature)).toHaveAttribute('data-state', 'open');
    await sleep(300);
    expect(gh.calls()).toHaveLength(calls);
  });

  test('rows show at once while the status request hangs', async ({ hub, gh, page }) => {
    const { repo, worktrees } = githubRepo(hub, ['feature/x']);
    gh.behave({ kind: 'hang' });
    await openUi(hub, page);
    await expect(page.locator(worktreeEntry(repo))).toBeVisible();
    await expect(page.locator(worktreeEntry(worktrees[0] ?? ''))).toBeVisible();
    await expect.poll(() => gh.calls().length).toBeGreaterThan(0);
    await expect(page.locator(byTestId(TID.prIcon))).toHaveCount(0);
  });

  const failingGh: readonly (readonly [string, (hub: HubHost, gh: FakeGh) => void])[] = [
    [
      'the host has no gh',
      (hub, gh) => {
        hub.extraEnv = { ...hub.extraEnv, PATH: gh.pathWithoutGh() };
      },
    ],
    [
      'gh is not logged in',
      (_hub, gh) => {
        gh.behave({ kind: 'exit', code: 4, stderr: 'To get started with GitHub CLI, please run:  gh auth login\n' });
      },
    ],
  ];
  for (const [name, setup] of failingGh) {
    test(`show neither icons nor an error when ${name}`, async ({ hub, gh, page }) => {
      const { worktrees } = githubRepo(hub, ['feature/x']);
      setup(hub, gh);
      await openUi(hub, page);
      await expect(page.locator(worktreeEntry(worktrees[0] ?? ''))).toBeVisible();
      await sleep(2 * PR_INTERVAL_MS);
      await expect(page.locator(byTestId(TID.prIcon))).toHaveCount(0);
      await expect(page.locator(byTestId(TID.notice))).toHaveCount(0);
      await expect(page.locator(byTestId(TID.repoError))).toHaveCount(0);
    });
  }
});
