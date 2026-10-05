import { beforeEach, describe, expect, it } from 'vitest';
import { FLOW_HIGH, FLOW_LOW, LAG_EVICT_MS } from '../../protocol/index.js';
import { FlowControl } from './flow.js';

const A = 1;
const B = 2;

let now: number;
let flow: FlowControl;

beforeEach(() => {
  now = 1000;
  flow = new FlowControl(() => now);
});

/** The PTY produces `bytes`, the mirror parses them, and every consumer is sent them. */
const produce = (bytes: number, ...consumers: number[]): void => {
  flow.output(bytes);
  flow.parsed(bytes);
  for (const consumer of consumers) flow.sent(consumer, flow.produced);
};

describe('offsets', () => {
  it('starts at offset 0, unpaused', () => {
    expect(flow.produced).toBe(0);
    expect(flow.paused).toBe(false);
  });

  it('counts produced output bytes', () => {
    produce(10);
    produce(5);
    expect(flow.produced).toBe(15);
  });

  it('attaches a consumer at the current output position', () => {
    produce(4096);
    expect(flow.attach(A)).toBe(4096);
  });
});

describe('without consumers', () => {
  it('does not pause while the mirror keeps up', () => {
    produce(4 * FLOW_HIGH);
    expect(flow.paused).toBe(false);
  });

  it('pauses when the mirror falls more than FLOW_HIGH behind', () => {
    flow.output(FLOW_HIGH);
    expect(flow.paused).toBe(false);
    flow.output(1);
    expect(flow.paused).toBe(true);
  });

  it('resumes only once the mirror is below FLOW_LOW', () => {
    flow.output(FLOW_HIGH + 1);
    flow.parsed(FLOW_HIGH + 1 - FLOW_LOW);
    expect(flow.paused).toBe(true);
    flow.parsed(1);
    expect(flow.paused).toBe(false);
  });

  it('never evicts the mirror', () => {
    flow.output(FLOW_HIGH + 1);
    now += 10 * LAG_EVICT_MS;
    expect(flow.lagging()).toEqual([]);
    expect(flow.paused).toBe(true);
  });
});

describe('consumer watermarks', () => {
  it('pauses when a consumer has more than FLOW_HIGH unacked', () => {
    flow.attach(A);
    produce(FLOW_HIGH, A);
    expect(flow.paused).toBe(false);
    produce(1, A);
    expect(flow.paused).toBe(true);
  });

  it('counts output produced for a consumer but not yet sent to it', () => {
    flow.attach(A);
    flow.output(FLOW_HIGH + 1);
    flow.parsed(FLOW_HIGH + 1);
    expect(flow.paused).toBe(true);
  });

  it('resumes only when the consumer is below FLOW_LOW', () => {
    flow.attach(A);
    produce(FLOW_HIGH + 1, A);
    expect(flow.ack(A, flow.produced - FLOW_LOW)).toBe('ok');
    expect(flow.paused).toBe(true);
    expect(flow.ack(A, flow.produced - FLOW_LOW + 1)).toBe('ok');
    expect(flow.paused).toBe(false);
  });

  it('stays running up to FLOW_HIGH again after resuming', () => {
    flow.attach(A);
    produce(FLOW_HIGH + 1, A);
    flow.ack(A, flow.produced);
    produce(FLOW_HIGH, A);
    expect(flow.paused).toBe(false);
  });

  it('stays paused while any consumer is not below FLOW_LOW', () => {
    flow.attach(A);
    flow.attach(B);
    produce(FLOW_HIGH + 1, A, B);
    flow.ack(B, flow.produced);
    expect(flow.paused).toBe(true);
    flow.ack(A, flow.produced);
    expect(flow.paused).toBe(false);
  });

  it('stays paused while the mirror is behind even when consumers caught up', () => {
    flow.attach(A);
    flow.output(FLOW_HIGH + 1);
    flow.sent(A, flow.produced);
    flow.ack(A, flow.produced);
    expect(flow.paused).toBe(true);
    flow.parsed(FLOW_HIGH + 1);
    expect(flow.paused).toBe(false);
  });

  it('does not count output from before the attach', () => {
    produce(10 * FLOW_HIGH);
    flow.attach(A);
    expect(flow.paused).toBe(false);
    produce(FLOW_HIGH, A);
    expect(flow.paused).toBe(false);
  });

  it('resumes when a lagging consumer detaches', () => {
    flow.attach(A);
    produce(FLOW_HIGH + 1, A);
    flow.detach(A);
    expect(flow.paused).toBe(false);
  });

  it('restarts the count when a consumer re-attaches', () => {
    flow.attach(A);
    produce(FLOW_HIGH + 1, A);
    expect(flow.attach(A)).toBe(flow.produced);
    expect(flow.paused).toBe(false);
  });
});

