import { randomBytes } from 'node:crypto';

const CODE_TTL_MS = 30_000;
const MAX_OUTSTANDING = 16;

/** One-time codes: each valid for one use within 30 s; at most 16 outstanding. */
export class CodeStore {
  /** Issue time by code, oldest first. */
  private readonly codes = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  issue(): string {
    this.expire();
    for (const oldest of this.codes.keys()) {
      if (this.codes.size < MAX_OUTSTANDING) break;
      this.codes.delete(oldest);
    }
    const code = randomBytes(32).toString('hex');
    this.codes.set(code, this.now());
    return code;
  }

  /** Whether `code` is valid, without using it up. */
  valid(code: string): boolean {
    this.expire();
    return this.codes.has(code);
  }

  /** Whether `code` is valid; a valid code is used up. */
  consume(code: string): boolean {
    this.expire();
    return this.codes.delete(code);
  }

  private expire(): void {
    const now = this.now();
    for (const [code, issued] of this.codes) {
      if (now - issued > CODE_TTL_MS) this.codes.delete(code);
    }
  }
}
