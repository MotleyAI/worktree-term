import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AttentionState } from './attention.js';
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

describe('attention signals in the output', () => {
  /** Consumer id used to wait for the mirror. */
  const PROBE = 99;

  let home: string;
  let terms: TerminalProcess[];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'wtd-attention-'));
    terms = [];
  });

  afterEach(async () => {
    await Promise.all(terms.map((t) => t.close()));
    rmSync(home, { recursive: true, force: true });
  });

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  const waitUntil = async (probe: () => boolean, what: string, timeout = 3000): Promise<void> => {
    const deadline = Date.now() + timeout;
    while (!probe()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await sleep(20);
    }
  };

  /** Starts `command` hidden, recording every activity event as `[unseen, state]`. */
  const run = async (command: string): Promise<{ term: TerminalProcess; events: [boolean, AttentionState][]; exited: Promise<void> }> => {
    const events: [boolean, AttentionState][] = [];
    let exitedNow = (): void => undefined;
    const exited = new Promise<void>((resolve) => {
      exitedNow = resolve;
    });
    const term = await TerminalProcess.spawn(
      { cwd: home, command, cols: 80, rows: 24, env: { ...process.env, HOME: home, SHELL: '/bin/bash' } },
      {
        activity: (unseen, state) => {
          events.push([unseen, state]);
        },
        exited: () => {
          exitedNow();
        },
      },
    );
    terms.push(term);
    return { term, events, exited };
  };

  /** Waits until the mirror has parsed output containing `marker`. */
  const parsedUpTo = async (term: TerminalProcess, marker: string): Promise<void> => {
    const deadline = Date.now() + 3000;
    for (;;) {
      const screen = await new Promise<string>((resolve) => {
        term.attach(PROBE, {
          snapshot: (_offset, data) => {
            resolve(Buffer.from(data).toString());
          },
          output: () => undefined,
          superseded: () => undefined,
          lagging: () => undefined,
        });
      });
      term.detach(PROBE);
      if (screen.includes(marker)) return;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${marker} in the mirror`);
      await sleep(20);
    }
  };

  it.each([
    ['a bell', String.raw`printf '\a'`],
    ['OSC 9 done', String.raw`printf '\033]9;done\a'`],
    ['OSC 777 notify', String.raw`printf '\033]777;notify;t;b\a'`],
    ['OSC 99', String.raw`printf '\033]99;;hi\033\\'`],
  ])('sets input on %s while hidden', async (_name, print) => {
    const { term, events } = await run(`${print}; exec sleep 60`);
    await waitUntil(() => term.state === 'input', 'state input');
    expect(events.at(-1)).toEqual([true, 'input']);
  });

  it.each([
    ['an OSC 9 progress report', String.raw`printf '\033]9;4;1;50\a'`],
    ['a BEL terminating a title OSC', String.raw`printf '\033]0;title\a'`],
    ['an OSC 777 other than notify', String.raw`printf '\033]777;other;x\a'`],
  ])('does not set input on %s', async (_name, print) => {
    const { term, events } = await run(`${print}; printf END-MARK; exec sleep 60`);
    await parsedUpTo(term, 'END-MARK');
    expect(term.state).toBe('working');
    expect(events.filter(([, state]) => state === 'input')).toEqual([]);
  });

  it('sets input once for an OSC 777 notification split across two writes', async () => {
    const { term, events } = await run(String.raw`printf '\033]777;noti'; sleep 0.2; printf 'fy;t;b\a'; printf END-MARK; exec sleep 60`);
    await parsedUpTo(term, 'END-MARK');
    expect(term.state).toBe('input');
    expect(events.filter(([, state]) => state === 'input')).toEqual([[true, 'input']]);
  });

  it('sets input once for an OSC 777 notification split inside a multi-byte character of its payload', async () => {
    // 'é' is \303\251 in UTF-8; the writes split between its two bytes.
    const { term, events } = await run(
      String.raw`printf '\033]777;notify;t;h\303'; sleep 0.2; printf '\251llo\a'; printf END-MARK; exec sleep 60`,
    );
    await parsedUpTo(term, 'END-MARK');
    expect(term.state).toBe('input');
    expect(events.filter(([, state]) => state === 'input')).toEqual([[true, 'input']]);
  });

  it('sets unseen when the process exits while hidden without further output', async () => {
    const { term, events, exited } = await run('exec sleep 1');
    term.setVisible(true);
    await sleep(500);
    term.setVisible(false);
    const before = events.length;
    await exited;
    await waitUntil(() => term.unseen, 'unseen', 2000);
    expect(events.slice(before)).toEqual([[true, term.state]]);
  });
});
