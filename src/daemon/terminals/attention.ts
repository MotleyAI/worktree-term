import type { AttentionState } from '../../protocol/index.js';

export type { AttentionState } from '../../protocol/index.js';

/** Without output for this long, `working` becomes `idle`. */
export const IDLE_AFTER_MS = 3000;
/** Output or a bell this close after a signal or input frame is taken as belonging to it. */
export const GRACE_MS = 1000;

export interface AttentionClock<H = unknown> {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => H;
  clearTimeout: (handle: H) => void;
}

const ESC = 0x1b;
const CSI_OPEN = 0x5b;
const FOCUS_IN = 0x49;
const FOCUS_OUT = 0x4f;

/** Whether an input frame is non-empty and holds only focus reports (`ESC [ I`, `ESC [ O`). */
export const isFocusOnly = (data: Uint8Array): boolean => {
  if (data.length === 0 || data.length % 3 !== 0) return false;
  for (let i = 0; i < data.length; i += 3) {
    const final = data[i + 2];
    if (data[i] !== ESC || data[i + 1] !== CSI_OPEN || (final !== FOCUS_IN && final !== FOCUS_OUT)) return false;
  }
  return true;
};

/** Whether OSC `osc` with `payload` is a desktop notification. */
export const isNotification = (osc: number, payload: string): boolean => {
  switch (osc) {
    case 9:
      return !/^\d+;/.test(payload);
    case 777:
      return payload.startsWith('notify;');
    case 99:
      return true;
    default:
      return false;
  }
};

/** A terminal's attention state; all times are receipt times from the clock. */
export class Attention<H = unknown> {
  state: AttentionState = 'idle';
  /** Start of the current quiet period that the idle deadline measures. */
  private quietSince = -Infinity;
  private lastSignal = -Infinity;
  private lastInput = -Infinity;
  private lastFocus = -Infinity;
  private timer: { handle: H } | null = null;
  private ended = false;

  constructor(
    private readonly clock: AttentionClock<H>,
    private readonly changed: (state: AttentionState) => void,
  ) {}

  output(at: number): void {
    if (this.ended) return;
    this.quietSince = Math.max(this.quietSince, at);
    if (this.state === 'input' && (at - this.lastSignal <= GRACE_MS || at - this.lastFocus <= GRACE_MS)) return;
    this.set('working');
  }

  bell(at: number): void {
    const sinceInput = at - this.lastInput;
    if (sinceInput >= 0 && sinceInput <= GRACE_MS) return;
    this.signal(at);
  }

  notify(at: number): void {
    this.signal(at);
  }

  input(at: number, data: Uint8Array): void {
    if (this.ended) return;
    if (isFocusOnly(data)) {
      this.lastFocus = at;
      return;
    }
    this.lastInput = at;
    if (this.state !== 'input') return;
    this.quietSince = Math.max(this.quietSince, at);
    this.set('working');
  }

  /** The process exited: the state no longer changes. */
  exit(): void {
    this.dispose();
  }

  dispose(): void {
    this.ended = true;
    if (this.timer !== null) this.clock.clearTimeout(this.timer.handle);
    this.timer = null;
  }

  private signal(at: number): void {
    if (this.ended) return;
    this.lastSignal = Math.max(this.lastSignal, at);
    this.set('input');
  }

  private set(state: AttentionState): void {
    if (state === 'working') this.arm(this.quietSince + IDLE_AFTER_MS - this.clock.now());
    if (state === this.state) return;
    this.state = state;
    this.changed(state);
  }

  /** Arms the idle deadline unless one is pending; it re-arms itself for any remainder. */
  private arm(ms: number): void {
    if (this.timer !== null) return;
    const timer = {
      handle: this.clock.setTimeout(() => {
        if (this.timer !== timer || this.ended) return;
        this.timer = null;
        if (this.state !== 'working') return;
        const remaining = this.quietSince + IDLE_AFTER_MS - this.clock.now();
        if (remaining > 0) this.arm(remaining);
        else this.set('idle');
      }, Math.max(0, ms)),
    };
    this.timer = timer;
  }
}
