import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { connect, type Socket } from 'node:net';
import type { Readable, Writable } from 'node:stream';
import { dial, spawnDetached, sshCommand, StderrTail } from '../../platform/dialer/index.js';
import { installRemote, type InstalledRemote } from '../../platform/install/index.js';
import { ProtocolError, StreamDecoder, type Frame } from '../../protocol/index.js';

/** The host files a local link needs. */
export type DaemonPaths = Parameters<typeof dial>[0];

/** The remote command a remote link runs. */
export const CONNECT_COMMAND = '"$HOME/.local/bin/wtd" connect';

export interface LinkEvents {
  /** A frame from the daemon. */
  frame: (frame: Frame) => void;
  /** The link ended: the dial failed, the connection closed, or the daemon sent a malformed stream. Called once. */
  ended: (error: Error | null) => void;
}

/** One connection to a daemon. */
export interface Link {
  send: (bytes: Uint8Array) => void;
  /** Stops reading from the daemon. */
  pause: () => void;
  resume: () => void;
  /** Flushes what was sent, then closes; `ended` is not called after this. */
  close: () => void;
}

/** A closing link's grace to flush before it is cut off. */
const CLOSE_GRACE_MS = 1000;

const connectExisting = (path: string): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const socket = connect(path);
    const fail = (error: Error): void => {
      socket.destroy();
      reject(error);
    };
    socket.once('error', fail);
    socket.once('connect', () => {
      socket.off('error', fail);
      resolve(socket);
    });
  });

const ignore = (): void => undefined;

/** Ends `socket` once its writes are flushed, cutting it off after a grace period. */
const endSocket = (socket: Socket): void => {
  socket.on('error', ignore);
  setTimeout(() => socket.destroy(), CLOSE_GRACE_MS).unref();
  socket.end();
};

class SocketLink implements Link {
  private socket: Socket | null = null;
  private readonly queued: Uint8Array[] = [];
  private paused = false;
  private closed = false;
  private finished = false;
  private readonly decoder = new StreamDecoder();

  constructor(private readonly events: LinkEvents) {}

  /** Attaches the socket once `connecting` resolves, or ends the link if it fails. */
  follow(connecting: Promise<Socket>): void {
    connecting.then(
      (socket) => {
        this.attach(socket);
      },
      (error: unknown) => {
        this.finish(error instanceof Error ? error : new Error(String(error)));
      },
    );
  }

  send(bytes: Uint8Array): void {
    if (this.closed) return;
    if (this.socket === null) this.queued.push(bytes);
    else this.socket.write(bytes);
  }

  pause(): void {
    this.paused = true;
    this.socket?.pause();
  }

  resume(): void {
    this.paused = false;
    this.socket?.resume();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.socket !== null) endSocket(this.socket);
  }

  private attach(socket: Socket): void {
    this.socket = socket;
    for (const bytes of this.queued.splice(0)) socket.write(bytes);
    if (this.closed) {
      endSocket(socket);
      return;
    }
    if (this.paused) socket.pause();
    let failure: Error | null = null;
    socket.on('data', (chunk: Buffer) => {
      this.receive(socket, chunk);
    });
    socket.on('error', (error) => {
      failure = error;
    });
    socket.once('close', () => {
      this.finish(failure);
    });
  }

  private receive(socket: Socket, chunk: Uint8Array): void {
    let frames: Frame[];
    try {
      frames = this.decoder.push(chunk);
    } catch (error) {
      if (!(error instanceof ProtocolError)) throw error;
      socket.destroy();
      this.finish(error);
      return;
    }
    for (const frame of frames) {
      if (this.closed || this.finished) return;
      this.events.frame(frame);
    }
  }

  private finish(error: Error | null): void {
    if (this.finished) return;
    this.finished = true;
    if (!this.closed) this.events.ended(error);
  }
}

/** How long a lost remote link waits for the rest of the SSH process's standard error. */
const STDERR_GRACE_MS = 250;

type SshProcess = ChildProcessByStdio<Writable, Readable, Readable>;

/** A link over an SSH process's standard input and output. */
class ProcessLink implements Link {
  private readonly child: SshProcess;
  private readonly decoder = new StreamDecoder();
  private readonly tail = new StderrTail();
  private exit: string | null = null;
  private stderrDone = false;
  private grace: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private finished = false;

