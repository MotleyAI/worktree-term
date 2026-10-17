import { CONTROL } from './tail.js';

const PHRASE = 'To authenticate, visit:';
const LOGIN_PREFIX = 'https://login.tailscale.com/';
const MAX_URL = 1024;
const MAX_LINE = 4096;
const NEWLINE = 0x0a;

/** The Tailscale SSH check login URL a standard error line gives, or null when it gives none. */
export const tailscaleLoginUrl = (line: string): string | null => {
  const text = line.replace(CONTROL, '');
  const at = text.indexOf(PHRASE);
  if (at < 0) return null;
  const [url = ''] = text
    .slice(at + PHRASE.length)
    .trim()
    .split(/\s/, 1);
  return url.startsWith(LOGIN_PREFIX) && url.length <= MAX_URL ? url : null;
};

/** Splits a byte stream into lines, holding at most the first 4 KiB of a line until its newline arrives. */
export class LineScanner {
  private held = new Uint8Array(0);
  private readonly decoder = new TextDecoder();

  get size(): number {
    return this.held.length;
  }

  /** The lines `chunk` completes, without their newlines. */
  push(chunk: Uint8Array): string[] {
    const lines: string[] = [];
    let start = 0;
    for (let end = chunk.indexOf(NEWLINE); end >= 0; end = chunk.indexOf(NEWLINE, start)) {
      this.hold(chunk.subarray(start, end));
      lines.push(this.decoder.decode(this.held));
      this.held = new Uint8Array(0);
      start = end + 1;
    }
    this.hold(chunk.subarray(start));
    return lines;
  }

  private hold(bytes: Uint8Array): void {
    const take = Math.min(bytes.length, MAX_LINE - this.held.length);
    if (take <= 0) return;
    const next = new Uint8Array(this.held.length + take);
    next.set(this.held, 0);
    next.set(bytes.subarray(0, take), this.held.length);
    this.held = next;
  }
}
