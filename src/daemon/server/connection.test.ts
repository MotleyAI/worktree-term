import { beforeEach, describe, expect, it } from 'vitest';
import { encodeStreamData, FrameKind, PROTOCOL_VERSION, StreamDecoder, type Frame } from '../../protocol/index.js';
import { ConnectionGate } from './connection.js';

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

const control = (value: unknown): Frame => ({ kind: FrameKind.control, payload: text(JSON.stringify(value)) });

/** A data frame as a peer would put it on the stream. */
const data = (frame: Parameters<typeof encodeStreamData>[0]): Frame => {
  const [decoded] = new StreamDecoder().push(encodeStreamData(frame));
  if (decoded === undefined) throw new Error('no frame');
  return decoded;
};

const hello = (protocol: number): Frame => control({ t: 'hello', protocol, version: '9.9.9', instance: 'client_1' });
const watch = control({ t: 'watchRepo', req: 1, repo: '/r' });
const shutdown = control({ t: 'shutdown' });
const input = data({ kind: 'input', termId: 3, data: text('ls\r') });
const output = data({ kind: 'output', termId: 3, offset: 0, data: text('x') });
const snapshot = data({ kind: 'snapshot', termId: 3, offset: 0, data: text('x') });
const extraField = control({ t: 'attach', req: 1, termId: 1, x: 1 });
const badJson: Frame = { kind: FrameKind.control, payload: text('{"t":') };
const shortInput: Frame = { kind: FrameKind.input, payload: new Uint8Array([0, 0]) };

const badMessage = { kind: 'reject', code: 'bad-message', close: true } as const;
const mismatch = { kind: 'reject', code: 'version-mismatch', close: false } as const;

let gate: ConnectionGate;

beforeEach(() => {
  gate = new ConnectionGate();
});

describe('before hello', () => {
  it('accepts a hello of this protocol version', () => {
    expect(gate.receive(hello(PROTOCOL_VERSION))).toEqual({ kind: 'hello' });
    expect(gate.state).toBe('ready');
  });

  it.each([
    ['a request', watch],
    ['shutdown', shutdown],
    ['an undecodable control frame', badJson],
    ['an input frame', input],
    ['an output frame', output],
  ])('rejects %s as the first frame and closes', (_name, frame) => {
    expect(gate.receive(frame)).toEqual(badMessage);
  });

  it('rejects a broken stream and closes', () => {
    expect(gate.streamFailed()).toEqual(badMessage);
  });
});

describe('after a matching hello', () => {
  beforeEach(() => {
    gate.receive(hello(PROTOCOL_VERSION));
  });

  it('delivers requests decoded', () => {
    expect(gate.receive(watch)).toEqual({ kind: 'request', message: { t: 'watchRepo', req: 1, repo: '/r' } });
  });

  it('delivers input frames', () => {
    expect(gate.receive(input)).toEqual({ kind: 'input', termId: 3, data: text('ls\r') });
  });

  it('delivers shutdown', () => {
    expect(gate.receive(shutdown)).toEqual({ kind: 'shutdown' });
  });

  it.each([
    ['a second hello', hello(PROTOCOL_VERSION)],
    ['a control message with an extra field', extraField],
    ['invalid JSON', badJson],
    ['a daemon-to-client message', control({ t: 'done', req: 1 })],
    ['an output frame', output],
    ['a snapshot frame', snapshot],
    ['an input frame shorter than its header', shortInput],
  ])('rejects %s and closes', (_name, frame) => {
    expect(gate.receive(frame)).toEqual(badMessage);
  });

  it('rejects a broken stream and closes', () => {
    expect(gate.streamFailed()).toEqual(badMessage);
  });
});

describe('after a mismatched hello', () => {
  it.each([1, PROTOCOL_VERSION + 5])('enters mismatched mode for protocol %i', (protocol) => {
    expect(gate.receive(hello(protocol))).toEqual({ kind: 'hello' });
    expect(gate.state).toBe('mismatched');
  });

  describe('in mismatched mode', () => {
    beforeEach(() => {
      gate.receive(hello(1));
    });

    it('accepts the frozen shutdown', () => {
      expect(gate.receive(shutdown)).toEqual({ kind: 'shutdown' });
    });

    it.each([
      ['a request', watch],
      ['a second hello', hello(1)],
      ['a matching hello', hello(PROTOCOL_VERSION)],
      ['invalid JSON', badJson],
      ['a control message with an extra field', extraField],
      ['an input frame', input],
      ['an output frame', output],
      ['a malformed input frame', shortInput],
    ])('answers %s with version-mismatch and stays open', (_name, frame) => {
      expect(gate.receive(frame)).toEqual(mismatch);
      expect(gate.state).toBe('mismatched');
    });

    it('closes on a broken stream', () => {
      expect(gate.streamFailed()).toEqual({ kind: 'reject', code: 'version-mismatch', close: true });
    });
  });
});
