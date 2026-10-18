import { describe, expect, it } from 'vitest';
import {
  decodeHomeFragment,
  decodePrintCode,
  decodeRemoteFragment,
  encodeHomeFragment,
  encodePrintCode,
  encodeRemoteFragment,
  ProtocolError,
} from './index.js';
import { CODE, raw, utf8 } from './test-samples.js';

const names = (n: number): string[] => Array.from({ length: n }, (_, i) => `h${String(i)}`);

describe('print-code line', () => {
  it('round-trips through text and bytes, ending with exactly one newline', () => {
    const line = { port: 7417, code: CODE };
    const text = encodePrintCode(line);
    expect(text).toBe(`${raw(line)}\n`);
    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
    expect(decodePrintCode(text)).toEqual(line);
    expect(decodePrintCode(utf8(text))).toEqual(line);
  });

  it.each([
    ['no newline', raw({ port: 7417, code: CODE })],
    ['trailing whitespace', `${raw({ port: 7417, code: CODE })}\n \n\t`],
    ['the fields in another order', `${raw({ code: CODE, port: 7417 })}\n`],
  ])('decodes a line with %s', (_name, text) => {
    expect(decodePrintCode(text)).toEqual({ port: 7417, code: CODE });
  });

  it.each([1024, 65535])('accepts port %i', (port) => {
    expect(decodePrintCode(`${raw({ port, code: CODE })}\n`)).toEqual({ port, code: CODE });
  });

  it.each([
    ['an extra token field', `${raw({ port: 7417, code: CODE, token: CODE })}\n`],
    ['a leading motd line', `motd\n${raw({ port: 7417, code: CODE })}\n`],
    ['a second line', `${raw({ port: 7417, code: CODE })}\n${raw({ port: 7417, code: CODE })}\n`],
    ['leading whitespace text', `x ${raw({ port: 7417, code: CODE })}\n`],
    ['port 80', `${raw({ port: 80, code: CODE })}\n`],
    ['port 1023', `${raw({ port: 1023, code: CODE })}\n`],
    ['port 65536', `${raw({ port: 65536, code: CODE })}\n`],
    ['port 7417.5', `${raw({ port: 7417.5, code: CODE })}\n`],
    ['a string port', `${raw({ port: '7417', code: CODE })}\n`],
    ['a malformed code', `${raw({ port: 7417, code: 'x' })}\n`],
    ['an uppercase code', `${raw({ port: 7417, code: CODE.toUpperCase() })}\n`],
    ['no code', `${raw({ port: 7417 })}\n`],
    ['an array', `${raw([7417, CODE])}\n`],
    ['invalid JSON', '{"port":7417,\n'],
    ['nothing', ''],
  ])('rejects a line with %s', (_name, text) => {
    expect(() => decodePrintCode(text)).toThrow(ProtocolError);
  });

  it('rejects invalid UTF-8', () => {
    expect(() => decodePrintCode(new Uint8Array([0xff, 0x0a]))).toThrow(ProtocolError);
  });

  it('refuses to encode a value that would not decode', () => {
    expect(() => encodePrintCode({ port: 80, code: CODE })).toThrow(ProtocolError);
    expect(() => encodePrintCode({ port: 7417, code: 'x' })).toThrow(ProtocolError);
  });
});

describe('home fragment', () => {
  it.each([
    [`code=${CODE}`, { code: CODE, hub: null }],
    ['hub=box', { code: null, hub: 'box' }],
    [`code=${CODE}&hub=box`, { code: CODE, hub: 'box' }],
    [`hub=box&code=${CODE}`, { code: CODE, hub: 'box' }],
    [`hub=${'A-z.9_'.repeat(10)}abcd`, { code: null, hub: `${'A-z.9_'.repeat(10)}abcd` }],
  ])('decodes %s', (text, value) => {
    expect(decodeHomeFragment(text)).toEqual(value);
  });

  it.each([
    [{ code: CODE, hub: null }, `code=${CODE}`],
    [{ code: null, hub: 'box' }, 'hub=box'],
    [{ code: CODE, hub: 'box' }, `code=${CODE}&hub=box`],
  ])('encodes %o as %s', (value, text) => {
    expect(encodeHomeFragment(value)).toBe(text);
    expect(decodeHomeFragment(text)).toEqual(value);
  });

  it.each([
    ['a name with a space', 'hub=a b'],
    ['an encoded space', 'hub=a%20b'],
    ['a plus', 'hub=a+b'],
    ['a repeated hub', 'hub=box&hub=gpu'],
    ['a repeated code', `code=${CODE}&code=${CODE}`],
    ['a malformed code', 'code=x'],
    ['a malformed code beside a hub', 'code=x&hub=a b'],
    ['an empty hub', 'hub='],
    ['a 65-character hub', `hub=${'x'.repeat(65)}`],
    ['another parameter', 'hub=box&token=x'],
    ['only another parameter', 'token=x'],
    ['a parameter without value', 'hub'],
    ['nothing', ''],
    ['a leading #', '#hub=box'],
  ])('rejects %s', (_name, text) => {
    expect(() => decodeHomeFragment(text)).toThrow(ProtocolError);
  });

  it('refuses to encode an empty fragment or a malformed value', () => {
    expect(() => encodeHomeFragment({ code: null, hub: null })).toThrow(ProtocolError);
    expect(() => encodeHomeFragment({ code: null, hub: 'a b' })).toThrow(ProtocolError);
  });
});

