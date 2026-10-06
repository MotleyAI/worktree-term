import { describe, expect, it, vi } from 'vitest';
import type { Terminal } from '../../protocol/index.js';
import { RequestError } from '../client/index.js';
import { closeTargets, needsConfirm } from './closing.js';

const terminal = (termId: number, exit: Terminal['exit'] = null): Terminal => ({
  termId,
  worktree: '/r/app.worktrees/feat',
  preset: 'shell',
  cols: 80,
  rows: 24,
  exit,
  unseen: false,
  state: 'idle',
});

interface Deferred {
  resolve: () => void;
  reject: (error: unknown) => void;
}

/** A `close` whose calls stay pending until the test settles them. */
const pendingClose = () => {
  const calls = new Map<number, Deferred>();
  const close = vi.fn<(termId: number) => Promise<void>>(
    (termId) =>
      new Promise<void>((resolve, reject) => {
        calls.set(termId, { resolve, reject });
      }),
  );
  const settle = (termId: number): Deferred => {
    const call = calls.get(termId);
    if (call === undefined) throw new Error(`no close of ${String(termId)}`);
    return call;
  };
  return { close, settle };
};

describe('needsConfirm', () => {
  it('keeps the targets that have not exited, in order', () => {
    const targets = [terminal(3), terminal(1, { code: 0, signal: null }), terminal(2), terminal(4, { code: 0, signal: 'SIGHUP' })];
    expect(needsConfirm(targets).map((t) => t.termId)).toEqual([3, 2]);
  });

  it('needs nothing when every target has exited', () => {
    expect(needsConfirm([terminal(1, { code: 1, signal: null }), terminal(2, { code: 0, signal: null })])).toEqual([]);
    expect(needsConfirm([])).toEqual([]);
  });
});

describe('closeTargets', () => {
  it('closes only the targets still live', async () => {
    const close = vi.fn<(termId: number) => Promise<void>>(() => Promise.resolve());
    await closeTargets([1, 2, 3], [3, 1, 7], close);
    expect(close.mock.calls.map(([termId]) => termId).toSorted((a, b) => a - b)).toEqual([1, 3]);
  });

  it('closes the targets concurrently', async () => {
    const { close, settle } = pendingClose();
    const closing = closeTargets([1, 2], [1, 2], close);
    await Promise.resolve();
    expect(close.mock.calls.map(([termId]) => termId).toSorted((a, b) => a - b)).toEqual([1, 2]);
    settle(1).resolve();
    settle(2).resolve();
    await expect(closing).resolves.toBeUndefined();
  });

  it('counts a terminal already gone as closed', async () => {
    const close = vi.fn<(termId: number) => Promise<void>>((termId) =>
      termId === 1 ? Promise.reject(new RequestError('unknown-term', 'no terminal 1')) : Promise.resolve(),
    );
    await expect(closeTargets([1, 2], [1, 2], close)).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('propagates any other failure', async () => {
    const failure = new RequestError('host-unavailable', 'host is down');
    const close = vi.fn<(termId: number) => Promise<void>>((termId) => (termId === 2 ? Promise.reject(failure) : Promise.resolve()));
    await expect(closeTargets([1, 2], [1, 2], close)).rejects.toBe(failure);
    const other = new Error('session closed');
    await expect(closeTargets([1], [1], () => Promise.reject(other))).rejects.toBe(other);
  });

  it('sends nothing when no target is live', async () => {
    const close = vi.fn<(termId: number) => Promise<void>>(() => Promise.resolve());
    await closeTargets([1, 2], [], close);
    expect(close).not.toHaveBeenCalled();
  });
});
