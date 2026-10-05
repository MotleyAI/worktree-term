import { describe, expect, it } from 'vitest';
import {
  decodeMessage,
  decodeStreamData,
  decodeWsData,
  encodeFrame,
  encodeMessage,
  encodeStreamData,
  encodeWsData,
  FrameKind,
  MAX_FRAME,
  MAX_INPUT,
  ProtocolError,
  StreamDecoder,
  type DataFrame,
  type Frame,
} from './index.js';
import { DIRECTIONS, samples, utf8 } from './test-samples.js';

const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

/** A stream frame built by hand: 4-byte big-endian length, kind, payload. */
const rawFrame = (kind: number, payload: Uint8Array): Uint8Array => {
  const header = new Uint8Array(5);
  new DataView(header.buffer).setUint32(0, payload.length);
  header[4] = kind;
  return concat(header, payload);
};

const u32 = (n: number): Uint8Array => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
};

const u64 = (n: bigint): Uint8Array => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n);
  return b;
};

const u16 = (n: number): Uint8Array => {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n);
  return b;
};

const single = (bytes: Uint8Array): Frame => {
  const decoder = new StreamDecoder();
  const frames = decoder.push(bytes);
  decoder.end();
  expect(frames).toHaveLength(1);
  const [frame] = frames;
  if (frame === undefined) throw new Error('no frame decoded');
  return frame;
};

const TWO_40 = 2 ** 40;
const DATA = Uint8Array.of(1, 2, 3);

const output: DataFrame = { kind: 'output', termId: 7, offset: TWO_40, data: DATA };
const snapshot: DataFrame = {
  kind: 'snapshot',
  termId: 4294967295,
  offset: Number.MAX_SAFE_INTEGER,
  data: new Uint8Array(70_000).fill(65),
};
const input: DataFrame = { kind: 'input', termId: 1, data: utf8('ab') };

describe('stream framing', () => {
  it('lays out length, kind and payload big-endian', () => {
    expect(hex(encodeFrame({ kind: FrameKind.control, payload: utf8('{}') }))).toBe('00000002007b7d');
  });

  it('numbers the kinds control 0, output 1, snapshot 2, input 3', () => {
    expect(FrameKind).toEqual({ control: 0, output: 1, snapshot: 2, input: 3 });
  });

  const three: Frame[] = [
    { kind: FrameKind.control, payload: utf8('{"t":"shutdown"}') },
    { kind: FrameKind.output, payload: concat(u32(7), u64(5n), DATA) },
    { kind: FrameKind.input, payload: concat(u32(7), utf8('x')) },
  ];
  const stream = concat(...three.map(encodeFrame));

  it('yields the same frames for one-byte chunks and for one chunk', () => {
    const bytewise = new StreamDecoder();
    const got: Frame[] = [];
    for (const byte of stream) got.push(...bytewise.push(Uint8Array.of(byte)));
    bytewise.end();

    const whole = new StreamDecoder();
    const all = whole.push(stream);
    whole.end();

    expect(got).toEqual(three);
    expect(all).toEqual(three);
  });

  it('yields the same frames for every two-chunk split', () => {
    for (let cut = 0; cut <= stream.length; cut++) {
      const decoder = new StreamDecoder();
      const got = [...decoder.push(stream.subarray(0, cut)), ...decoder.push(stream.subarray(cut))];
      decoder.end();
      expect(got).toEqual(three);
    }
  });

  it('yields nothing for an empty chunk', () => {
    expect(new StreamDecoder().push(new Uint8Array(0))).toEqual([]);
  });

  it('passes an empty payload through', () => {
    expect(single(rawFrame(0, new Uint8Array(0)))).toEqual({ kind: 0, payload: new Uint8Array(0) });
  });

  it('fails on a header announcing MAX_FRAME + 1 bytes before the payload arrives', () => {
    const decoder = new StreamDecoder();
    const header = concat(u32(MAX_FRAME + 1), Uint8Array.of(1));
    expect(() => decoder.push(header)).toThrow(ProtocolError);
  });

  it('accepts a header announcing exactly MAX_FRAME bytes', () => {
    const decoder = new StreamDecoder();
    expect(decoder.push(concat(u32(MAX_FRAME), Uint8Array.of(1)))).toEqual([]);
  });

  it('does not reserve an announced payload before its bytes arrive', () => {
    const before = process.memoryUsage().arrayBuffers;
    const decoders = Array.from({ length: 8 }, () => new StreamDecoder());
    for (const decoder of decoders) decoder.push(concat(u32(MAX_FRAME), Uint8Array.of(1)));
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(MAX_FRAME);
  });

  it('assembles a large payload from small chunks', () => {
    const payload = Uint8Array.from({ length: 200_000 }, (_, i) => i % 251);
    const bytes = rawFrame(2, payload);
    const decoder = new StreamDecoder();
    const got: Frame[] = [];
    for (let at = 0; at < bytes.length; at += 1000) got.push(...decoder.push(bytes.subarray(at, at + 1000)));
    decoder.end();
    expect(got).toEqual([{ kind: 2, payload }]);
  });

  it('fails on an unknown kind', () => {
    const decoder = new StreamDecoder();
    const bytes = rawFrame(4, utf8('{}'));
    expect(() => decoder.push(bytes)).toThrow(ProtocolError);
  });

  it('fails at end of stream after half a payload', () => {
    const full = rawFrame(0, utf8('{"t":"shutdown"}'));
    const decoder = new StreamDecoder();
    expect(decoder.push(full.subarray(0, 5 + 8))).toEqual([]);
    expect(() => {
      decoder.end();
    }).toThrow(ProtocolError);
  });

  it('fails at end of stream after a partial header', () => {
    const decoder = new StreamDecoder();
    decoder.push(Uint8Array.of(0, 0, 0));
    expect(() => {
      decoder.end();
    }).toThrow(ProtocolError);
  });

  it('ends cleanly on a frame boundary', () => {
    const decoder = new StreamDecoder();
    decoder.push(rawFrame(0, utf8('{}')));
    expect(() => {
      decoder.end();
    }).not.toThrow();
  });

  it('stays failed once it has failed', () => {
    const decoder = new StreamDecoder();
    const bad = rawFrame(9, utf8('{}'));
    const good = rawFrame(0, utf8('{}'));
    expect(() => decoder.push(bad)).toThrow(ProtocolError);
    expect(() => decoder.push(good)).toThrow(ProtocolError);
    expect(() => {
      decoder.end();
    }).toThrow(ProtocolError);
  });

  it('refuses to encode a payload over MAX_FRAME', () => {
    const payload = new Uint8Array(MAX_FRAME + 1);
    expect(() => encodeFrame({ kind: FrameKind.snapshot, payload })).toThrow(ProtocolError);
  });
});