describe('remote fragment', () => {
  const TEXT = `code=${CODE}&host=box&home=7417&hubs=box,gpu`;
  const VALUE = { code: CODE, host: 'box', home: 7417, hubs: ['box', 'gpu'] };

  it('decodes the code, host, home port and hubs in order', () => {
    expect(decodeRemoteFragment(TEXT)).toEqual(VALUE);
  });

  it('encodes to the canonical text with literal commas', () => {
    expect(encodeRemoteFragment(VALUE)).toBe(TEXT);
  });

  it.each([
    ['parameters in another order', `hubs=box,gpu&home=7417&host=box&code=${CODE}`],
    ['an encoded comma', `code=${CODE}&host=box&home=7417&hubs=box%2Cgpu`],
  ])('decodes %s', (_name, text) => {
    expect(decodeRemoteFragment(text)).toEqual(VALUE);
  });

  it('accepts 63 hubs and home ports 1024 and 65535', () => {
    const hubs = names(63);
    for (const home of [1024, 65535]) {
      const value = { code: CODE, host: 'h62', home, hubs };
      expect(decodeRemoteFragment(encodeRemoteFragment(value))).toEqual(value);
    }
  });

  it.each([
    ['no home', `code=${CODE}&host=box&hubs=box`],
    ['no code', 'host=box&home=7417&hubs=box'],
    ['no host', `code=${CODE}&home=7417&hubs=box`],
    ['no hubs', `code=${CODE}&host=box&home=7417`],
    ['home 0080', `code=${CODE}&host=box&home=0080&hubs=box`],
    ['home 07417', `code=${CODE}&host=box&home=07417&hubs=box`],
    ['home 80', `code=${CODE}&host=box&home=80&hubs=box`],
    ['home 65536', `code=${CODE}&host=box&home=65536&hubs=box`],
    ['home 7417.5', `code=${CODE}&host=box&home=7417.5&hubs=box`],
    ['hubs not naming the host', `code=${CODE}&host=box&home=7417&hubs=gpu`],
    ['duplicate hubs', `code=${CODE}&host=box&home=7417&hubs=box,box`],
    ['an empty hub name', `code=${CODE}&host=box&home=7417&hubs=box,`],
    ['64 hubs', `code=${CODE}&host=h0&home=7417&hubs=${names(64).join(',')}`],
    ['an empty host', `code=${CODE}&host=&home=7417&hubs=box`],
    ['a host with a space', `code=${CODE}&host=a b&home=7417&hubs=a b`],
    ['a malformed code', 'code=x&host=box&home=7417&hubs=box'],
    ['an extra token parameter', `code=${CODE}&host=box&home=7417&hubs=box&token=${CODE}`],
    ['a repeated host', `code=${CODE}&host=box&host=box&home=7417&hubs=box`],
    ['a home fragment', `code=${CODE}&hub=box`],
    ['nothing', ''],
  ])('rejects a fragment with %s', (_name, text) => {
    expect(() => decodeRemoteFragment(text)).toThrow(ProtocolError);
  });

  it('refuses to encode a value that would not decode', () => {
    expect(() => encodeRemoteFragment({ ...VALUE, hubs: ['gpu'] })).toThrow(ProtocolError);
    expect(() => encodeRemoteFragment({ ...VALUE, home: 80 })).toThrow(ProtocolError);
  });
});
