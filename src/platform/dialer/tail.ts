import type { Readable } from 'node:stream';

const MAX_TAIL = 4096;
const MAX_REASON = 1024;
/** Most standard error read from one process, so a flood cannot grow memory. */
const MAX_READ = 1024 * 1024;

// eslint-disable-next-line no-control-regex -- control characters are what a reason must not contain
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f]/g;

/** The last 4 KiB a process wrote to standard error, giving its last non-empty line. */
export class StderrTail {
  private bytes = new Uint8Array(0);

  get size(): number {
    return this.bytes.length;
  }

  /**
   * Feeds the tail from `stream`. Once 1 MiB has been read it closes the stream and calls `full`:
   * a writer left without a reader blocks, so the caller should end it.
   */
  follow(stream: Readable, full?: () => void): void {
    let read = 0;
    stream.on('data', (chunk: Buffer) => {
      if (stream.destroyed) return;
      read += chunk.length;
      this.push(chunk);
      if (read < MAX_READ) return;
      stream.destroy();
      full?.();
    });
  }

  push(chunk: Uint8Array): void {
    if (chunk.length >= MAX_TAIL) {
      this.bytes = chunk.slice(chunk.length - MAX_TAIL);
      return;
    }
    const keep = Math.min(this.bytes.length, MAX_TAIL - chunk.length);
    const next = new Uint8Array(keep + chunk.length);
    next.set(this.bytes.subarray(this.bytes.length - keep), 0);
    next.set(chunk, keep);
    this.bytes = next;
  }

  /** The last non-empty line without control characters, cut to 1024 characters; null when there is none. */
  reason(): string | null {
    const text = new TextDecoder().decode(this.bytes);
    const lines = text.split('\n').map((line) => line.replace(CONTROL, '').trim());
    const last = lines.findLast((line) => line !== '');
    return last === undefined ? null : last.slice(0, MAX_REASON);
  }
}