describe('data frames on a stream', () => {
  it('lays out an output frame as id, offset and bytes', () => {
    expect(hex(encodeStreamData(output))).toBe('0000000f' + '01' + '00000007' + '0000010000000000' + '010203');
  });

  it('lays out a snapshot frame like an output frame', () => {
    const frame: DataFrame = { kind: 'snapshot', termId: 7, offset: TWO_40, data: DATA };
    expect(hex(encodeStreamData(frame))).toBe('0000000f' + '02' + '00000007' + '0000010000000000' + '010203');
  });

  it('lays out an input frame as id and bytes', () => {
    expect(hex(encodeStreamData({ kind: 'input', termId: 7, data: utf8('ab') }))).toBe('00000006' + '03' + '00000007' + '6162');
  });

  it.each([output, snapshot, input])('round-trips a $kind frame', (frame) => {
    expect(decodeStreamData(single(encodeStreamData(frame)))).toEqual(frame);
  });

  it('rejects an offset of 2^53', () => {
    const frame = single(rawFrame(1, concat(u32(7), u64(2n ** 53n), DATA)));
    expect(() => decodeStreamData(frame)).toThrow(ProtocolError);
    expect(() => encodeStreamData({ ...output, offset: 2 ** 53 })).toThrow(ProtocolError);
  });

  it('rejects terminal id 0', () => {
    const frame = single(rawFrame(3, concat(u32(0), DATA)));
    expect(() => decodeStreamData(frame)).toThrow(ProtocolError);
    expect(() => encodeStreamData({ ...input, termId: 0 })).toThrow(ProtocolError);
  });

  it('accepts MAX_INPUT input bytes and refuses one more', () => {
    const max = new Uint8Array(MAX_INPUT);
    expect(decodeStreamData(single(encodeStreamData({ kind: 'input', termId: 1, data: max })))).toEqual({
      kind: 'input',
      termId: 1,
      data: max,
    });
    const data = new Uint8Array(MAX_INPUT + 1);
    expect(() => encodeStreamData({ kind: 'input', termId: 1, data })).toThrow(ProtocolError);
    const tooLong = single(rawFrame(3, concat(u32(1), new Uint8Array(MAX_INPUT + 1))));
    expect(() => decodeStreamData(tooLong)).toThrow(ProtocolError);
  });

  it.each([
    ['a control frame', rawFrame(0, utf8('{}'))],
    ['an output payload shorter than its header', rawFrame(1, concat(u32(7), Uint8Array.of(0, 0, 0)))],
    ['an input payload shorter than its id', rawFrame(3, Uint8Array.of(0, 0, 7))],
  ])('rejects %s as a data frame', (_name, bytes) => {
    const frame = single(bytes);
    expect(() => decodeStreamData(frame)).toThrow(ProtocolError);
  });
});

