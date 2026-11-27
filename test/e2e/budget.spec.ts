import { expect, test } from '@playwright/test';
import { bestOf, describeRound, frameInterval, frames, judgeRound, ROUNDS, withinMs, type Round } from './budget.js';

const T = 1000 / 60;

/** A round function returning the given rounds in turn, recording the indices it was called with. */
const scripted = (rounds: readonly (readonly number[])[]): { calls: number[]; round: (index: number) => Promise<readonly number[]> } => {
  const calls: number[] = [];
  return {
    calls,
    round: (index) => {
      calls.push(index);
      return Promise.resolve(rounds[index] ?? []);
    },
  };
};

/** 20 switch durations spread over the given range. */
const spread = (low: number, high: number): number[] => Array.from({ length: 20 }, (_, i) => low + ((high - low) * i) / 19);

test.describe('frame budgets', () => {
  test('a round meets n frames when its median is at most (n + ½)·T', () => {
    expect(frames(1, 16).threshold).toBe(24);
    expect(frames(3, 16).threshold).toBe(56);
    expect(frames(6, 16).threshold).toBe(104);
    expect(judgeRound(frames(1, 16), [10, 24, 30]).met).toBe(true);
    expect(judgeRound(frames(1, 16), [10, 24.01, 30]).met).toBe(false);
  });

  test('phase jitter just under one frame meets 1 frame in the first round', async () => {
    const { calls, round } = scripted([spread(12.8, 16.7)]);
    const budget = frames(1, T);
    const verdict = await bestOf(budget, round);
    expect(verdict.budget).toBe(budget);
    expect(verdict.met).toBe(true);
    expect(verdict.rounds).toHaveLength(1);
    expect(calls).toEqual([0]);
  });

  test('a one-frame regression in every round fails all 3 rounds', async () => {
    const slowed = spread(12.8 + T, 16.7 + T);
    const { calls, round } = scripted([slowed, slowed, slowed]);
    const verdict = await bestOf(frames(1, T), round);
    expect(verdict.met).toBe(false);
    expect(verdict.rounds).toHaveLength(ROUNDS);
    expect(verdict.rounds.every((r) => !r.met)).toBe(true);
    expect(calls).toEqual([0, 1, 2]);
  });

  test('a burst in round 1 followed by a passing round 2 holds, and round 3 is not run', async () => {
    const { calls, round } = scripted([spread(30, 60), spread(12.8, 16.7), spread(12.8, 16.7)]);
    const verdict = await bestOf(frames(1, T), round);
    expect(verdict.met).toBe(true);
    expect(verdict.rounds.map((r) => r.met)).toEqual([false, true]);
    expect(calls).toEqual([0, 1]);
  });

  test('bursts in all 3 rounds fail the budget', async () => {
    const { round } = scripted([spread(30, 60), spread(40, 80), spread(30, 90)]);
    const verdict = await bestOf(frames(1, T), round);
    expect(verdict.met).toBe(false);
    expect(verdict.rounds).toHaveLength(ROUNDS);
  });

  test('a round with a non-finite duration fails', () => {
    expect(judgeRound(frames(1, T), [10, Number.NaN, 10]).met).toBe(false);
    expect(judgeRound(frames(1, T), [10, Number.POSITIVE_INFINITY, 10]).met).toBe(false);
  });

  test('each round is reported as it completes', async () => {
    const { round } = scripted([spread(30, 60), spread(12.8, 16.7)]);
    const seen: { index: number; round: Round }[] = [];
    const verdict = await bestOf(frames(1, T), round, (r, index) => seen.push({ index, round: r }));
    expect(seen.map((s) => s.index)).toEqual([0, 1]);
    expect(seen.map((s) => s.round)).toEqual(verdict.rounds);
  });

  test('a round of 20 states its median, p95 and max', () => {
    const round = judgeRound(
      frames(1, T),
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
    expect(round.median).toBe(10.5);
    expect(round.p95).toBe(19);
    expect(round.max).toBe(20);
  });

  test('a round report states its median, p95, max, the threshold and T', () => {
    const budget = frames(1, 16);
    const line = describeRound(budget, judgeRound(budget, [10, 12, 14, 16, 30]), 0);
    expect(line).toContain('median 14.00 ms');
    expect(line).toContain('p95 30.00 ms');
    expect(line).toContain('max 30.00 ms');
    expect(line).toContain('24.00 ms');
    expect(line).toContain('T = 16.00 ms');
  });
});

test.describe('millisecond budgets', () => {
  test('a round is judged by its maximum', () => {
    expect(judgeRound(withinMs(250), [120, 300]).met).toBe(false);
    expect(judgeRound(withinMs(250), [120, 240]).met).toBe(true);
  });
});

test.describe('frame interval', () => {
  test('stays near T when most gaps are doubled or tripled by load and one is short', () => {
    // Neither the minimum (8) nor the median (33.3) lies within 16-17 ms.
    const gaps = [
      8,
      ...Array.from({ length: 15 }, (_, i) => [16.5, 16.7, 16.8][i % 3] ?? 0),
      ...Array.from({ length: 30 }, () => 33.3),
      ...Array.from({ length: 14 }, () => 50),
    ];
    const interval = frameInterval(gaps);
    expect(interval).toBeGreaterThanOrEqual(16);
    expect(interval).toBeLessThanOrEqual(17);
  });

  test('accepts 30 gaps at 240 Hz and at 30 Hz', () => {
    expect(frameInterval(Array.from({ length: 30 }, () => 1000 / 240))).toBeCloseTo(1000 / 240);
    expect(frameInterval(Array.from({ length: 30 }, () => 1000 / 30))).toBeCloseTo(1000 / 30);
  });

  const gapsOf = (gap: number): number[] => Array.from({ length: 60 }, () => gap);

  for (const [name, gaps] of [
    ['fewer than 30 gaps', Array.from({ length: 29 }, () => T)],
    ['no gaps', []],
    ['a NaN gap', [...gapsOf(T), Number.NaN]],
    ['an infinite gap', [...gapsOf(T), Number.POSITIVE_INFINITY]],
    ['a zero gap', [...gapsOf(T), 0]],
    ['a negative gap', [...gapsOf(T), -1]],
    ['an interval under 4 ms', gapsOf(3.5)],
    ['an interval over 34 ms', gapsOf(40)],
  ] as const) {
    test(`throws on ${name}`, () => {
      expect(() => frameInterval(gaps)).toThrow(/frame interval/);
    });
  }
});
