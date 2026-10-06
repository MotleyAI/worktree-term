import { ACK_EVERY } from '../client/index.js';

/** Output handed to the terminal, to report once it has been processed. */
export interface PendingWrite {
  generation: number;
  /** Output offset at the end of this write. */
  end: number;
}

/** Acknowledgement accounting of one terminal across attaches (design D11). */
export class AckTracker {
  private gen = 0;
  private next = 0;
  private consumed = 0;
  private lastAcked = 0;
  private maxAcked = -1;
  private queued = 0;

  constructor(private readonly ack: (offset: number) => void) {}

  get generation(): number {
    return this.gen;
  }

  /** The offset the next output must start at. */
  get expected(): number {
    return this.next;
  }

  /** A snapshot at `offset` starts a new attach; its bytes are not acknowledged. */
  attach(offset: number): void {
    this.gen++;
    this.next = offset;
    this.consumed = offset;
    this.lastAcked = offset;
    this.queued = 0;
  }

  /** Accounts output at `offset`; null when it does not continue the expected offset. */
  output(offset: number, data: Uint8Array): PendingWrite | null {
    if (offset !== this.next) return null;
    this.next += data.length;
    this.queued++;
    return { generation: this.gen, end: this.next };
  }

  /** The terminal has processed `write`. */
  written(write: PendingWrite): void {
    if (write.generation !== this.gen) return;
    this.consumed = write.end;
    this.queued--;
    if ((this.consumed - this.lastAcked >= ACK_EVERY || this.queued === 0) && this.consumed > this.maxAcked) {
      this.lastAcked = this.consumed;
      this.maxAcked = this.consumed;
      this.ack(this.consumed);
    }
  }
}
