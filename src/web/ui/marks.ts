import type { Terminal } from '../../protocol/index.js';

/** Attention marks in rank order. */
export const MARK_ORDER = ['input', 'failed', 'exited', 'done', 'output'] as const;

export type Mark = (typeof MARK_ORDER)[number];

/** A tab counts every terminal; a group (worktree row, repo tab) counts an exited one only while unseen. */
export type MarkLevel = 'tab' | 'group';

export interface Aggregate {
  mark: Mark | null;
  counts: Partial<Record<Mark, number>>;
}

/** The terminal's mark: the first of needs input, failed, exited, done and new output that applies. */
export const mark = (t: Terminal): Mark | null => {
  if (t.state === 'input') return 'input';
  if (t.exit !== null) return t.exit.code !== 0 || t.exit.signal !== null ? 'failed' : 'exited';
  if (!t.unseen) return null;
  return t.state === 'idle' ? 'done' : 'output';
};

/** The first-ranked mark of `terminals` with the number of terminals per mark. */
export const aggregate = (terminals: readonly Terminal[], level: MarkLevel): Aggregate => {
  const counts: Partial<Record<Mark, number>> = {};
  for (const t of terminals) {
    if (level === 'group' && t.exit !== null && !t.unseen) continue;
    const m = mark(t);
    if (m !== null) counts[m] = (counts[m] ?? 0) + 1;
  }
  return { mark: MARK_ORDER.find((m) => counts[m] !== undefined) ?? null, counts };
};

/** One line `<mark>: <count>` per mark present, in rank order. */
export const markTitle = (counts: Aggregate['counts']): string =>
  MARK_ORDER.flatMap((m) => (counts[m] === undefined ? [] : [`${m}: ${String(counts[m])}`])).join('\n');
