import { beforeEach, describe, expect, it } from 'vitest';
import { Attention, GRACE_MS, IDLE_AFTER_MS, isFocusOnly, isNotification, type AttentionClock, type AttentionState } from './attention.js';

interface Timer {
  fn: () => void;
  at: number;
}

/** A manual clock: time moves only by `advanceTo`, which fires due timers in order. */
class FakeClock implements AttentionClock {
  current = 0;
  readonly timers = new Map<number, Timer>();
  /** Delay of every setTimeout call, in order. */
  readonly scheduled: number[] = [];
  /** Calls of clearTimeout that cancelled a pending timer. */
  cancelled = 0;
  private nextId = 1;

  now = (): number => this.current;

  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = this.nextId++;
    this.timers.set(id, { fn, at: this.current + ms });
    this.scheduled.push(ms);
    return id;
  };

  clearTimeout = (handle: unknown): void => {
    if (typeof handle === 'number' && this.timers.delete(handle)) this.cancelled++;
  };

  /** Due times of the pending timers. */
  due(): number[] {
    return [...this.timers.values()].map((t) => t.at);
  }

  advanceTo(time: number): void {
    for (let fired = 0; ; fired++) {
      if (fired > 1000) throw new Error('timers keep re-arming without time passing');
      const next = [...this.timers.entries()].filter(([, t]) => t.at <= time).sort(([, x], [, y]) => x.at - y.at)[0];
      if (next === undefined) break;
      const [id, timer] = next;
      this.timers.delete(id);
      this.current = Math.max(this.current, timer.at);
      timer.fn();
    }
    this.current = time;
  }
}

const encoder = new TextEncoder();
const bytes = (text: string): Uint8Array => encoder.encode(text);

const FOCUS_IN = '\x1b[I';
const FOCUS_OUT = '\x1b[O';

let clock: FakeClock;
let changes: AttentionState[];
let attention: Attention;

beforeEach(() => {
  clock = new FakeClock();
  changes = [];
  attention = new Attention(clock, (state) => {
    changes.push(state);
  });
});

/** An output chunk received at `t`. */
const output = (t: number): void => {
  clock.advanceTo(t);
  attention.output(t);
};

/** An output chunk received at `t` that carries a bell. */
const bell = (t: number): void => {
  output(t);
  attention.bell(t);
};

/** An output chunk received at `t` that carries an OSC notification. */
const notify = (t: number): void => {
  output(t);
  attention.notify(t);
};

/** An input frame received at `t`. */
const input = (t: number, text: string): void => {
  clock.advanceTo(t);
  attention.input(t, bytes(text));
};

/** Moves the terminal to `input` with a bell at `t`. */
const signalled = (t: number): void => {
  bell(t);
  expect(attention.state).toBe('input');
};

describe('constants', () => {
  it('goes idle after 3 s and grants a 1 s grace', () => {
    expect(IDLE_AFTER_MS).toBe(3000);
    expect(GRACE_MS).toBe(1000);
  });
});

describe('working and idle', () => {
  it('starts idle without reporting a change', () => {
    expect(attention.state).toBe('idle');
    expect(changes).toEqual([]);
  });

  it('becomes working on output', () => {
    output(100);
    expect(attention.state).toBe('working');
    expect(changes).toEqual(['working']);
  });

  it('becomes idle 3 s after the last output and not before', () => {
    output(0);
    clock.advanceTo(2999);
    expect(attention.state).toBe('working');
    clock.advanceTo(3001);
    expect(attention.state).toBe('idle');
    expect(changes).toEqual(['working', 'idle']);
  });

  it('measures the 3 s from the latest output', () => {
    output(0);
    output(2000);
    clock.advanceTo(4999);
    expect(attention.state).toBe('working');
    clock.advanceTo(5001);
    expect(attention.state).toBe('idle');
  });

  it('becomes working again on output after idle', () => {
    output(0);
    clock.advanceTo(4000);
    output(4000);
    expect(changes).toEqual(['working', 'idle', 'working']);
    clock.advanceTo(7001);
    expect(attention.state).toBe('idle');
  });

  it('re-arms an early deadline for the remainder only', () => {
    output(0);
    output(2000);
    clock.advanceTo(3000);
    expect(attention.state).toBe('working');
    expect(clock.due()).toEqual([5000]);
  });

  it('keeps one pending timer under sustained output and schedules no timer per output', () => {
    output(0);
    for (let t = 100; t <= 5000; t += 100) {
      output(t);
      expect(clock.timers.size).toBeLessThanOrEqual(1);
    }
    expect(clock.cancelled).toBe(0);
    expect(clock.scheduled.length).toBeLessThanOrEqual(2);
    clock.advanceTo(7999);
    expect(attention.state).toBe('working');
    clock.advanceTo(8001);
    expect(attention.state).toBe('idle');
    expect(clock.scheduled.length).toBeLessThanOrEqual(3);
    expect(changes).toEqual(['working', 'idle']);
  });

  it('reports repeated output while working once', () => {
    output(0);
    output(10);
    output(20);
    expect(changes).toEqual(['working']);
  });

  it('ignores input frames while working or idle', () => {
    input(0, 'ls\r');
    expect(attention.state).toBe('idle');
    output(100);
    input(200, 'y');
    expect(attention.state).toBe('working');
    expect(changes).toEqual(['working']);
  });
});

