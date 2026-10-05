import { FLOW_HIGH, FLOW_LOW, LAG_EVICT_MS } from '../../protocol/index.js';

interface Consumer {
  sent: number;
  acked: number;
  /** Since when this consumer has been at or above FLOW_LOW while paused. */
  laggingSince: number | null;
}

export type AckResult = 'ok' | 'stale' | 'beyond';

/** Output accounting of one terminal: offsets, pause with hysteresis, and lag eviction. No I/O. */
export class FlowControl {
  private producedBytes = 0;
  private parsedBytes = 0;
  private isPaused = false;
  private readonly consumers = new Map<number, Consumer>();

  constructor(private readonly now: () => number) {}

  /** Output bytes produced so far: the next output offset. */
  get produced(): number {
    return this.producedBytes;
  }

  /** Whether the PTY must be paused. */
  get paused(): boolean {
    return this.isPaused;
  }

  output(bytes: number): void {
    this.producedBytes += bytes;
    this.update();
  }

  /** The mirror processed `bytes` more output. */
  parsed(bytes: number): void {
    this.parsedBytes += bytes;
    this.update();
  }

  /** Output up to `offset` was handed to `consumer`'s connection. */
  sent(consumer: number, offset: number): void {
    const state = this.consumers.get(consumer);
    if (state !== undefined) state.sent = Math.max(state.sent, offset);
  }

  /** (Re-)attaches `consumer` at the current position, which it returns. */
  attach(consumer: number): number {
    const at = this.producedBytes;
    this.consumers.set(consumer, { sent: at, acked: at, laggingSince: null });
    this.update();
    return at;
  }

  detach(consumer: number): void {
    this.consumers.delete(consumer);
    this.update();
  }

  ack(consumer: number, offset: number): AckResult {
    const state = this.consumers.get(consumer);
    if (state === undefined || offset > state.sent) return 'beyond';
    if (offset <= state.acked) return 'stale';
    state.acked = offset;
    this.update();
    return 'ok';
  }

  /** Consumers due for eviction now. */
  lagging(): number[] {
    const due = this.now() - LAG_EVICT_MS;
    return [...this.consumers].filter(([, c]) => c.laggingSince !== null && c.laggingSince <= due).map(([id]) => id);
  }

  /** When the next eviction falls due, or null if none is pending. */
  nextEviction(): number | null {
    let next: number | null = null;
    for (const { laggingSince } of this.consumers.values()) {
      if (laggingSince !== null) next = Math.min(next ?? Infinity, laggingSince + LAG_EVICT_MS);
    }
    return next;
  }

  private update(): void {
    const backlogs = [this.producedBytes - this.parsedBytes, ...[...this.consumers.values()].map((c) => this.producedBytes - c.acked)];
    if (!this.isPaused && backlogs.some((b) => b > FLOW_HIGH)) this.isPaused = true;
    else if (this.isPaused && backlogs.every((b) => b < FLOW_LOW)) this.isPaused = false;
    const now = this.now();
    for (const consumer of this.consumers.values()) {
      const lagging = this.isPaused && this.producedBytes - consumer.acked >= FLOW_LOW;
      if (!lagging) consumer.laggingSince = null;
      else consumer.laggingSince ??= now;
    }
  }
}
