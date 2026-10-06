import { describe, expect, it } from 'vitest';
import type { Terminal } from '../../protocol/index.js';
import { aggregate, mark, MARK_ORDER, type Mark } from './marks.js';

let nextId = 1;

const terminal = (fields: Partial<Terminal> = {}): Terminal => ({
  termId: nextId++,
  worktree: '/r/app.worktrees/feat',
  preset: 'shell',
  cols: 80,
  rows: 24,
  exit: null,
  unseen: false,
  state: 'idle',
  ...fields,
});

const failedCode = { code: 1, signal: null };
const failedSignal = { code: 0, signal: 'SIGKILL' };
const clean = { code: 0, signal: null };

const input = terminal({ state: 'input' });
const failed = terminal({ exit: failedCode, unseen: true });
const exited = terminal({ exit: clean, unseen: true });
const done = terminal({ unseen: true, state: 'idle' });
const output = terminal({ unseen: true, state: 'working' });
const quiet = terminal({ state: 'working' });

describe('mark', () => {
  it('ranks marks in the specified order', () => {
    expect(MARK_ORDER).toEqual(['input', 'failed', 'exited', 'done', 'output']);
  });

  it.each<[string, Partial<Terminal>, Mark | null]>([
    ['needs input', { state: 'input' }, 'input'],
    ['needs input even when exited with failure and unseen', { state: 'input', exit: failedCode, unseen: true }, 'input'],
    ['failed with a non-zero code', { exit: failedCode }, 'failed'],
    ['failed with a signal', { exit: failedSignal }, 'failed'],
    ['failed rather than done', { exit: { code: 2, signal: null }, unseen: true, state: 'idle' }, 'failed'],
    ['exited cleanly', { exit: clean }, 'exited'],
    ['exited rather than new output', { exit: clean, unseen: true, state: 'working' }, 'exited'],
    ['done when unseen and idle', { unseen: true, state: 'idle' }, 'done'],
    ['new output when unseen and working', { unseen: true, state: 'working' }, 'output'],
    ['nothing when seen and idle', { state: 'idle' }, null],
    ['nothing when seen and working', { state: 'working' }, null],
  ])('marks a terminal that %s', (_name, fields, expected) => {
    expect(mark(terminal(fields))).toBe(expected);
  });
});

describe('aggregate', () => {
  it('shows nothing without terminals', () => {
    expect(aggregate([], 'tab')).toEqual({ mark: null, counts: {} });
    expect(aggregate([], 'group')).toEqual({ mark: null, counts: {} });
  });

  it('shows a tab’s first-ranked mark and counts every mark', () => {
    expect(aggregate([output, done, quiet, input, output], 'tab')).toEqual({ mark: 'input', counts: { output: 2, done: 1, input: 1 } });
    expect(aggregate([output, done], 'tab')).toEqual({ mark: 'done', counts: { output: 1, done: 1 } });
    expect(aggregate([quiet], 'tab')).toEqual({ mark: null, counts: {} });
  });

  it('counts a seen exited terminal on a tab', () => {
    const seen = terminal({ exit: clean });
    const seenFailed = terminal({ exit: failedCode });
    expect(aggregate([output, seen], 'tab')).toEqual({ mark: 'exited', counts: { output: 1, exited: 1 } });
    expect(aggregate([seenFailed, seen], 'tab')).toEqual({ mark: 'failed', counts: { failed: 1, exited: 1 } });
  });

  it('counts an exited terminal on a worktree row or repo tab only while it is unseen', () => {
    const seen = terminal({ exit: clean });
    const seenFailed = terminal({ exit: failedCode });
    const seenWaiting = terminal({ exit: clean, state: 'input' });
    expect(aggregate([output, seen, seenFailed, seenWaiting], 'group')).toEqual({ mark: 'output', counts: { output: 1 } });
    expect(aggregate([seen, seenFailed], 'group')).toEqual({ mark: null, counts: {} });
    expect(aggregate([output, failed, exited], 'group')).toEqual({ mark: 'failed', counts: { output: 1, failed: 1, exited: 1 } });
  });

  it('shows a group’s first-ranked mark with the number of terminals per mark', () => {
    expect(aggregate([done, output, done, input, quiet], 'group')).toEqual({ mark: 'input', counts: { done: 2, output: 1, input: 1 } });
  });
});