describe('signals', () => {
  it('sets input on a bell', () => {
    bell(500);
    expect(attention.state).toBe('input');
    expect(changes).toEqual(['working', 'input']);
  });

  it('sets input on a bell from idle', () => {
    output(0);
    clock.advanceTo(3001);
    expect(attention.state).toBe('idle');
    attention.bell(3001);
    expect(attention.state).toBe('input');
  });

  it('sets input on a notification', () => {
    notify(500);
    expect(attention.state).toBe('input');
  });

  it('reports repeated signals once', () => {
    bell(0);
    bell(100);
    notify(200);
    expect(changes).toEqual(['working', 'input']);
  });

  it('ignores a bell within 1 s after an input frame and honours one after', () => {
    input(1000, '\t');
    bell(1999);
    expect(attention.state).toBe('working');
    bell(2001);
    expect(attention.state).toBe('input');
  });

  it('ignores a bell answering a key that cleared input', () => {
    signalled(0);
    input(5000, '\t');
    expect(attention.state).toBe('working');
    bell(5200);
    expect(attention.state).toBe('working');
  });

  it('does not let input suppress a notification', () => {
    input(1000, 'x');
    notify(1200);
    expect(attention.state).toBe('input');
  });

  it.each([
    ['focus-in', FOCUS_IN],
    ['focus-out', FOCUS_OUT],
    ['repeated focus reports', FOCUS_OUT + FOCUS_IN + FOCUS_OUT + FOCUS_IN],
  ])('does not let a frame of %s suppress a bell', (_name, frame) => {
    input(1000, frame);
    bell(1200);
    expect(attention.state).toBe('input');
  });

  it('lets a frame mixing focus reports with text suppress a bell', () => {
    input(1000, `a${FOCUS_IN}`);
    bell(1200);
    expect(attention.state).toBe('working');
  });

  it('stays input when the idle deadline passes', () => {
    output(0);
    bell(100);
    clock.advanceTo(10_000);
    expect(attention.state).toBe('input');
    expect(changes).toEqual(['working', 'input']);
  });
});

describe('leaving input', () => {
  it('becomes working on a typed key', () => {
    signalled(0);
    input(200, 'y');
    expect(attention.state).toBe('working');
    expect(changes).toEqual(['working', 'input', 'working']);
  });

  it.each([
    ['focus-in', FOCUS_IN],
    ['focus-out', FOCUS_OUT],
    ['repeated focus reports', FOCUS_OUT + FOCUS_IN + FOCUS_OUT + FOCUS_IN],
  ])('stays input on a frame of %s', (_name, frame) => {
    signalled(0);
    input(3000, frame);
    expect(attention.state).toBe('input');
    expect(changes).toEqual(['working', 'input']);
  });

  it('becomes working on a frame mixing focus reports with text', () => {
    signalled(0);
    input(3000, `x${FOCUS_OUT}`);
    expect(attention.state).toBe('working');
  });

  it('keeps input on output 0.5 s after the signal', () => {
    signalled(0);
    output(500);
    expect(attention.state).toBe('input');
  });

  it('becomes working on output 1.5 s after the signal', () => {
    signalled(0);
    output(1500);
    expect(attention.state).toBe('working');
    expect(changes).toEqual(['working', 'input', 'working']);
  });

  it('measures the grace from the latest signal', () => {
    signalled(0);
    bell(900);
    output(1500);
    expect(attention.state).toBe('input');
    output(1901);
    expect(attention.state).toBe('working');
  });

  it('keeps input on output within 1 s after a focus-only frame, even long after the signal', () => {
    signalled(0);
    input(5000, FOCUS_IN);
    output(5001);
    expect(attention.state).toBe('input');
    output(5999);
    expect(attention.state).toBe('input');
  });

  it('becomes working on output more than 1 s after both the signal and the focus-only frame', () => {
    signalled(0);
    input(300, FOCUS_IN);
    output(1301);
    expect(attention.state).toBe('working');
  });

  it('becomes working on output more than 1 s after a reply to a focus report', () => {
    signalled(0);
    input(5000, FOCUS_IN);
    output(5001);
    output(6001);
    expect(attention.state).toBe('working');
  });

  it('goes idle 3 s after the output that left input', () => {
    output(0);
    bell(100);
    output(1500);
    clock.advanceTo(4499);
    expect(attention.state).toBe('working');
    clock.advanceTo(4501);
    expect(attention.state).toBe('idle');
  });

  it('goes idle within 3 s after a typed key when no output follows', () => {
    signalled(0);
    input(10_000, 'y');
    clock.advanceTo(13_001);
    expect(attention.state).toBe('idle');
  });

  it('goes idle 3 s after the echo of a typed key', () => {
    signalled(0);
    input(10_000, 'y');
    output(10_050);
    clock.advanceTo(13_049);
    expect(attention.state).toBe('working');
    clock.advanceTo(13_051);
    expect(attention.state).toBe('idle');
  });
});

