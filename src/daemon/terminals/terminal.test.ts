import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttentionState } from './attention.js';
import { TerminalProcess, type TerminalLauncher } from './terminal.js';

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
    { termId: 1, memory: {}, cwd: tmpdir(), command, cols: 80, rows: 24, env: process.env },
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
      { termId: 1, memory: {}, cwd: home, command, cols: 80, rows: 24, env: { ...process.env, HOME: home, SHELL: '/bin/bash' } },
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

  it('sets unseen when the process fails while hidden without further output', async () => {
    const { term, events, exited } = await run("exec sh -c 'sleep 1; exit 1'");
    term.setVisible(true);
    await sleep(500);
    term.setVisible(false);
    const before = events.length;
    await exited;
    await waitUntil(() => term.unseen, 'unseen', 2000);
    expect(events.slice(before)).toEqual([[true, term.state]]);
  });

  it('leaves unseen clear when the process exits cleanly while hidden without further output', async () => {
    const { term, events, exited } = await run('exec sleep 1');
    term.setVisible(true);
    await sleep(500);
    term.setVisible(false);
    const before = events.length;
    await exited;
    await sleep(200);
    expect(term.unseen).toBe(false);
    expect(events.slice(before)).toEqual([]);
  });
});

describe('process and mirror figures', () => {
  let home: string;
  let term: TerminalProcess | null;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'wtd-figures-'));
    term = null;
  });

  afterEach(async () => {
    await term?.close();
    rmSync(home, { recursive: true, force: true });
  });

  const run = async (command: string): Promise<TerminalProcess> => {
    term = await TerminalProcess.spawn(
      { termId: 1, memory: {}, cwd: home, command, cols: 80, rows: 24, env: { ...process.env, HOME: home, SHELL: '/bin/bash' } },
      { activity: () => undefined, exited: () => undefined },
    );
    return term;
  };

  it("gives the shell's pid", async () => {
    const started = await run('echo $$ > pid; exec sleep 60');
    const file = join(home, 'pid');
    await vi.waitFor(() => {
      expect(readFileSync(file, 'utf8')).toMatch(/\n$/);
    });
    expect(started.pid).toBe(Number(readFileSync(file, 'utf8')));
  });

  it('counts the lines of the normal and the alternate buffer, and the columns', async () => {
    const started = await run(String.raw`seq 1 300; read -r _; printf '\033[?1049hALT'; exec sleep 60`);
    await vi.waitFor(() => {
      expect(started.mirrorStats().lines).toBeGreaterThanOrEqual(300);
    });
    const normal = started.mirrorStats().lines;
    expect(started.mirrorStats().cols).toBe(80);
    started.write(Buffer.from('\r'));
    await vi.waitFor(() => {
      expect(started.mirrorStats().lines).toBeGreaterThanOrEqual(normal + 24);
    });
  });
});

describe('launcher', () => {
  let home: string;
  let terms: TerminalProcess[];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'wtd-launcher-'));
    terms = [];
  });

  afterEach(async () => {
    await Promise.all(terms.map((t) => t.close()));
    rmSync(home, { recursive: true, force: true });
  });

  interface Exited {
    code: number;
    signal: string | null;
    oom: boolean;
    at: number;
  }

  /** Starts `command` as terminal 7 with `memory`, through `launcher` when given. */
  const run = async (
    command: string,
    launcher?: TerminalLauncher,
  ): Promise<{ term: TerminalProcess; output: () => string; exited: Promise<Exited> }> => {
    let text = '';
    let exitedNow: (exit: Exited) => void = () => undefined;
    const exited = new Promise<Exited>((resolve) => {
      exitedNow = resolve;
    });
    const spec = {
      termId: 7,
      memory: { max: '1G' },
      cwd: home,
      command,
      cols: 80,
      rows: 24,
      env: { ...process.env, HOME: home, SHELL: '/bin/bash' },
    };
    const events = {
      activity: () => undefined,
      exited: (code: number, signal: string | null, oom: boolean) => {
        exitedNow({ code, signal, oom, at: Date.now() });
      },
    };
    const term = await (launcher === undefined ? TerminalProcess.spawn(spec, events) : TerminalProcess.spawn(spec, events, launcher));
    terms.push(term);
    term.attach(1, {
      snapshot: (_offset, data) => (text += Buffer.from(data).toString()),
      output: (offset, data) => {
        text += Buffer.from(data).toString();
        term.ack(1, offset + data.length);
      },
      superseded: () => undefined,
      lagging: () => undefined,
    });
    return { term, output: () => text, exited };
  };

  /** A launcher recording its calls, answering `oom` after `delayMs`. */
  const recording = (oom: boolean, delayMs = 0) => {
    const commands: unknown[][] = [];
    const asked: { termId: number; at: number }[] = [];
    const launcher: TerminalLauncher = {
      command: (termId, memory, shell, args) => {
        commands.push([termId, memory, shell, [...args]]);
        return ['/usr/bin/env', 'WTD_LAUNCHED=yes', shell, ...args];
      },
      outOfMemory: async (termId) => {
        asked.push({ termId, at: Date.now() });
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return oom;
      },
    };
    return { launcher, commands, asked };
  };

  it('runs the command the launcher makes of the shell, its arguments, the terminal id and the limits', async () => {
    const { launcher, commands } = recording(false);
    const command = 'echo "launched=$WTD_LAUNCHED"; exec sleep 60';
    const { output } = await run(command, launcher);
    await vi.waitFor(() => {
      expect(output()).toContain('launched=yes');
    });
    expect(commands).toEqual([[7, { max: '1G' }, '/bin/bash', ['-l', '-i', '-c', command]]]);
  });

  it('asks the launcher whether a terminal killed by SIGKILL ran out of memory, and reports the exit only then', async () => {
    const { launcher, asked } = recording(true, 300);
    const { term, exited } = await run('kill -KILL $$', launcher);
    const exit = await exited;
    expect(exit).toMatchObject({ signal: 'SIGKILL', oom: true });
    expect(asked.map((a) => a.termId)).toEqual([7]);
    expect(exit.at - (asked[0]?.at ?? 0)).toBeGreaterThanOrEqual(250);
    expect(term.exit).toEqual({ code: exit.code, signal: 'SIGKILL', oom: true });
  });

  it('reports oom false for a SIGKILL the launcher finds no out-of-memory kill', async () => {
    const { launcher } = recording(false);
    const { term, exited } = await run('kill -KILL $$', launcher);
    expect(await exited).toMatchObject({ signal: 'SIGKILL', oom: false });
    expect(term.exit).toMatchObject({ signal: 'SIGKILL', oom: false });
  });

  it.each([
    ['a non-zero code', 'exit 3', { code: 3, signal: null }],
    ['SIGTERM', "exec sh -c 'kill -TERM $$'", { signal: 'SIGTERM' }],
  ])('does not ask the launcher about an exit with %s, reporting oom false', async (_name, command, exit) => {
    const { launcher, asked } = recording(true);
    const { term, exited } = await run(command, launcher);
    expect(await exited).toMatchObject({ ...exit, oom: false });
    expect(term.exit).toMatchObject({ ...exit, oom: false });
    expect(asked).toEqual([]);
  });

  it('runs the shell itself without a launcher, reporting oom false for a SIGKILL', async () => {
    const { output, exited } = await run('echo "launched=${WTD_LAUNCHED:-no}"; read -r _; kill -KILL $$');
    await vi.waitFor(() => {
      expect(output()).toContain('launched=no');
    });
    terms[0]?.write(Buffer.from('\r'));
    expect(await exited).toMatchObject({ signal: 'SIGKILL', oom: false });
  });
});
