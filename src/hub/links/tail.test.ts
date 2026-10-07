import { describe, expect, it } from 'vitest';
import { StderrTail } from './tail.js';

const encoder = new TextEncoder();
const bytes = (text: string): Uint8Array => encoder.encode(text);

const tailOf = (...chunks: (string | Uint8Array)[]): StderrTail => {
  const tail = new StderrTail();
  for (const chunk of chunks) tail.push(typeof chunk === 'string' ? bytes(chunk) : chunk);
  return tail;
};

describe('StderrTail', () => {
  it('has no reason before any output', () => {
    expect(tailOf().reason()).toBeNull();
  });

  it('gives the last non-empty line', () => {
    expect(tailOf('Warning: Permanently added box\nssh: Could not resolve hostname box\n\n').reason()).toBe(
      'ssh: Could not resolve hostname box',
    );
  });

  it('gives an unterminated last line', () => {
    expect(tailOf('first\nlast without newline').reason()).toBe('last without newline');
  });

  it('joins a line split across chunks, including inside a multi-byte character', () => {
    const line = bytes('ssh: résolution impossible\n');
    const split = line.indexOf(0xc3) + 1;
    expect(tailOf(line.subarray(0, split), line.subarray(split)).reason()).toBe('ssh: résolution impossible');
  });

  it('removes control characters', () => {
    expect(tailOf('ssh:\u0007 conn\u001bection\r refused\u007f\r\n').reason()).toBe('ssh: connection refused');
  });

  it('has no reason when every line is empty or only control characters', () => {
    expect(tailOf('\n\r\n\u0007\n').reason()).toBeNull();
  });

  it('decodes invalid UTF-8 without failing', () => {
    const reason = tailOf(Uint8Array.from([0x73, 0x73, 0x68, 0xff, 0xfe, 0x3a, 0x20, 0x78, 0x0a])).reason();
    expect(reason).toMatch(/^ssh.*: x$/);
  });

  it('cuts the reason to 1024 characters', () => {
    expect(tailOf('x'.repeat(3000)).reason()).toHaveLength(1024);
  });

  it('keeps at most 4 KiB however much is written', () => {
    const tail = new StderrTail();
    const chunk = bytes('y'.repeat(64 * 1024));
    for (let i = 0; i < 128; i++) tail.push(chunk);
    expect(tail.size).toBeLessThanOrEqual(4096);
    const reason = tail.reason();
    expect(reason).toMatch(/^y+$/);
    expect(reason?.length).toBeLessThanOrEqual(1024);
  });

  it('gives the latest line after a long burst', () => {
    expect(tailOf('z'.repeat(100_000), '\nssh: Connection timed out\n').reason()).toBe('ssh: Connection timed out');
  });
});