  constructor(
    private readonly events: LinkEvents,
    command: readonly string[],
  ) {
    const [program = 'ssh', ...args] = command;
    this.child = spawn(program, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdin.on('error', ignore);
    this.child.stdout.on('data', (chunk: Buffer) => {
      this.receive(chunk);
    });
    this.child.stdout.once('end', () => {
      this.lost();
    });
    this.tail.follow(this.child.stderr);
    this.child.stderr.once('close', () => {
      this.stderrDone = true;
      if (this.exit !== null) this.finish(this.cause());
    });
    this.child.once('error', (error) => {
      this.exit ??= `cannot run ${program}: ${error.message}`;
      this.finish(new Error(this.exit));
    });
    this.child.once('exit', (code, signal) => {
      this.exit = code === null ? `${program} was killed by ${String(signal)}` : `${program} exited with status ${String(code)}`;
      if (this.stderrDone) this.finish(this.cause());
      else this.lost();
    });
  }

  send(bytes: Uint8Array): void {
    if (!this.closed) this.child.stdin.write(bytes);
  }

  pause(): void {
    this.child.stdout.pause();
  }

  resume(): void {
    this.child.stdout.resume();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.terminate();
  }

  /** Ends standard input, then sends SIGTERM if the process is still running 1 s later. */
  private terminate(): void {
    this.child.stdin.end();
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    setTimeout(() => {
      if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGTERM');
    }, CLOSE_GRACE_MS).unref();
  }

  private receive(chunk: Uint8Array): void {
    let frames: Frame[];
    try {
      frames = this.decoder.push(chunk);
    } catch (error) {
      if (!(error instanceof ProtocolError)) throw error;
      this.finish(error);
      return;
    }
    for (const frame of frames) {
      if (this.closed || this.finished) return;
      this.events.frame(frame);
    }
  }

  /** The process exited or its output ended: finish once its standard error is read, or after a grace period. */
  private lost(): void {
    this.grace ??= setTimeout(() => {
      this.finish(this.cause());
    }, STDERR_GRACE_MS);
  }

  private cause(): Error {
    return new Error(this.tail.reason() ?? this.exit ?? 'the SSH process closed its output');
  }

  private finish(error: Error): void {
    if (this.finished) return;
    this.finished = true;
    if (this.grace !== null) clearTimeout(this.grace);
    this.terminate();
    if (!this.closed) this.events.ended(error);
  }
}

/** Links to a remote host's daemon by running `wtd connect` there over SSH. */
export class RemoteDaemon {
  constructor(
    private readonly paths: DaemonPaths,
    readonly alias: string,
  ) {}

  /** Opens a link; `wtd connect` always starts a daemon when none runs, so there is no `start` option. */
  open(events: LinkEvents): Link {
    let command: string[];
    try {
      command = sshCommand(this.paths, this.alias, CONNECT_COMMAND);
    } catch (error) {
      return new FailedLink(events, error instanceof Error ? error : new Error(String(error)));
    }
    return new ProcessLink(events, command);
  }
}

/** A link that could not be opened; it ends on the next turn. */
class FailedLink implements Link {
  private closed = false;

  constructor(events: LinkEvents, error: Error) {
    setImmediate(() => {
      if (!this.closed) events.ended(error);
    });
  }

  send(): void {
    // Nothing to send to.
  }

  pause(): void {
    // Nothing to read.
  }

  resume(): void {
    // Nothing to read.
  }

  close(): void {
    this.closed = true;
  }
}

/** Something links to a daemon can be opened to. */
export interface DaemonEndpoint {
  open: (events: LinkEvents, options?: { start?: boolean }) => Link;
}

/** Links to this host's daemon over its unix socket. */
export class LocalDaemon {
  constructor(
    private readonly paths: DaemonPaths,
    /** Starts the daemon when no daemon serves the socket. */
    private readonly command: readonly string[],
  ) {}

  /** Opens a link, starting the daemon when absent unless `start` is false. */
  open(events: LinkEvents, { start = true }: { start?: boolean } = {}): Link {
    const link = new SocketLink(events);
    link.follow(start ? dial(this.paths, this.command) : connectExisting(this.paths.socket));
    return link;
  }
}

/** Starts `command` detached in its own session, appending its output to `log` (ignored when null). */
export const startDetached = (command: readonly string[], log: string | null): Promise<void> => spawnDetached(command, log);

/** Installs the bundle at `bundle` on the SSH host `alias`, finding its Node there. */
export const installOnRemote = (
  paths: Parameters<typeof installRemote>[0]['paths'],
  alias: string,
  bundle: string,
  version: string,
  timeoutMs: number,
): Promise<InstalledRemote> => installRemote({ paths, alias, bundle, version, node: null, timeoutMs });
