import { spawn, type ChildProcess } from 'node:child_process';
import { cpus, tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { TerminalProcess } from './terminal.js';

const MiB = 1024 * 1024;
const TERMINALS = 12;

const countX = (data: Uint8Array): number => data.filter((b) => b === 0x78).length;

/** Output bytes a terminal running `command` delivers to an attached, slowly acking consumer before it reports its exit. */
const deliveredBeforeExit = async (command: string): Promise<number> => {
  let delivered = 0;
  let acked = 0;
  let exited = (): void => undefined;
  const exit = new Promise<void>((resolve) => {
    exited = resolve;
  });
  const term = await TerminalProcess.spawn(
    { cwd: tmpdir(), command, cols: 80, rows: 24, env: process.env },
    {
      activity: () => undefined,
      exited: () => {
        exited();
      },
    },
  );
  term.attach(1, {
    snapshot: () => undefined,
    output: (offset, data) => {
      delivered += countX(data);
      const end = offset + data.length;
      setTimeout(() => {
        if (end <= acked) return;
        acked = end;
        term.ack(1, end);
      }, Math.random() * 30);
    },
    superseded: () => undefined,
    lagging: () => undefined,
  });
  await exit;
  const total = delivered;
  await term.close();
  return total;
};

it('delivers the whole final burst of processes exiting under CPU load before reporting their exit', async () => {
  // Under load Linux reports the end of a PTY's output while its tail is still in transit.
  const hogs: ChildProcess[] = cpus().map(() => spawn('sh', ['-c', 'while :; do :; done'], { stdio: 'ignore' }));
  try {
    const command = "head -c 1048576 /dev/zero | tr '\\0' x; exit 0";
    const delivered = await Promise.all(Array.from({ length: TERMINALS }, () => deliveredBeforeExit(command)));
    expect(delivered).toEqual(Array.from({ length: TERMINALS }, () => MiB));
  } finally {
    for (const hog of hogs) hog.kill('SIGKILL');
  }
}, 60_000);
