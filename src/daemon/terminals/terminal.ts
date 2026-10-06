import { spawn as spawnPty, type IPty } from '@homebridge/node-pty-prebuilt-multiarch';
import serializeAddon from '@xterm/addon-serialize';
import xterm from '@xterm/headless';
import { access, constants as fsConstants, stat } from 'node:fs/promises';
import { constants } from 'node:os';
import { isAbsolute } from 'node:path';
import { MAX_FRAME } from '../../protocol/index.js';
import { FlowControl, type AckResult } from './flow.js';
import { InputWriter } from './input.js';
import { drainFd, guardStream, type StreamGuard } from './stream.js';

const SCROLLBACK = 5000;
const KILL_AFTER_MS = 5000;
/** Largest snapshot: a data frame payload less its terminal id and offset. */
const MAX_SNAPSHOT = MAX_FRAME - 12;

/** The terminal's process could not be started. */
export class SpawnError extends Error {
  override readonly name = 'SpawnError';
}

export interface TerminalSpec {
  cwd: string;
  /** Run in a login interactive shell; null for the shell itself. */
  command: string | null;
  cols: number;
  rows: number;
  env: Readonly<Record<string, string | undefined>>;
}

export interface TerminalEvents {
  /** `unseen` or `bell` changed. */
  activity: (unseen: boolean, bell: boolean) => void;
  /** The process exited and every output byte has been offered. */
  exited: (code: number, signal: string | null) => void;
}

/** Where one attached connection's output goes. */
export interface OutputSink {
  snapshot: (offset: number, data: Uint8Array) => void;
  output: (offset: number, data: Uint8Array) => void;
  /** The attach ended before its snapshot was taken. */
  superseded: () => void;
  /** Detached for lagging. */
  lagging: () => void;
}

interface Consumer {
  sink: OutputSink;
  /** Whether the snapshot was sent; output until then waits in `pending`. */
  ready: boolean;
  pending: { offset: number; data: Uint8Array }[];
}

export interface ExitStatus {
  code: number;
  signal: string | null;
}

const signalName = (signal: number | undefined): string | null => {
  if (signal === undefined || signal === 0) return null;
  return Object.entries(constants.signals).find(([, n]) => n === signal)?.[0] ?? `SIG${String(signal)}`;
};

const hasCode = (error: unknown, code: string): boolean => error instanceof Error && 'code' in error && error.code === code;

/** Signals the process group `pid` leads; it may be gone already. */
const signalGroup = (pid: number, signal: NodeJS.Signals): void => {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!hasCode(error, 'ESRCH')) throw error;
  }
};

const checkSpawnable = async (shell: string, cwd: string): Promise<void> => {
  try {
    await access(shell, fsConstants.X_OK);
  } catch (error) {
    throw new SpawnError(`shell ${shell} is not executable`, { cause: error });
  }
  let directory: boolean;
  try {
    directory = (await stat(cwd)).isDirectory();
  } catch (error) {
    throw new SpawnError(`${cwd} is not accessible`, { cause: error });
  }
  if (!directory) throw new SpawnError(`${cwd} is not a directory`);
};

/**
 * A PTY with a headless screen mirror. One sequencer per terminal assigns output offsets, feeds the
 * mirror and fans output out to attached consumers, so a snapshot cut is exact.
 */
export class TerminalProcess {
  private readonly mirror: xterm.Terminal;
  private readonly serializer = new serializeAddon.SerializeAddon();
  private readonly flow = new FlowControl(() => Date.now());
  private readonly consumers = new Map<number, Consumer>();
  private readonly input: InputWriter;
  private readonly stream: StreamGuard;
  private ptyPaused = false;
  private evictAt: number | null = null;
  private evictTimer: NodeJS.Timeout | null = null;
  private killTimer: NodeJS.Timeout | null = null;
  private visible = false;
  private exitStatus: ExitStatus | null = null;
  private reaped = false;
  private closing = false;
  private onReaped: (() => void) | null = null;
  cols: number;
  rows: number;
  unseen = false;
  bell = false;

