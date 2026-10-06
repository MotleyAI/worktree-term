import { connect, type Socket } from 'node:net';
import { dial, spawnDetached } from '../../platform/dialer/index.js';
import { ProtocolError, StreamDecoder, type Frame } from '../../protocol/index.js';

/** The host files a local link needs. */
export type DaemonPaths = Parameters<typeof dial>[0];

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