describe.each([
  [
    'exit',
    (): void => {
      attention.exit();
    },
  ],
  [
    'dispose',
    (): void => {
      attention.dispose();
    },
  ],
])('after %s', (_name, end) => {
  it('cancels the pending deadline and keeps the state', () => {
    output(0);
    expect(clock.timers.size).toBe(1);
    end();
    expect(clock.timers.size).toBe(0);
    clock.advanceTo(10_000);
    expect(attention.state).toBe('working');
    expect(changes).toEqual(['working']);
  });

  it('ignores a deadline callback that was already queued', () => {
    output(0);
    const timer = [...clock.timers.values()][0];
    if (timer === undefined) throw new Error('no pending deadline');
    end();
    clock.current = 5000;
    timer.fn();
    expect(attention.state).toBe('working');
    expect(changes).toEqual(['working']);
  });

  it('ignores later output, signals and input', () => {
    output(0);
    clock.advanceTo(3001);
    end();
    output(4000);
    bell(4100);
    notify(4200);
    input(4300, 'y');
    clock.advanceTo(10_000);
    expect(attention.state).toBe('idle');
    expect(changes).toEqual(['working', 'idle']);
  });

  it('keeps input whatever follows', () => {
    signalled(0);
    end();
    input(100, 'y');
    output(5000);
    clock.advanceTo(10_000);
    expect(attention.state).toBe('input');
    expect(changes).toEqual(['working', 'input']);
  });
});

describe('isFocusOnly', () => {
  it.each([
    ['focus-in', FOCUS_IN],
    ['focus-out', FOCUS_OUT],
    ['out then in', FOCUS_OUT + FOCUS_IN],
    ['repeated', FOCUS_OUT + FOCUS_IN + FOCUS_OUT + FOCUS_IN + FOCUS_IN],
  ])('accepts %s', (_name, frame) => {
    expect(isFocusOnly(bytes(frame))).toBe(true);
  });

  it.each([
    ['an empty frame', ''],
    ['text', 'y'],
    ['text before a report', `a${FOCUS_IN}`],
    ['text after a report', `${FOCUS_OUT}a`],
    ['a lone ESC', '\x1b'],
    ['a truncated report', '\x1b['],
    ['a report and a truncated one', `${FOCUS_IN}\x1b[`],
    ['an arrow key', '\x1b[A'],
    ['a tab', '\t'],
  ])('rejects %s', (_name, frame) => {
    expect(isFocusOnly(bytes(frame))).toBe(false);
  });
});

describe('isNotification', () => {
  it.each([
    [9, 'done', true],
    [9, 'build finished; all green', true],
    [9, '4;1;50', false],
    [9, '12;x', false],
    [777, 'notify;t;b', true],
    [777, 'notify;title;', true],
    [777, 'other;x', false],
    [777, 'notify', false],
    [99, ';hi', true],
    [99, 'i=1:d=0;hello', true],
    [99, '', true],
  ] as const)('OSC %i %j is a notification: %s', (osc, payload, expected) => {
    expect(isNotification(osc, payload)).toBe(expected);
  });
});
