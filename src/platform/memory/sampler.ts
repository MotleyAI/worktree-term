import { appendLogLine } from '../files/index.js';
import type { Report } from './sources.js';

const DEFAULT_INTERVAL_MS = 60_000;
const CHECK_MS = 5000;

export interface SamplerOptions {
  /** The base interval between samples. */
  intervalMs: number;
  /** Whether memory is tight, which samples at every check. */
  tight: () => Promise<boolean>;
  /** Takes a sample, written as one JSON line. */
  take: () => Promise<unknown>;
  write: (line: string) => Promise<void>;
  report: Report;
}

export interface MemorySampler {
  /** Cancels the next check and drops a sample in flight. */
  stop: () => void;
}

/** The base interval: `WTD_MEMORY_SAMPLE_MS` when a positive safe integer, else 60 s. */
export const sampleIntervalMs = (value: string | undefined): number => {
  const ms = value !== undefined && /^\d+$/.test(value) ? Number(value) : 0;
  return Number.isSafeInteger(ms) && ms > 0 ? ms : DEFAULT_INTERVAL_MS;
};

/** Appends lines to the rotating owner-only log at `path`. */
export const logWriter =
  (path: string, report: Report): ((line: string) => Promise<void>) =>
  (line) =>
    appendLogLine(path, line, report);

/**
 * Samples at start, then checks every 5 s (the base interval when shorter) and samples when the base
 * interval has passed or memory is tight. One check or sample runs at a time; timers are unref'd.
 */
export const startSampler = ({ intervalMs, tight, take, write, report }: SamplerOptions): MemorySampler => {
  const checkMs = Math.min(CHECK_MS, intervalMs);
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let lastSample = Date.now();

  const sample = async (): Promise<void> => {
    lastSample = Date.now();
    let line: string;
    try {
      line = JSON.stringify(await take());
    } catch (error) {
      if (!stopped) report(error);
      return;
    }
    if (stopped) return;
    try {
      await write(line);
    } catch (error) {
      report(error);
    }
  };

  const due = async (): Promise<boolean> => {
    if (Date.now() - lastSample >= intervalMs) return true;
    try {
      return await tight();
    } catch (error) {
      report(error);
      return false;
    }
  };

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = null;
      void check();
    }, checkMs);
    timer.unref();
  };

  const check = async (): Promise<void> => {
    if ((await due()) && !stopped) await sample();
    schedule();
  };

  void sample().then(schedule);
  return {
    stop: () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
    },
  };
};
