import { describe, expect, it } from 'vitest';
import type { PrStatus, Worktree } from '../../protocol/index.js';
import { prHover, prIcon, prOf, rowPr } from './prs.js';

const pr = (fields: Partial<PrStatus> = {}): PrStatus => ({
  branch: 'feature/x',
  number: 123,
  url: 'https://github.com/acme/app/pull/123',
  state: 'open',
  checks: 'passing',
  conflicts: false,
  review: null,
  ...fields,
});

const worktree = (fields: Partial<Worktree> = {}): Worktree => ({
  path: '/r.wt/x',
  head: 'a'.repeat(40),
  branch: 'feature/x',
  detached: false,
  locked: false,
  prunable: false,
  bare: false,
  main: false,
  ...fields,
});

describe('prHover', () => {
  it.each([
    [pr({ checks: 'failing', review: 'changes-requested' }), '#123 open · checks failing · changes requested'],
    [pr({ number: 7, state: 'merged', checks: 'none' }), '#7 merged'],
    [pr(), '#123 open'],
    [pr({ checks: 'none' }), '#123 open'],
    [pr({ checks: 'pending' }), '#123 open · checks pending'],
    [pr({ state: 'draft', checks: 'pending' }), '#123 draft · checks pending'],
    [pr({ conflicts: true }), '#123 open · conflicts'],
    [pr({ checks: 'failing', conflicts: true }), '#123 open · checks failing · conflicts'],
    [pr({ review: 'approved' }), '#123 open · approved'],
    [pr({ review: 'review-required' }), '#123 open · review required'],
    [
      pr({ state: 'draft', checks: 'pending', conflicts: true, review: 'review-required' }),
      '#123 draft · checks pending · conflicts · review required',
    ],
    [pr({ state: 'closed', checks: 'failing', conflicts: true, review: 'changes-requested' }), '#123 closed'],
    [pr({ state: 'merged', checks: 'passing', review: 'approved' }), '#123 merged'],
  ])('shows %o as %j', (status, line) => {
    expect(prHover(status)).toBe(line);
  });
});

describe('prIcon', () => {
  it.each(['open', 'draft', 'merged', 'closed'] as const)('shows the %s glyph for state %s', (state) => {
    expect(prIcon(pr({ state, checks: 'none' })).glyph).toBe(state);
  });

  it.each([
    [pr({ checks: 'failing' }), 'alert'],
    [pr({ conflicts: true }), 'alert'],
    [pr({ checks: 'pending', conflicts: true }), 'alert'],
    [pr({ state: 'draft', checks: 'failing' }), 'alert'],
    [pr({ checks: 'pending' }), 'pending'],
    [pr({ state: 'draft', checks: 'pending' }), 'pending'],
    [pr({ checks: 'passing' }), null],
    [pr({ checks: 'none' }), null],
    [pr({ state: 'merged', checks: 'failing', conflicts: true }), null],
    [pr({ state: 'closed', checks: 'pending' }), null],
  ])('gives %o the badge %s', (status, badge) => {
    expect(prIcon(status).badge).toBe(badge);
  });
});

describe('prOf', () => {
  const prs = [pr(), pr({ branch: 'main', number: 1 })];

  it("finds the status of the worktree's branch", () => {
    expect(prOf(prs, worktree())).toEqual(pr());
    expect(prOf(prs, worktree({ branch: 'main', main: true }))).toEqual(pr({ branch: 'main', number: 1 }));
  });

  it('finds none for a branch without a pull request', () => {
    expect(prOf(prs, worktree({ branch: 'fix/y' }))).toBeNull();
  });

  it('finds none for a detached worktree or a gone row', () => {
    expect(prOf(prs, worktree({ branch: null, detached: true }))).toBeNull();
    expect(prOf(prs, undefined)).toBeNull();
  });
});

describe('rowPr', () => {
  const SAME = '/srv/app.wt/x';
  const members = [
    { host: 0, state: { worktrees: [worktree({ path: SAME })], prs: [pr({ number: 1 })] } },
    { host: 1, state: { worktrees: [worktree({ path: SAME })], prs: [pr({ number: 2 })] } },
  ];

  it('gives each of two rows at the same path its own host’s status', () => {
    expect(rowPr(members, { host: 0, path: SAME })?.number).toBe(1);
    expect(rowPr(members, { host: 1, path: SAME })?.number).toBe(2);
  });

  it('finds none for a row whose host has no status for its branch, whatever another host has', () => {
    const [local] = members;
    if (local === undefined) throw new Error('no member');
    const without = [local, { host: 1, state: { worktrees: [worktree({ path: SAME })], prs: [] } }];
    expect(rowPr(without, { host: 1, path: SAME })).toBeNull();
    expect(rowPr(without, { host: 2, path: SAME })).toBeNull();
  });
});
