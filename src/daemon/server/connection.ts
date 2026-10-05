import {
  decodeMessage,
  decodeStreamData,
  FrameKind,
  PROTOCOL_VERSION,
  ProtocolError,
  type DataFrame,
  type Frame,
  type MessageOf,
} from '../../protocol/index.js';

type ClientMessage = MessageOf<'clientToDaemon'>;

/** A client message other than `hello` and `shutdown`. */
export type Request = Exclude<ClientMessage, { t: 'hello' | 'shutdown' }>;

export type GateOutcome =
  | { kind: 'hello' }
  | { kind: 'shutdown' }
  | { kind: 'request'; message: Request }
  | { kind: 'input'; termId: number; data: Uint8Array }
  | { kind: 'reject'; code: 'bad-message' | 'version-mismatch'; close: boolean };

export type GateState = 'awaiting-hello' | 'ready' | 'mismatched';

const BAD_MESSAGE: GateOutcome = { kind: 'reject', code: 'bad-message', close: true };
const MISMATCH: GateOutcome = { kind: 'reject', code: 'version-mismatch', close: false };

/** `decode()`, or null when the input is malformed. */
const orNull = <T>(decode: () => T): T | null => {
  try {
    return decode();
  } catch (error) {
    if (error instanceof ProtocolError) return null;
    throw error;
  }
};

const decodeControl = (frame: Frame): ClientMessage | null => orNull(() => decodeMessage('clientToDaemon', frame.payload));

/** The handshake state machine of one connection: what each incoming frame means. */
export class ConnectionGate {
  private current: GateState = 'awaiting-hello';

  get state(): GateState {
    return this.current;
  }

  receive(frame: Frame): GateOutcome {
    switch (this.current) {
      case 'awaiting-hello':
        return this.awaitingHello(frame);
      case 'ready':
        return this.ready(frame);
      case 'mismatched':
        return frame.kind === FrameKind.control && decodeControl(frame)?.t === 'shutdown' ? { kind: 'shutdown' } : MISMATCH;
    }
  }

  /** The byte stream could not be split into frames. */
  streamFailed(): GateOutcome {
    return this.current === 'mismatched' ? { kind: 'reject', code: 'version-mismatch', close: true } : BAD_MESSAGE;
  }

  private awaitingHello(frame: Frame): GateOutcome {
    const message = frame.kind === FrameKind.control ? decodeControl(frame) : null;
    if (message?.t !== 'hello') return BAD_MESSAGE;
    this.current = message.protocol === PROTOCOL_VERSION ? 'ready' : 'mismatched';
    return { kind: 'hello' };
  }

  private ready(frame: Frame): GateOutcome {
    if (frame.kind === FrameKind.input) {
      const data: DataFrame | null = orNull(() => decodeStreamData(frame));
      return data?.kind === 'input' ? { kind: 'input', termId: data.termId, data: data.data } : BAD_MESSAGE;
    }
    if (frame.kind !== FrameKind.control) return BAD_MESSAGE;
    const message = decodeControl(frame);
    if (message === null || message.t === 'hello') return BAD_MESSAGE;
    if (message.t === 'shutdown') return { kind: 'shutdown' };
    return { kind: 'request', message };
  }
}
