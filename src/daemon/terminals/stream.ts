import { readSync } from 'node:fs';

/** Reading without output a PTY stream gets before a requested destroy goes through. */
export const DESTROY_GRACE_MS = 200;

const DRAIN_CHUNK = 64 * 1024;
/** Bounds a drain while a process still holding the PTY keeps writing. */
const MAX_DRAIN_CHUNKS = 16;

/**
 * Reads what a non-blocking PTY master `fd` still holds until EIO, EOF or EAGAIN. Linux can report
 * the end of a PTY's output (EIO) while the tail of it is still on its way from the slave, so the
 * read stream stops early.
 */
export const drainFd = (fd: number, output: (data: Uint8Array) => void): void => {
  for (let i = 0; i < MAX_DRAIN_CHUNKS; i++) {
    const chunk = Buffer.alloc(DRAIN_CHUNK);
    let read: number;
    try {
      read = readSync(fd, chunk, 0, chunk.length, null);
    } catch {
      return;
    }
    if (read === 0) return;
    output(chunk.subarray(0, read));
  }
};

export interface StreamGuard {
  /** Reading paused: a requested destroy waits. */
  paused: () => void;
  /** Reading resumed: a requested destroy goes through after DESTROY_GRACE_MS of reading without output. */
  resumed: () => void;
  /** Output was read. */
  received: () => void;
}

/**
 * The pinned PTY package destroys its read stream (`_socket`) 200 ms after the child exits, which
 * drops output still unread, or still in the kernel on its way from the slave. This holds that
 * destroy back until reading has gone DESTROY_GRACE_MS without output, then lets `beforeDestroy`
 * delay it (destroying closes the master fd).
 */
export const guardStream = (
  pty: object,
  isPaused: () => boolean,
  beforeDestroy: (destroy: () => void) => void = (destroy) => {
    destroy();
  },
): StreamGuard => {
  const stream: unknown = Reflect.get(pty, '_socket');
  const destroy: unknown = typeof stream === 'object' && stream !== null ? Reflect.get(stream, 'destroy') : undefined;
  if (typeof stream !== 'object' || stream === null || typeof destroy !== 'function') {
    throw new Error('the PTY package has no read stream to guard');
  }
  let request: unknown[] | null = null;
  let timer: NodeJS.Timeout | null = null;
  let check: NodeJS.Immediate | null = null;
  let read = false;
  const arm = (): void => {
    if (request === null || timer !== null || check !== null || isPaused()) return;
    read = false;
    timer = setTimeout(() => {
      timer = null;
      if (read) {
        arm();
        return;
      }
      // Timers run before the poll phase; destroy only once a poll has read nothing more.
      check = setImmediate(() => {
        check = null;
        const args = request;
        if (args === null) return;
        if (read) {
          arm();
          return;
        }
        request = null;
        beforeDestroy(() => {
          Reflect.apply(destroy, stream, args);
        });
      });
    }, DESTROY_GRACE_MS);
  };
  const disarm = (): void => {
    if (timer !== null) clearTimeout(timer);
    if (check !== null) clearImmediate(check);
    timer = null;
    check = null;
  };
  Reflect.set(stream, 'destroy', (...args: unknown[]): unknown => {
    request = args;
    arm();
    return stream;
  });
  return {
    paused: disarm,
    resumed: arm,
    received: () => {
      read = true;
    },
  };
};