  private constructor(
    private readonly pty: IPty,
    fd: number,
    spec: TerminalSpec,
    private readonly events: TerminalEvents,
  ) {
    this.cols = spec.cols;
    this.rows = spec.rows;
    this.mirror = new xterm.Terminal({ cols: spec.cols, rows: spec.rows, scrollback: SCROLLBACK, allowProposedApi: true });
    this.mirror.loadAddon(this.serializer);
    this.mirror.onBell(() => {
      this.onBell();
    });
    this.input = new InputWriter(fd);
    // Destroying closes the fd: first read the output still in it, and let a write in flight
    // finish, as it could land on a reused fd.
    this.stream = guardStream(
      pty,
      () => this.ptyPaused,
      (destroy) => {
        drainFd(fd, (data) => {
          this.onOutput(data);
        });
        this.input.stopThen(destroy);
      },
    );
    pty.onData((data) => {
      this.onOutput(data);
    });
    pty.onExit(({ exitCode, signal }) => {
      this.onExit({ code: exitCode, signal: signalName(signal) });
    });
  }

  /** Starts `$SHELL -l -i [-c command]` (`/bin/sh` unless SHELL is absolute) in `spec.cwd`. */
  static async spawn(spec: TerminalSpec, events: TerminalEvents): Promise<TerminalProcess> {
    const configured = spec.env['SHELL'];
    const shell = configured !== undefined && isAbsolute(configured) ? configured : '/bin/sh';
    await checkSpawnable(shell, spec.cwd);
    const args = spec.command === null ? ['-l', '-i'] : ['-l', '-i', '-c', spec.command];
    let pty: IPty;
    try {
      pty = spawnPty(shell, args, {
        name: 'xterm-256color',
        cols: spec.cols,
        rows: spec.rows,
        cwd: spec.cwd,
        env: { ...spec.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
        encoding: null,
      });
    } catch (error) {
      throw new SpawnError(`cannot start ${shell}`, { cause: error });
    }
    const fd: unknown = 'fd' in pty ? pty.fd : undefined;
    try {
      if (typeof fd !== 'number') throw new Error('the PTY exposes no master fd');
      return new TerminalProcess(pty, fd, spec, events);
    } catch (error) {
      pty.kill('SIGKILL');
      throw new SpawnError(`cannot drive the PTY of ${shell}`, { cause: error });
    }
  }

  get exit(): ExitStatus | null {
    return this.exitStatus;
  }

  /** Attaches `id` (again): its sink gets a snapshot at the current position, then output from there. */
  attach(id: number, sink: OutputSink): void {
    this.supersede(id);
    const at = this.flow.attach(id);
    const consumer: Consumer = { sink, ready: false, pending: [] };
    this.consumers.set(id, consumer);
    this.mirror.write('', () => {
      if (this.consumers.get(id) !== consumer) return;
      sink.snapshot(at, this.snapshot());
      consumer.ready = true;
      for (const { offset, data } of consumer.pending.splice(0)) this.deliver(id, consumer, offset, data);
    });
    this.applyFlow();
  }

  detach(id: number): void {
    this.supersede(id);
    this.flow.detach(id);
    this.applyFlow();
  }

  /** Records `id`'s ack; an ack from a consumer that is not attached is stale. */
  ack(id: number, offset: number): AckResult {
    if (!this.consumers.has(id)) return 'stale';
    const result = this.flow.ack(id, offset);
    this.applyFlow();
    return result;
  }

  /** Queues input; false when too much input is waiting and `data` was discarded. */
  write(data: Uint8Array): boolean {
    return this.input.push(data);
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    if (this.exitStatus === null && !this.closing) this.pty.resize(cols, rows);
    this.mirror.write('', () => {
      if (!this.closing) this.mirror.resize(cols, rows);
    });
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible && (this.unseen || this.bell)) {
      this.unseen = false;
      this.bell = false;
      this.events.activity(false, false);
    }
  }