describe('acks', () => {
  beforeEach(() => {
    flow.attach(A);
    produce(1000, A);
  });

  it('accepts an ack up to the bytes sent', () => {
    expect(flow.ack(A, 600)).toBe('ok');
    expect(flow.ack(A, 1000)).toBe('ok');
  });

  it('ignores an ack at or below the current ack position', () => {
    flow.ack(A, 600);
    expect(flow.ack(A, 600)).toBe('stale');
    expect(flow.ack(A, 10)).toBe('stale');
  });

  it('rejects an ack beyond the bytes sent', () => {
    expect(flow.ack(A, 1001)).toBe('beyond');
  });

  it('rejects an ack of output produced but not yet sent', () => {
    flow.output(500);
    expect(flow.ack(A, 1200)).toBe('beyond');
  });

  it('rejects an ack below the attach position as stale', () => {
    flow.attach(B);
    produce(100, A, B);
    expect(flow.ack(B, 500)).toBe('stale');
    expect(flow.ack(B, 1100)).toBe('ok');
  });

  it('rejects an ack from a consumer that is not attached', () => {
    expect(flow.ack(B, 1)).toBe('beyond');
  });
});

describe('lag eviction', () => {
  it('evicts a consumer at or above FLOW_LOW after LAG_EVICT_MS of pause', () => {
    flow.attach(A);
    produce(FLOW_HIGH + 1, A);
    expect(flow.nextEviction()).toBe(now + LAG_EVICT_MS);
    now += LAG_EVICT_MS - 1;
    expect(flow.lagging()).toEqual([]);
    now += 1;
    expect(flow.lagging()).toEqual([A]);
  });

  it('does not evict a consumer that drops below FLOW_LOW while another keeps the PTY paused', () => {
    flow.attach(A);
    flow.attach(B);
    produce(FLOW_HIGH + 1, A, B);
    flow.ack(B, flow.produced - FLOW_LOW + 1);
    now += LAG_EVICT_MS;
    expect(flow.lagging()).toEqual([A]);
  });

  it('evicts a consumer at FLOW_LOW while the mirror keeps the PTY paused', () => {
    flow.attach(A);
    flow.output(FLOW_HIGH + 1);
    flow.sent(A, flow.produced);
    flow.ack(A, flow.produced - FLOW_LOW);
    now += LAG_EVICT_MS;
    expect(flow.lagging()).toEqual([A]);
  });

  it('never evicts while the PTY runs', () => {
    flow.attach(A);
    produce(FLOW_HIGH, A);
    now += 10 * LAG_EVICT_MS;
    expect(flow.paused).toBe(false);
    expect(flow.lagging()).toEqual([]);
    expect(flow.nextEviction()).toBeNull();
  });

  it('restarts the lag clock after the consumer recovers', () => {
    flow.attach(A);
    produce(FLOW_HIGH + 1, A);
    now += LAG_EVICT_MS - 100;
    flow.ack(A, flow.produced);
    expect(flow.paused).toBe(false);
    produce(FLOW_HIGH + 1, A);
    now += LAG_EVICT_MS - 1;
    expect(flow.lagging()).toEqual([]);
    now += 1;
    expect(flow.lagging()).toEqual([A]);
  });

  it('forgets a detached consumer', () => {
    flow.attach(A);
    produce(FLOW_HIGH + 1, A);
    flow.detach(A);
    now += LAG_EVICT_MS;
    expect(flow.lagging()).toEqual([]);
    expect(flow.nextEviction()).toBeNull();
  });
});
