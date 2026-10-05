import { write } from 'node:fs';

const RETRY_MS = 10;
/** Most input bytes a terminal holds that its PTY has not accepted. */
export const MAX_UNACCEPTED = 1024 * 1024;

const isAgain = (error: NodeJS.ErrnoException): boolean => error.code === 'EAGAIN' || error.code === 'EWOULDBLOCK';

/**
 * Writes input to a non-blocking PTY master fd in order, retrying while the PTY is full, and
 * counts the bytes it has not yet accepted.
 */
export class InputWriter {
  private readonly queue: Uint8Array[] = [];
  private unaccepted = 0;
  private writing = false;
  private stopped = false;

  constructor(private readonly fd: number) {}

  /** Queues `data`; returns false, discarding it, when more than MAX_UNACCEPTED bytes wait. */
  push(data: Uint8Array): boolean {
    if (this.stopped) return true;
    if (this.unaccepted > MAX_UNACCEPTED) return false;
    if (data.length === 0) return true;
    this.queue.push(data);
    this.unaccepted += data.length;
    this.pump();
    return true;
  }

  /** Discards queued input and writes nothing more; the fd is about to close. */
  stop(): void {
    this.stopped = true;
    this.queue.length = 0;
    this.unaccepted = 0;
  }

  private pump(): void {
    const chunk = this.queue[0];
    if (this.writing || this.stopped || chunk === undefined) return;
    this.writing = true;
    write(this.fd, chunk, 0, chunk.length, null, (error, written) => {
      this.writing = false;
      if (this.stopped) return;
      if (error !== null) {
        // Any error but EAGAIN means the PTY is gone; its input is discarded like input to an exited terminal.
        if (!isAgain(error)) this.stop();
        else {
          setTimeout(() => {
            this.pump();
          }, RETRY_MS);
        }
        return;
      }
      this.unaccepted -= written;
      if (written === chunk.length) this.queue.shift();
      else this.queue[0] = chunk.subarray(written);
      this.pump();
    });
  }
}
