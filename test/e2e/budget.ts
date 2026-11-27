/** Rounds measured per budget at most; the budget holds if any one meets it. */
export const ROUNDS = 3;

/** Fewest animation frame gaps a frame interval is estimated from. */
const MIN_GAPS = 30;
/** Plausible frame intervals: 30–250 Hz. */
const MIN_INTERVAL_MS = 4;
const MAX_INTERVAL_MS = 34;

/** A budget of whole frames at interval T, judged by a round's median, or of milliseconds, judged by its maximum. */
export type Budget =
  { kind: 'frames'; frames: number; interval: number; threshold: number; label: string } | { kind: 'ms'; threshold: number; label: string };

/** One round's statistics and whether it met its budget. */
export interface Round {
  median: number;
  p95: number;
  max: number;
  met: boolean;
}

export interface Verdict {
  budget: Budget;
  met: boolean;
  rounds: Round[];
}

/** A budget of `n` frames at interval `interval`: a round meets it when its median is at most (n + ½)·T. */
export const frames = (n: number, interval: number): Budget => ({
  kind: 'frames',
  frames: n,
  interval,
  threshold: (n + 0.5) * interval,
  label: `${String(n)} frame${n === 1 ? '' : 's'}`,
});

/** A budget of `ms` milliseconds: a round meets it when its maximum is at most `ms`. */
export const withinMs = (ms: number): Budget => ({ kind: 'ms', threshold: ms, label: `${String(ms)} ms` });

const sorted = (values: readonly number[]): number[] => [...values].sort((x, y) => x - y);

const median = (values: readonly number[]): number => {
  const s = sorted(values);
  const mid = s.length / 2;
  if (s.length === 0) return Number.NaN;
  return s.length % 2 === 0 ? ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2 : (s[Math.floor(mid)] ?? 0);
};

/** Nearest-rank percentile. */
const percentile = (values: readonly number[], p: number): number => {
  const s = sorted(values);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))] ?? Number.NaN;
};

/** Judges one round of durations against `budget`; an empty round or a non-finite duration fails it. */
export const judgeRound = (budget: Budget, durations: readonly number[]): Round => {
  const stats = {
    median: median(durations),
    p95: percentile(durations, 95),
    max: durations.length === 0 ? Number.NaN : Math.max(...durations),
  };
  const value = budget.kind === 'frames' ? stats.median : stats.max;
  const met = durations.length > 0 && durations.every((d) => Number.isFinite(d)) && value <= budget.threshold;
  return { ...stats, met };
};

/** Measures up to ROUNDS rounds in turn, stopping at the first that meets `budget`. */
export const bestOf = async (
  budget: Budget,
  round: (index: number) => Promise<readonly number[]>,
  onRound?: (result: Round, index: number) => void,
): Promise<Verdict> => {
  const rounds: Round[] = [];
  for (let index = 0; index < ROUNDS; index++) {
    const result = judgeRound(budget, await round(index)); // NOSONAR(S9382) — rounds must not overlap
    rounds.push(result);
    onRound?.(result, index);
    if (result.met) return { budget, met: true, rounds };
  }
  return { budget, met: false, rounds };
};

/** One line stating a round's statistics, the budget's threshold and, for a frame budget, T. */
export const describeRound = (budget: Budget, round: Round, index: number): string => {
  const ms = (value: number): string => `${value.toFixed(2)} ms`;
  const limit =
    budget.kind === 'frames'
      ? `median ≤ ${ms(budget.threshold)} (${budget.label}, T = ${ms(budget.interval)})`
      : `max ≤ ${ms(budget.threshold)}`;
  return `round ${String(index + 1)}/${String(ROUNDS)}: median ${ms(round.median)}, p95 ${ms(round.p95)}, max ${ms(round.max)}; ${limit}: ${round.met ? 'met' : 'missed'}`;
};

/** The page's frame interval: the lowest decile of animation frame gaps, which load only lengthens. */
export const frameInterval = (gaps: readonly number[]): number => {
  if (gaps.length < MIN_GAPS) throw new Error(`frame interval needs at least ${String(MIN_GAPS)} gaps, got ${String(gaps.length)}`);
  if (!gaps.every((gap) => Number.isFinite(gap) && gap > 0)) throw new Error('frame interval needs finite positive gaps');
  const interval = percentile(gaps, 10);
  if (interval < MIN_INTERVAL_MS || interval > MAX_INTERVAL_MS) {
    throw new Error(`frame interval ${interval.toFixed(2)} ms is outside ${String(MIN_INTERVAL_MS)}–${String(MAX_INTERVAL_MS)} ms`);
  }
  return interval;
};
