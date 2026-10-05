import type { Socket } from 'node:net';
import {
  encodeFrame,
  encodeMessage,
  encodeStreamData,
  FrameKind,
  ProtocolError,
  StreamDecoder,
  type DataFrame,
  type MessageOf,
} from '../../protocol/index.js';
import { ConnectionGate, type GateOutcome } from './connection.js';

/** Bytes queued to one connection but not yet written, above which it is closed. */
export const MAX_QUEUED = 64 * 1024 * 1024;
const MAX_ERROR_MESSAGE = 1024;

export type Event = MessageOf<'daemonToClient'>;

export interface PeerHandlers {
  /** A frame (or stream failure) of `peer`, as the handshake gate classifies it. */
  received: (peer: Peer, outcome: GateOutcome) => void;
  /** The connection has ended. */
  closed: (peer: Peer) => void;
}

const encoder = new TextEncoder();

/** One client connection: framing, the handshake gate and a bounded outbound queue. */
export class Peer {
  /** Repos this connection watches. */
  readonly watched = new Set<string>();
  /** Terminal ids of this connection's latest `setVisible`. */
  visible: ReadonlySet<number> = new Set();
  private readonly decoder = new StreamDecoder();
  private readonly gate = new ConnectionGate();
  private ended = false;

  constructor(
    readonly id: number,
    private readonly socket: Socket,
    private readonly handlers: PeerHandlers,
  ) {
    socket.on('data', (chunk: Buffer) => {
      this.receive(chunk);
    });
    socket.on('error', () => {
      socket.destroy();
    });
    socket.once('close', () => {
      this.ended = true;
      handlers.closed(this);
    });
  }

  /** Whether the connection is closed or closing; nothing more is sent or received. */
  get closed(): boolean {
    return this.ended;
  }

  send(message: Event): void {
    this.write(encodeFrame({ kind: FrameKind.control, payload: encoder.encode(encodeMessage('daemonToClient', message)) }));
  }

  sendData(frame: DataFrame): void {
    this.write(encodeStreamData(frame));
  }

  /** Sends an uncorrelated error. */
  sendError(code: Extract<Event, { t: 'error' }>['code'], message: string, req: number | null = null): void {
    this.send({ t: 'error', req, code, message: message.slice(0, MAX_ERROR_MESSAGE) });
  }

  /** Resolves once at most `limit` bytes are queued, or the connection closed. */
  async drained(limit: number): Promise<void> {
    while (!this.ended && this.socket.writableLength > limit) {
      await new Promise<void>((resolve) => {
        const done = (): void => {
          this.socket.off('drain', done);
          this.socket.off('close', done);
          resolve();
        };
        this.socket.on('drain', done);
        this.socket.on('close', done);
      });
    }
  }

  /** Flushes what is queued, then closes. */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.socket.end(() => {
      this.socket.destroy();
    });
  }

  destroy(): void {
    this.ended = true;
    this.socket.destroy();
  }

  private write(bytes: Uint8Array): void {
    if (this.ended) return;
    this.socket.write(bytes);
    if (this.socket.writableLength > MAX_QUEUED) this.destroy();
  }

  private receive(chunk: Uint8Array): void {
    if (this.ended) return;
    let frames;
    try {
      frames = this.decoder.push(chunk);
    } catch (error) {
      if (!(error instanceof ProtocolError)) throw error;
      this.handlers.received(this, this.gate.streamFailed());
      return;
    }
    for (const frame of frames) {
      if (this.closed) return;
      this.handlers.received(this, this.gate.receive(frame));
    }
  }
}
