import { describe, expect, it } from 'vitest';
import type { Terminal } from '../../protocol/index.js';
import { aggregate, exitNote, mark, MARK_ORDER, markTitle, ringTitle, terminalStatus, worktreeTitle, type Mark } from './marks.js';

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

const failedCode = { code: 1, signal: null, oom: false };
const failedSignal = { code: 0, signal: 'SIGKILL', oom: false };
const clean = { code: 0, signal: null, oom: false };

const input = terminal({ state: 'input' });
const failed = terminal({ exit: failedCode, unseen: true });
const killed = terminal({ exit: failedSignal, unseen: true });
const done = terminal({ unseen: true, state: 'idle' });
const output = terminal({ unseen: true, state: 'working' });
const quiet = terminal({ state: 'working' });

describe('mark', () => {
  it('ranks marks in the specified order', () => {
    expect(MARK_ORDER).toEqual(['input', 'failed', 'done', 'output']);
  });

  it.each<[string, Partial<Terminal>, Mark | null]>([
    ['needs input', { state: 'input' }, 'input'],
    ['needs input even when exited with failure and unseen', { state: 'input', exit: failedCode, unseen: true }, 'input'],
    ['failed with a non-zero code', { exit: failedCode }, 'failed'],
    ['failed with a signal', { exit: failedSignal }, 'failed'],
    ['failed rather than done', { exit: { code: 2, signal: null, oom: false }, unseen: true, state: 'idle' }, 'failed'],
    ['failed rather than new output', { exit: failedCode, unseen: true, state: 'working' }, 'failed'],
    ['exited with code 0, which only a failure leaves visible', { exit: clean }, 'failed'],
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
    const seenFailed = terminal({ exit: failedCode });
    const seenKilled = terminal({ exit: failedSignal });
    expect(aggregate([output, seenFailed], 'tab')).toEqual({ mark: 'failed', counts: { output: 1, failed: 1 } });
    expect(aggregate([seenFailed, seenKilled], 'tab')).toEqual({ mark: 'failed', counts: { failed: 2 } });
  });

  it('counts an exited terminal on a worktree row or repo tab only while it is unseen', () => {
    const seenFailed = terminal({ exit: failedCode });
    const seenKilled = terminal({ exit: failedSignal });
    const seenWaiting = terminal({ exit: failedCode, state: 'input' });
    expect(aggregate([output, seenFailed, seenKilled, seenWaiting], 'group')).toEqual({ mark: 'output', counts: { output: 1 } });
    expect(aggregate([seenFailed, seenKilled], 'group')).toEqual({ mark: null, counts: {} });
    expect(aggregate([output, failed, killed], 'group')).toEqual({ mark: 'failed', counts: { output: 1, failed: 2 } });
  });

  it('shows a group’s first-ranked mark with the number of terminals per mark', () => {
    expect(aggregate([done, output, done, input, quiet], 'group')).toEqual({ mark: 'input', counts: { done: 2, output: 1, input: 1 } });
  });
});

describe('ringTitle', () => {
  const seenFailure = terminal({ exit: failedCode });
  const seenClean = terminal({ exit: clean });

  it('gives no ring without terminals', () => {
    expect(ringTitle([])).toBeNull();
  });

  it('counts every quiet terminal of a worktree without a mark', () => {
    expect(ringTitle([quiet])).toBe('open: 1');
    expect(ringTitle([quiet, terminal({ state: 'idle' })])).toBe('open: 2');
  });

  it('counts viewed exited terminals, which show no mark on a worktree row', () => {
    expect(ringTitle([seenFailure])).toBe('open: 1');
    expect(ringTitle([quiet, seenFailure, seenClean])).toBe('open: 3');
  });

  it.each([
    ['needs input', input],
    ['failed and unseen', failed],
    ['done', done],
    ['new output', output],
  ])('gives no ring where a terminal that %s shows a mark', (_name, marked) => {
    expect(ringTitle([quiet, marked])).toBeNull();
  });
});

describe('markTitle', () => {
  it('gives one line per mark present, in rank order', () => {
    expect(markTitle({ output: 2, input: 1, done: 3 })).toBe('input: 1\ndone: 3\noutput: 2');
    expect(markTitle({})).toBe('');
  });
});

describe('terminalStatus', () => {
  it.each([
    ['waiting for input', { state: 'input' }],
    ['running', { state: 'working' }],
    ['running', { state: 'working', unseen: true }],
    ['done', { state: 'idle', unseen: true }],
    ['idle', { state: 'idle', unseen: false }],
    ['exited with code 0', { exit: clean }],
    ['exited with code 1', { exit: failedCode }],
    ['killed by SIGKILL', { exit: failedSignal }],
  ] as const)('says %s', (status, fields) => {
    expect(terminalStatus(terminal(fields))).toBe(status);
  });
});

describe('worktreeTitle', () => {
  it('lists each terminal with its preset, id and status under the path', () => {
    const agent = terminal({ termId: 3, preset: 'claude', state: 'input' });
    const shell = terminal({ termId: 4, preset: 'shell', state: 'working' });
    expect(worktreeTitle('/r/wt', [agent, shell])).toBe('/r/wt\nclaude 3: waiting for input\nshell 4: running');
  });

  it('says so when the worktree has no terminals', () => {
    expect(worktreeTitle('/r/wt', [])).toBe('/r/wt\nno terminals');
  });
});

describe('out-of-memory exits', () => {
  const outOfMemory = { code: 0, signal: 'SIGKILL', oom: true };

  it('say killed: out of memory, in place of the signal', () => {
    expect(terminalStatus(terminal({ exit: outOfMemory }))).toBe('killed: out of memory');
    expect(terminalStatus(terminal({ exit: { code: 0, signal: 'SIGKILL', oom: false } }))).toBe('killed by SIGKILL');
  });

  it('say so on hover, the exit taking precedence over the attention state', () => {
    const tests = terminal({ termId: 5, preset: 'tests', exit: outOfMemory, state: 'input' });
    expect(worktreeTitle('/r/wt', [tests])).toBe('/r/wt\ntests 5: killed: out of memory');
  });

  it('count as exited with failure', () => {
    expect(mark(terminal({ exit: outOfMemory }))).toBe('failed');
    expect(aggregate([terminal({ exit: outOfMemory, unseen: true })], 'group')).toEqual({ mark: 'failed', counts: { failed: 1 } });
  });
});

describe('exitNote', () => {
  it.each<[string, Partial<Terminal>, string | null]>([
    ['nothing for a live terminal', {}, null],
    ['exited for an exit code', { exit: { code: 1, signal: null, oom: false } }, 'exited'],
    ['exited for a signal', { exit: { code: 0, signal: 'SIGKILL', oom: false } }, 'exited'],
    ['killed: out of memory for an out-of-memory exit', { exit: { code: 0, signal: 'SIGKILL', oom: true } }, 'killed: out of memory'],
  ])('says %s', (_name, fields, note) => {
    expect(exitNote(terminal(fields))).toBe(note);
  });
});
