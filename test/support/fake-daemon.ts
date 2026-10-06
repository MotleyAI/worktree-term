import { mkdirSync, rmSync } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';
import { encodeFrame, FrameKind, StreamDecoder, type Frame } from '../../src/protocol/index.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface FakeDaemonOptions {
  /** Protocol announced in hello. */
  protocol: number;
  version?: string;
  instance?: string;
  /** `hello`: greet every connection; `close`: close every connection at once. */
  accept?: 'hello' | 'close';
  /** `exit`: stop serving on a `shutdown` message; `ignore`: keep serving. */
  onShutdown?: 'exit' | 'ignore';
}

/** A test-controlled daemon socket speaking only the frozen handshake. */
export class FakeDaemon {
  /** Control messages received, as parsed JSON, across all connections. */
  readonly received: unknown[] = [];
  connections = 0;
  shutdowns = 0;
  readonly closed: Promise<void>;
  private readonly sockets = new Set<Socket>();
  private resolveClosed: () => void = () => undefined;

  private constructor(
    private readonly server: Server,
    private readonly path: string,
    private readonly options: Required<FakeDaemonOptions>,
  ) {
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    server.on('connection', (socket) => {
      this.accept(socket);
    });
  }

  /** Serves `path` (a daemon socket path), creating its directories owner-only. */
  static async listen(path: string, options: FakeDaemonOptions): Promise<FakeDaemon> {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, resolve);
    });
    return new FakeDaemon(server, path, {
      version: '0.0.1-fake',
      instance: 'fake_instance',
      accept: 'hello',
      onShutdown: 'exit',
      ...options,
    });
  }

  /** Stops serving and removes the socket file. */
  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => {
      this.server.close(() => {
        resolve();
      });
    });
    rmSync(this.path, { force: true });
    this.resolveClosed();
  }

  private accept(socket: Socket): void {
    this.connections++;
    if (this.options.accept === 'close') {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => undefined);
    const frames = new StreamDecoder();
    socket.on('data', (chunk: Buffer) => {
      for (const frame of frames.push(chunk)) this.onFrame(frame);
    });
    const { protocol, version, instance } = this.options;
    socket.write(
      encodeFrame({ kind: FrameKind.control, payload: encoder.encode(JSON.stringify({ t: 'hello', protocol, version, instance })) }),
    );
  }

  private onFrame(frame: Frame): void {
    if (frame.kind !== FrameKind.control) return;
    const message: unknown = JSON.parse(decoder.decode(frame.payload));
    this.received.push(message);
    if (typeof message === 'object' && message !== null && 't' in message && message.t === 'shutdown') {
      this.shutdowns++;
      if (this.options.onShutdown === 'exit') void this.close();
    }
  }
}

/** A frame that passed through a SocketProxy. */
export interface ProxiedFrame {
  kind: Frame['kind'];
  payload: Uint8Array;
}

/** Relays connections on `front` to `back`, recording every frame in both directions. */
export class SocketProxy {
  readonly fromDaemon: ProxiedFrame[] = [];
  readonly toDaemon: ProxiedFrame[] = [];
  private readonly sockets = new Set<Socket>();

  private constructor(
    private readonly server: Server,
    private readonly front: string,
  ) {}

  static async listen(front: string, back: string): Promise<SocketProxy> {
    mkdirSync(dirname(front), { recursive: true, mode: 0o700 });
    const server = createServer();
    const proxy = new SocketProxy(server, front);
    server.on('connection', (client) => {
      proxy.relay(client, back);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(front, resolve);
    });
    return proxy;
  }

  /** Control payloads from the daemon, as text. */
  controlTexts(): string[] {
    return this.fromDaemon.filter((f) => f.kind === FrameKind.control).map((f) => decoder.decode(f.payload));
  }

  /** Control payloads to the daemon, as text. */
  controlTextsToDaemon(): string[] {
    return this.toDaemon.filter((f) => f.kind === FrameKind.control).map((f) => decoder.decode(f.payload));
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => {
      this.server.close(() => {
        resolve();
      });
    });
    rmSync(this.front, { force: true });
  }

  private relay(client: Socket, back: string): void {
    const daemon = connect(back);
    this.sockets.add(client);
    this.sockets.add(daemon);
    const fromDaemon = new StreamDecoder();
    const toDaemon = new StreamDecoder();
    daemon.on('data', (chunk: Buffer) => {
      for (const frame of fromDaemon.push(chunk)) this.fromDaemon.push({ kind: frame.kind, payload: frame.payload });
      client.write(chunk);
    });
    client.on('data', (chunk: Buffer) => {
      for (const frame of toDaemon.push(chunk)) this.toDaemon.push({ kind: frame.kind, payload: frame.payload });
      daemon.write(chunk);
    });
    const end = (): void => {
      client.destroy();
      daemon.destroy();
    };
    for (const socket of [client, daemon]) {
      socket.on('close', end);
      socket.on('error', () => undefined);
    }
  }
}
