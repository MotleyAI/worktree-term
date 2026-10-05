import { z } from 'zod';
import { MAX_FRAME, MAX_INPUT } from './constants.js';
import { ProtocolError } from './errors.js';
import { hostIdx, offset, termId } from './values.js';

export const FrameKind = { control: 0, output: 1, snapshot: 2, input: 3 } as const;
export type FrameKind = (typeof FrameKind)[keyof typeof FrameKind];

/** One stream frame: control payloads are UTF-8 JSON, the others data payloads. */
export interface Frame {
  kind: FrameKind;
  payload: Uint8Array;
}

const HEADER = 5;
const ID = 4;
const OFFSET = 8;
const WS_HEADER = 1 + 2;
const INITIAL_PAYLOAD = 64 * 1024;

const bytes = z.custom<Uint8Array>((value) => value instanceof Uint8Array, 'expected a Uint8Array');

const dataFrame = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.enum(['output', 'snapshot']), termId, offset, data: bytes }),
  z.strictObject({ kind: z.literal('input'), termId, data: bytes.refine((d) => d.length <= MAX_INPUT, 'input exceeds MAX_INPUT') }),
]);

/** Terminal bytes: output and snapshots tagged with their output position, or input. */
export type DataFrame = z.infer<typeof dataFrame>;

const isKind = (kind: number): kind is FrameKind => kind <= FrameKind.input;

const validData = (value: DataFrame): DataFrame => {
  const result = dataFrame.safeParse(value);
  if (!result.success) throw new ProtocolError(`invalid data frame: ${z.prettifyError(result.error)}`);
  return result.data;
};

const dataHeader = (frame: DataFrame): number => ID + (frame.kind === 'input' ? 0 : OFFSET);

/** Writes the data payload (id, offset, bytes) at `at`. */
const writeData = (out: Uint8Array, at: number, frame: DataFrame): void => {
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(at, frame.termId);
  if (frame.kind !== 'input') view.setBigUint64(at + ID, BigInt(frame.offset));
  out.set(frame.data, at + dataHeader(frame));
};

/** Reads a data payload of `kind` starting at `at`. */
const readData = (kind: FrameKind, bytes: Uint8Array, at: number): DataFrame => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (kind === FrameKind.input) {
    if (bytes.length < at + ID) throw new ProtocolError('input payload shorter than its header');
    return validData({ kind: 'input', termId: view.getUint32(at), data: bytes.subarray(at + ID) });
  }
  if (kind === FrameKind.control) throw new ProtocolError('control frame is not a data frame');
  if (bytes.length < at + ID + OFFSET) throw new ProtocolError('data payload shorter than its header');
  const position = view.getBigUint64(at + ID);
  if (position > BigInt(Number.MAX_SAFE_INTEGER)) throw new ProtocolError('offset above 2^53-1');
  return validData({
    kind: kind === FrameKind.output ? 'output' : 'snapshot',
    termId: view.getUint32(at),
    offset: Number(position),
    data: bytes.subarray(at + ID + OFFSET),
  });
};

const KIND_OF = { output: FrameKind.output, snapshot: FrameKind.snapshot, input: FrameKind.input } as const;

/** Encodes a stream frame: 4-byte big-endian payload length, kind, payload. */
export const encodeFrame = (frame: Frame): Uint8Array => {
  if (frame.payload.length > MAX_FRAME) throw new ProtocolError('payload exceeds MAX_FRAME');
  const out = new Uint8Array(HEADER + frame.payload.length);
  new DataView(out.buffer).setUint32(0, frame.payload.length);
  out[4] = frame.kind;
  out.set(frame.payload, HEADER);
  return out;
};

/** Splits a byte stream into frames, however it is chunked; fails for good on bad input. */
export class StreamDecoder {
  private readonly header = new Uint8Array(HEADER);
  private headerFill = 0;
  private kind: FrameKind = FrameKind.control;
  private payload: Uint8Array | null = null;
  private payloadLength = 0;
  private payloadFill = 0;
  private failure: ProtocolError | null = null;

