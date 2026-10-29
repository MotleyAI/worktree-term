import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logWriter, sampleIntervalMs, startSampler, type MemorySampler } from './index.js';

const MINUTE = 60_000;

describe('sampling cadence', () => {
  let tight: boolean;
  let takes: number[];
  let checks: number[];
  let lines: string[];
  let reported: unknown[];
  let sampler: MemorySampler | null;
  /** Replaces the next take, when set. */
  let nextTake: (() => Promise<unknown>) | null;
  /** Replaces the next write, when set. */
  let nextWrite: (() => Promise<void>) | null;
  let running: number;
  let mostRunning: number;
  /** Fails the next check, when set. */
  let failCheck: Error | null;

  const start = (intervalMs = MINUTE): void => {
    sampler = startSampler({
      intervalMs,
      tight: async () => {
        checks.push(Date.now());
        running++;
        mostRunning = Math.max(mostRunning, running);
        await Promise.resolve();
        running--;
        const failure = failCheck;
        failCheck = null;
        if (failure !== null) throw failure;
        return tight;
      },
      take: async () => {
        takes.push(Date.now());
        running++;
        mostRunning = Math.max(mostRunning, running);
        try {
          const replaced = nextTake;
          nextTake = null;
          return replaced === null ? { n: takes.length } : await replaced();
        } finally {
          running--;
        }
      },
      write: (line) => {
        const replaced = nextWrite;
        nextWrite = null;
        if (replaced !== null) return replaced();
        lines.push(line);
        return Promise.resolve();
      },
      report: (error) => {
        reported.push(error);
      },
    });
  };

  /** Advances the fake clock to `ms`. */
  const at = async (ms: number): Promise<void> => {
    await vi.advanceTimersByTimeAsync(ms - Date.now());
  };

  beforeEach(() => {
    vi.useFakeTimers({ now: 0 });
    tight = false;
    takes = [];
    checks = [];
    lines = [];
    reported = [];
    sampler = null;
    nextTake = null;
    nextWrite = null;
    running = 0;
    mostRunning = 0;
    failCheck = null;
  });

  afterEach(() => {
    sampler?.stop();
    vi.useRealTimers();
  });

  it('samples at start and then every 60 s while memory is calm, writing each sample as a JSON line', async () => {
    start();
    await at(3 * MINUTE + 1000);
    expect(takes).toEqual([0, MINUTE, 2 * MINUTE, 3 * MINUTE]);
    expect(lines).toEqual(['{"n":1}', '{"n":2}', '{"n":3}', '{"n":4}']);
    expect(reported).toEqual([]);
  });

  it('checks memory every 5 s between samples', async () => {
    start();
    await at(MINUTE - 1000);
    expect(checks).toEqual([5000, 10_000, 15_000, 20_000, 25_000, 30_000, 35_000, 40_000, 45_000, 50_000, 55_000]);
  });

  it('samples within 5 s once memory is tight, every 5 s while it stays tight, and 60 s after the last sample once calm', async () => {
    start();
    await at(32_500);
    tight = true;
    await at(50_000);
    expect(takes).toEqual([0, 35_000, 40_000, 45_000, 50_000]);
    tight = false;
    await at(115_000);
    expect(takes).toEqual([0, 35_000, 40_000, 45_000, 50_000, 50_000 + MINUTE]);
  });

  it('checks and samples at the base interval when it is shorter than 5 s, tight or not', async () => {
    tight = true;
    start(1000);
    await at(3500);
    expect(takes).toEqual([0, 1000, 2000, 3000]);
  });

  it('starts no check or sample before a slow sample finished', async () => {
    tight = true;
    start();
    await at(4000);
    nextTake = () =>
      new Promise((resolve) => {
        setTimeout(() => {
          resolve({ slow: true });
        }, 12_000);
      });
    await at(23_000);
    expect(takes).toEqual([0, 5000, 22_000]);
    expect(checks.filter((t) => t > 5000 && t < 17_000)).toEqual([]);
    expect(mostRunning).toBe(1);
    expect(lines).toContain('{"slow":true}');
  });

  it('writes nothing once stopped, not even the sample being taken', async () => {
    let finish = (): void => undefined;
    nextTake = () =>
      new Promise((resolve) => {
        finish = () => {
          resolve({ late: true });
        };
      });
    start();
    await at(0);
    expect(takes).toEqual([0]);
    sampler?.stop();
    finish();
    await at(10 * MINUTE);
    expect(takes).toEqual([0]);
    expect(checks).toEqual([]);
    expect(lines).toEqual([]);
  });

  it('reports a failed write and takes the next sample', async () => {
    const failure = new Error('disk full');
    nextWrite = () => Promise.reject(failure);
    start();
    await at(MINUTE + 1000);
    expect(reported).toEqual([failure]);
    expect(takes).toEqual([0, MINUTE]);
    expect(lines).toEqual(['{"n":2}']);
  });

  it('reports a failed sample and takes the next one', async () => {
    const failure = new Error('no proc');
    nextTake = () => Promise.reject(failure);
    start();
    await at(MINUTE + 1000);
    expect(reported).toEqual([failure]);
    expect(lines).toEqual(['{"n":2}']);
  });

  it('reports a failed check, counting memory as calm, and keeps checking', async () => {
    const failure = new Error('no pressure');
    failCheck = failure;
    tight = true;
    start();
    await at(12_000);
    expect(reported).toEqual([failure]);
    expect(takes).toEqual([0, 10_000]);
  });
});

describe('sampler timers', () => {
  it('never keep the process alive', async () => {
    const timers: NodeJS.Timeout[] = [];
    const real = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn: () => void, ms?: number) => {
      const timer = real(fn, ms);
      timers.push(timer);
      return timer;
    });
    const sampler = startSampler({
      intervalMs: 20,
      tight: () => Promise.resolve(false),
      take: () => Promise.resolve({}),
      write: () => Promise.resolve(),
      report: () => undefined,
    });
    try {
      await new Promise((resolve) => real(resolve, 200));
    } finally {
      sampler.stop();
      spy.mockRestore();
    }
    expect(timers.length).toBeGreaterThanOrEqual(3);
    expect(timers.filter((t) => t.hasRef())).toEqual([]);
  });
});

describe('base interval', () => {
  it.each([
    [undefined, MINUTE],
    ['250', 250],
    ['1', 1],
    ['0', MINUTE],
    ['-5', MINUTE],
    ['1.5', MINUTE],
    ['9'.repeat(400), MINUTE],
    ['9007199254740993', MINUTE],
    ['abc', MINUTE],
    ['', MINUTE],
  ])('WTD_MEMORY_SAMPLE_MS %j gives %d ms', (value, ms) => {
    expect(sampleIntervalMs(value)).toBe(ms);
  });
});

describe('log writer', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wtd-memory-log-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('appends lines to an owner-only rotating log', async () => {
    const path = join(dir, 'memory.log');
    const write = logWriter(path, () => undefined);
    await write('{"a":1}');
    await write('{"b":2}');
    expect(readFileSync(path, 'utf8')).toBe('{"a":1}\n{"b":2}\n');
    expect(statSync(path).mode & 0o077).toBe(0);
  });
});
