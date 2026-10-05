/** Reading time a PTY stream gets before a requested destroy goes through. */
export const DESTROY_GRACE_MS = 200;

export interface StreamGuard {
  /** Reading paused: a requested destroy waits. */
  paused: () => void;
  /** Reading resumed: a requested destroy goes through after DESTROY_GRACE_MS of reading in total. */
  resumed: () => void;
}

/**
 * The pinned PTY package destroys its read stream (`_socket`) 200 ms after the child exits, which
 * drops unread output while the stream is paused. This holds that destroy back until the stream
 * has been read for DESTROY_GRACE_MS since it was requested.
 */
export const guardStream = (pty: object, isPaused: () => boolean): StreamGuard => {
  const stream: unknown = Reflect.get(pty, '_socket');
  const destroy: unknown = typeof stream === 'object' && stream !== null ? Reflect.get(stream, 'destroy') : undefined;
  if (typeof stream !== 'object' || stream === null || typeof destroy !== 'function') {
    throw new Error('the PTY package has no read stream to guard');
  }
  let request: unknown[] | null = null;
  let remaining = DESTROY_GRACE_MS;
  let timer: NodeJS.Timeout | null = null;
  let since = 0;
  const arm = (): void => {
    const args = request;
    if (args === null || timer !== null || isPaused()) return;
    since = Date.now();
    timer = setTimeout(() => {
      timer = null;
      request = null;
      Reflect.apply(destroy, stream, args);
    }, remaining);
  };
  const disarm = (): void => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
    remaining = Math.max(0, remaining - (Date.now() - since));
  };
  Reflect.set(stream, 'destroy', (...args: unknown[]): unknown => {
    request = args;
    arm();
    return stream;
  });
  return { paused: disarm, resumed: arm };
};