describe('data frames on a WebSocket', () => {
  it('lays out an output message as kind, host, id, offset and bytes', () => {
    expect(hex(encodeWsData(2, output))).toBe('01' + '0002' + '00000007' + '0000010000000000' + '010203');
  });

  it('lays out an input message as kind, host, id and bytes', () => {
    expect(hex(encodeWsData(2, { kind: 'input', termId: 7, data: utf8('ab') }))).toBe('03' + '0002' + '00000007' + '6162');
  });

  it('decodes an output frame with its host', () => {
    expect(decodeWsData(encodeWsData(2, output))).toEqual({ host: 2, frame: output });
  });

  it.each([output, snapshot, input])('round-trips a $kind frame', (frame) => {
    expect(decodeWsData(encodeWsData(65535, frame))).toEqual({ host: 65535, frame });
  });

  it('rejects an offset of 2^53', () => {
    const bytes = concat(Uint8Array.of(1), u16(0), u32(7), u64(2n ** 53n), DATA);
    expect(() => decodeWsData(bytes)).toThrow(ProtocolError);
    expect(() => encodeWsData(0, { ...output, offset: 2 ** 53 })).toThrow(ProtocolError);
  });

  it('rejects terminal id 0', () => {
    const bytes = concat(Uint8Array.of(3), u16(0), u32(0), DATA);
    expect(() => decodeWsData(bytes)).toThrow(ProtocolError);
    expect(() => encodeWsData(0, { ...output, termId: 0 })).toThrow(ProtocolError);
  });

  it('refuses MAX_INPUT + 1 input bytes', () => {
    const data = new Uint8Array(MAX_INPUT + 1);
    const bytes = concat(Uint8Array.of(3), u16(0), u32(1), data);
    expect(() => encodeWsData(0, { kind: 'input', termId: 1, data })).toThrow(ProtocolError);
    expect(() => decodeWsData(bytes)).toThrow(ProtocolError);
  });

  it.each([-1, 65536, 1.5])('refuses host index %d', (host) => {
    expect(() => encodeWsData(host, output)).toThrow(ProtocolError);
  });

  it.each([
    ['kind 0', concat(Uint8Array.of(0), u16(0), u32(7), DATA)],
    ['kind 4', concat(Uint8Array.of(4), u16(0), u32(7), DATA)],
    ['a message shorter than its header', concat(Uint8Array.of(1), u16(0), u32(7), Uint8Array.of(0))],
    ['an empty message', new Uint8Array(0)],
  ])('rejects %s', (_name, bytes) => {
    expect(() => decodeWsData(bytes)).toThrow(ProtocolError);
  });
});

describe('cross-transport equivalence', () => {
  it.each(DIRECTIONS)('every %s control message decodes identically from a stream frame and from text', (dir) => {
    for (const message of samples[dir]) {
      const text = encodeMessage(dir, message);
      const frame = single(encodeFrame({ kind: FrameKind.control, payload: utf8(text) }));
      expect(frame.kind).toBe(FrameKind.control);
      expect(decodeMessage(dir, frame.payload)).toEqual(decodeMessage(dir, text));
    }
  });

  it.each([output, snapshot, input])('a $kind frame decodes identically on both transports', (frame) => {
    const viaStream = decodeStreamData(single(encodeStreamData(frame)));
    const viaWs = decodeWsData(encodeWsData(3, frame)).frame;
    expect(viaStream).toEqual(viaWs);
    expect(viaStream).toEqual(frame);
  });
});