  /** Feeds a chunk and returns every frame it completes. */
  push(chunk: Uint8Array): Frame[] {
    this.check();
    try {
      return this.consume(chunk);
    } catch (error) {
      if (error instanceof ProtocolError) this.failure = error;
      throw error;
    }
  }

  /** Signals end of stream; fails if it ends inside a frame. */
  end(): void {
    this.check();
    if (this.headerFill > 0 || this.payload !== null) {
      this.failure = new ProtocolError('stream ended inside a frame');
      throw this.failure;
    }
  }

  private check(): void {
    if (this.failure !== null) throw new ProtocolError('decoder has failed', { cause: this.failure });
  }

  private consume(chunk: Uint8Array): Frame[] {
    const frames: Frame[] = [];
    let at = 0;
    while (at < chunk.length) {
      let payload = this.payload;
      if (payload === null) {
        const take = Math.min(HEADER - this.headerFill, chunk.length - at);
        this.header.set(chunk.subarray(at, at + take), this.headerFill);
        this.headerFill += take;
        at += take;
        if (this.headerFill < HEADER) break;
        payload = this.startPayload();
      }
      const take = Math.min(this.payloadLength - this.payloadFill, chunk.length - at);
      payload = this.reserve(payload, this.payloadFill + take);
      payload.set(chunk.subarray(at, at + take), this.payloadFill);
      this.payloadFill += take;
      at += take;
      if (this.payloadFill === this.payloadLength) {
        frames.push({ kind: this.kind, payload });
        this.payload = null;
        this.headerFill = 0;
      }
    }
    return frames;
  }

  private startPayload(): Uint8Array {
    const length = new DataView(this.header.buffer).getUint32(0);
    const kind = this.header[4] ?? 0;
    if (length > MAX_FRAME) throw new ProtocolError(`frame of ${String(length)} bytes exceeds MAX_FRAME`);
    if (!isKind(kind)) throw new ProtocolError(`unknown frame kind ${String(kind)}`);
    this.kind = kind;
    this.payload = new Uint8Array(Math.min(length, INITIAL_PAYLOAD));
    this.payloadLength = length;
    this.payloadFill = 0;
    return this.payload;
  }

  /** Grows the payload buffer geometrically, so an announced length costs memory only as bytes arrive. */
  private reserve(payload: Uint8Array, needed: number): Uint8Array {
    if (needed <= payload.length) return payload;
    const grown = new Uint8Array(Math.min(this.payloadLength, Math.max(needed, payload.length * 2)));
    grown.set(payload.subarray(0, this.payloadFill));
    this.payload = grown;
    return grown;
  }
}

/** Encodes a data frame as a stream frame. */
export const encodeStreamData = (frame: DataFrame): Uint8Array => {
  const valid = validData(frame);
  const payload = new Uint8Array(dataHeader(valid) + valid.data.length);
  writeData(payload, 0, valid);
  return encodeFrame({ kind: KIND_OF[valid.kind], payload });
};

/** Decodes the data payload of a stream frame. */
export const decodeStreamData = (frame: Frame): DataFrame => readData(frame.kind, frame.payload, 0);

/** Encodes a data frame as a binary WebSocket message: kind, 2-byte host index, data payload. */
export const encodeWsData = (host: number, frame: DataFrame): Uint8Array => {
  if (!hostIdx.safeParse(host).success) throw new ProtocolError(`invalid host index ${String(host)}`);
  const valid = validData(frame);
  const out = new Uint8Array(WS_HEADER + dataHeader(valid) + valid.data.length);
  out[0] = KIND_OF[valid.kind];
  new DataView(out.buffer).setUint16(1, host);
  writeData(out, WS_HEADER, valid);
  return out;
};

/** Decodes a binary WebSocket message into its host index and data frame. */
export const decodeWsData = (message: Uint8Array): { host: number; frame: DataFrame } => {
  if (message.length < WS_HEADER) throw new ProtocolError('message shorter than its header');
  const kind = message[0] ?? 0;
  if (kind === FrameKind.control || !isKind(kind)) throw new ProtocolError(`invalid data kind ${String(kind)}`);
  const host = new DataView(message.buffer, message.byteOffset, message.byteLength).getUint16(1);
  return { host, frame: readData(kind, message, WS_HEADER) };
};
