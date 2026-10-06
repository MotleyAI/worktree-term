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

/** Runs the read check the guard schedules once its grace time is spent. */
const runCheck = (): void => {
  vi.advanceTimersToNextTimer();
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
    runCheck();
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
    runCheck();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('needs DESTROY_GRACE_MS of uninterrupted reading', () => {
    const { pty, stream, destroy } = fakePty();
    const guard = guardStream(pty, () => paused);
    stream.destroy();
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime((DESTROY_GRACE_MS * 3) / 4);
      pause(guard);
      vi.advanceTimersByTime(10 * DESTROY_GRACE_MS);
      resume(guard);
    }
    expect(destroy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(DESTROY_GRACE_MS);
    runCheck();
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

  it('restarts the quiet period on output', () => {
    const { pty, stream, destroy } = fakePty();
    const guard = guardStream(pty, () => paused);
    stream.destroy();
    vi.advanceTimersByTime(DESTROY_GRACE_MS / 2);
    guard.received();
    vi.advanceTimersByTime((DESTROY_GRACE_MS * 3) / 2 - 1);
    expect(destroy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    runCheck();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('waits when the poll after the quiet period reads output', () => {
    const { pty, stream, destroy } = fakePty();
    const guard = guardStream(pty, () => paused);
    stream.destroy();
    vi.advanceTimersByTime(DESTROY_GRACE_MS);
    guard.received();
    runCheck();
    expect(destroy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(DESTROY_GRACE_MS);
    runCheck();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('lets beforeDestroy delay the destroy', () => {
    const { pty, stream, destroy } = fakePty();
    const beforeDestroy = vi.fn<(go: () => void) => void>();
    guardStream(pty, () => paused, beforeDestroy);
    stream.destroy();
    vi.advanceTimersByTime(10 * DESTROY_GRACE_MS);
    expect(destroy).not.toHaveBeenCalled();
    expect(beforeDestroy).toHaveBeenCalledTimes(1);
    beforeDestroy.mock.calls[0]?.[0]();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('refuses a PTY without the read stream it guards', () => {
    expect(() => guardStream({}, () => paused)).toThrow();
  });
});