  /**
   * Ends the terminal: SIGHUP to its process group, SIGKILL 5 s later if not yet reaped. Resolves
   * once the process is reaped.
   */
  close(): Promise<void> {
    this.closing = true;
    for (const id of this.consumers.keys()) this.supersede(id);
    this.input.stop();
    if (this.evictTimer !== null) clearTimeout(this.evictTimer);
    if (this.ptyPaused) {
      this.ptyPaused = false;
      this.pty.resume();
      this.stream.resumed();
    }
    if (this.reaped) {
      this.mirror.dispose();
      return Promise.resolve();
    }
    signalGroup(this.pty.pid, 'SIGHUP');
    this.killTimer = setTimeout(() => {
      signalGroup(this.pty.pid, 'SIGKILL');
    }, KILL_AFTER_MS);
    return new Promise((resolve) => {
      this.onReaped = resolve;
    });
  }

  private supersede(id: number): void {
    const consumer = this.consumers.get(id);
    if (consumer === undefined) return;
    this.consumers.delete(id);
    if (!consumer.ready) consumer.sink.superseded();
  }

  private deliver(id: number, consumer: Consumer, offset: number, data: Uint8Array): void {
    consumer.sink.output(offset, data);
    this.flow.sent(id, offset + data.length);
  }

  private onOutput(data: string | Uint8Array): void {
    this.stream.received();
    if (this.closing) return;
    const bytes = data instanceof Uint8Array ? data : Buffer.from(data);
    const offset = this.flow.produced;
    this.flow.output(bytes.length);
    this.mirror.write(bytes, () => {
      this.flow.parsed(bytes.length);
      this.applyFlow();
    });
    for (const [id, consumer] of this.consumers) {
      if (consumer.ready) this.deliver(id, consumer, offset, bytes);
      else consumer.pending.push({ offset, data: bytes });
    }
    if (!this.visible && !this.unseen) {
      this.unseen = true;
      this.events.activity(true, this.bell);
    }
    this.applyFlow();
  }

  private onBell(): void {
    if (this.visible || this.bell || this.closing) return;
    this.bell = true;
    this.events.activity(this.unseen, true);
  }

  private onExit(status: ExitStatus): void {
    this.reaped = true;
    if (this.killTimer !== null) clearTimeout(this.killTimer);
    this.input.stop();
    if (this.closing) {
      this.mirror.dispose();
      this.onReaped?.();
      return;
    }
    this.exitStatus = status;
    this.mirror.write('', () => {
      if (!this.closing) this.events.exited(status.code, status.signal);
    });
  }

  /** Serializes the mirror, with less scrollback while the snapshot exceeds the frame limit. */
  private snapshot(): Uint8Array {
    let scrollback = SCROLLBACK;
    for (;;) {
      const data = Buffer.from(this.serializer.serialize({ scrollback }));
      if (data.length <= MAX_SNAPSHOT || scrollback === 0) return data;
      scrollback = Math.max(0, Math.min(scrollback - 1, Math.floor(((scrollback * MAX_SNAPSHOT) / data.length) * 0.9)));
    }
  }

  private applyFlow(): void {
    if (this.closing) return;
    if (this.flow.paused !== this.ptyPaused && !this.reaped) {
      this.ptyPaused = this.flow.paused;
      if (this.ptyPaused) {
        this.pty.pause();
        this.stream.paused();
      } else {
        this.pty.resume();
        this.stream.resumed();
      }
    }
    const next = this.flow.nextEviction();
    if (next === this.evictAt) return;
    this.evictAt = next;
    if (this.evictTimer !== null) clearTimeout(this.evictTimer);
    this.evictTimer =
      next === null
        ? null
        : setTimeout(
            () => {
              this.evict();
            },
            Math.max(0, next - Date.now()),
          );
  }

  private evict(): void {
    this.evictTimer = null;
    this.evictAt = null;
    for (const id of this.flow.lagging()) {
      const consumer = this.consumers.get(id);
      this.supersede(id);
      this.flow.detach(id);
      consumer?.sink.lagging();
    }
    this.applyFlow();
  }
}
