import { describe, expect, it } from 'vitest';
import { ACK_EVERY } from '../../protocol/index.js';
import { AckTracker, type PendingWrite } from './acks.js';

const KiB = 1024;
const bytes = (n: number): Uint8Array => new Uint8Array(n);

const tracker = (): { acks: number[]; acker: AckTracker } => {
  const acks: number[] = [];
  return { acks, acker: new AckTracker((offset) => acks.push(offset)) };
};

/** Accounts `data` at the expected offset; fails if it does not continue the stream. */
const write = (acker: AckTracker, data: Uint8Array): PendingWrite => {
  const pending = acker.output(acker.expected, data);
  if (pending === null) throw new Error('unexpected gap');
  return pending;
};

const at = <T>(items: readonly T[], index: number): T => {
  const item = items[index];
  if (item === undefined) throw new Error(`no item ${String(index)}`);
  return item;
};

const expectIncreasing = (acks: readonly number[]): void => {
  for (let i = 1; i < acks.length; i++) expect(acks[i]).toBeGreaterThan(acks[i - 1] ?? -1);
};

describe('AckTracker', () => {
  it('expects output from the snapshot offset and acknowledges no snapshot bytes', () => {
    const { acks, acker } = tracker();
    acker.attach(1000);
    expect(acker.expected).toBe(1000);
    expect(acks).toEqual([]);
  });

  it('acknowledges output below ACK_EVERY once the terminal has processed everything', () => {
    const { acks, acker } = tracker();
    acker.attach(100);
    acker.written(write(acker, bytes(10)));
    expect(acks).toEqual([110]);
  });

  it('counts output in bytes, not characters', () => {
    const { acks, acker } = tracker();
    acker.attach(0);
    const data = new TextEncoder().encode('é✓𝄞');
    expect(data.length).toBe(9);
    acker.written(write(acker, data));
    expect(acks).toEqual([9]);
    expect(acker.expected).toBe(9);
  });

  it('waits for queued frames below ACK_EVERY until the queue drains', () => {
    const { acks, acker } = tracker();
    acker.attach(0);
    const frames = [write(acker, bytes(20 * KiB)), write(acker, bytes(20 * KiB)), write(acker, bytes(20 * KiB))];
    acker.written(at(frames, 0));
    acker.written(at(frames, 1));
    expect(acks).toEqual([]);
    acker.written(at(frames, 2));
    expect(acks).toEqual([60 * KiB]);
  });

  it('acknowledges every ACK_EVERY processed bytes while frames are still queued', () => {
    const { acks, acker } = tracker();
    acker.attach(0);
    const frames = Array.from({ length: 4 }, () => write(acker, bytes(40 * KiB)));
    for (const frame of frames) acker.written(frame);
    expect(acks).toEqual([80 * KiB, 160 * KiB]);
    expect(80 * KiB).toBeGreaterThanOrEqual(ACK_EVERY);
  });

  it('acknowledges the end offset of what the terminal finished, not of what it received', () => {
    const { acks, acker } = tracker();
    acker.attach(0);
    const first = write(acker, bytes(ACK_EVERY));
    write(acker, bytes(ACK_EVERY));
    acker.written(first);
    expect(acks).toEqual([ACK_EVERY]);
  });

  it('ignores processing of an earlier attach', () => {
    const { acks, acker } = tracker();
    acker.attach(0);
    const stale = [write(acker, bytes(ACK_EVERY)), write(acker, bytes(10))];
    acker.attach(500 * KiB);
    for (const frame of stale) acker.written(frame);
    expect(acks).toEqual([]);
    acker.written(write(acker, bytes(10)));
    expect(acks).toEqual([500 * KiB + 10]);
  });

  it('does not acknowledge again a re-attach at the acknowledged offset before new output', () => {
    const { acks, acker } = tracker();
    acker.attach(0);
    acker.written(write(acker, bytes(10)));
    acker.attach(10);
    expect(acks).toEqual([10]);
    acker.written(write(acker, bytes(4)));
    expect(acks).toEqual([10, 14]);
  });

  it('keeps acknowledgements strictly increasing across attaches', () => {
    const { acks, acker } = tracker();
    acker.attach(0);
    const pending: PendingWrite[] = [];
    for (let i = 0; i < 50; i++) {
      pending.push(write(acker, bytes(7 * KiB + i)));
      const done = i % 3 === 0 ? pending.shift() : undefined;
      if (done !== undefined) acker.written(done);
      if (i === 20 || i === 35) acker.attach(acker.expected + 100);
    }
    for (const frame of pending) acker.written(frame);
    expect(acks.length).toBeGreaterThan(2);
    expectIncreasing(acks);
  });

  it('reports a gap when output does not continue the expected offset', () => {
    const { acks, acker } = tracker();
    acker.attach(100);
    expect(acker.output(90, bytes(10))).toBeNull();
    expect(acker.output(111, bytes(10))).toBeNull();
    expect(acks).toEqual([]);
    expect(acker.expected).toBe(100);
  });

  it('starts a new generation on every attach', () => {
    const { acker } = tracker();
    acker.attach(0);
    const first = acker.generation;
    acker.attach(0);
    expect(acker.generation).toBeGreaterThan(first);
  });
});
