import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DESTROY_GRACE_MS, guardStream, type StreamGuard } from './stream.js';

/** The shape of the PTY package's terminal that the guard relies on. */
const fakePty = () => {
  const destroy = vi.fn<(error?: Error) => void>();
  const stream = { destroy };
  return { pty: { _socket: stream }, stream, destroy };
};

let paused: boolean;

const pause = (guard: StreamGuard): void => {
  paused = true;
  guard.paused();
};

const resume = (guard: StreamGuard): void => {
  paused = false;
  guard.resumed();
};

beforeEach(() => {
  vi.useFakeTimers();
  paused = false;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('guardStream', () => {
  it('destroys after DESTROY_GRACE_MS of reading', () => {
    const { pty, stream, destroy } = fakePty();
    guardStream(pty, () => paused);
    const error = new Error('x');
    stream.destroy(error);
    vi.advanceTimersByTime(DESTROY_GRACE_MS - 1);
    expect(destroy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(destroy).toHaveBeenCalledExactlyOnceWith(error);
  });

  it('does not destroy while paused', () => {
    const { pty, stream, destroy } = fakePty();
    const guard = guardStream(pty, () => paused);
    pause(guard);
    stream.destroy();
    vi.advanceTimersByTime(10 * DESTROY_GRACE_MS);
    expect(destroy).not.toHaveBeenCalled();
    resume(guard);
    vi.advanceTimersByTime(DESTROY_GRACE_MS);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('counts only time spent reading', () => {
    const { pty, stream, destroy } = fakePty();
    const guard = guardStream(pty, () => paused);
    stream.destroy();
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(DESTROY_GRACE_MS / 4);
      pause(guard);
      vi.advanceTimersByTime(10 * DESTROY_GRACE_MS);
      resume(guard);
    }
    expect(destroy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(DESTROY_GRACE_MS / 4);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('does nothing on resume without a requested destroy', () => {
    const { pty, destroy } = fakePty();
    const guard = guardStream(pty, () => paused);
    pause(guard);
    resume(guard);
    vi.advanceTimersByTime(10 * DESTROY_GRACE_MS);
    expect(destroy).not.toHaveBeenCalled();
  });

  it('refuses a PTY without the read stream it guards', () => {
    expect(() => guardStream({}, () => paused)).toThrow();
  });
});
