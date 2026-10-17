import { describe, expect, it } from 'vitest';
import { LineScanner, tailscaleLoginUrl } from './index.js';

const URL = 'https://login.tailscale.com/a/abc123';
const encoder = new TextEncoder();
const bytes = (text: string): Uint8Array => encoder.encode(text);

describe('tailscaleLoginUrl', () => {
  it.each([
    ['the banner line', `# To authenticate, visit: ${URL}`],
    ['the line without its # prefix', `To authenticate, visit: ${URL}`],
    ['a CRLF-terminated line', `# To authenticate, visit: ${URL}\r`],
    ['a line with surrounding blanks', `   # To authenticate, visit:   ${URL}   `],
    ['a line with control characters', `\u0007# To authenticate, visit: https://login.tailscale.com/a/abc\u001b123\r`],
  ])('gives the URL of %s', (_name, line) => {
    expect(tailscaleLoginUrl(line)).toBe(URL);
  });

  it('accepts a URL of exactly 1024 characters', () => {
    const long = 'https://login.tailscale.com/a/' + 'x'.repeat(1024 - 'https://login.tailscale.com/a/'.length);
    expect(tailscaleLoginUrl(`# To authenticate, visit: ${long}`)).toBe(long);
  });

  it.each([
    ['another host', '# To authenticate, visit: https://example.com/a/abc123'],
    ['plain http', '# To authenticate, visit: http://login.tailscale.com/a/abc123'],
    ['a lookalike host', '# To authenticate, visit: https://login.tailscale.com.evil/a/x'],
    ['a host without the trailing slash', '# To authenticate, visit: https://login.tailscale.com'],
    ['a javascript: URL', '# To authenticate, visit: javascript:alert(1)'],
    ['an upper-case scheme', '# To authenticate, visit: HTTPS://login.tailscale.com/a/abc123'],
    ['no URL', '# To authenticate, visit:'],
    ['the first banner line', '# Tailscale SSH requires an additional check.'],
    ['a Tailscale URL without the phrase', `# See ${URL}`],
    ['an empty line', ''],
  ])('gives null for %s', (_name, line) => {
    expect(tailscaleLoginUrl(line)).toBeNull();
  });

  it('gives null for a URL over 1024 characters', () => {
    const long = 'https://login.tailscale.com/a/' + 'x'.repeat(1025 - 'https://login.tailscale.com/a/'.length);
    expect(tailscaleLoginUrl(`# To authenticate, visit: ${long}`)).toBeNull();
  });
});

describe('LineScanner', () => {
  it('yields each complete line without its newline', () => {
    expect(new LineScanner().push(bytes('one\ntwo\n'))).toEqual(['one', 'two']);
  });

  it('holds a partial line until its newline arrives', () => {
    const scanner = new LineScanner();
    expect(scanner.push(bytes('# To authenticate, vi'))).toEqual([]);
    expect(scanner.push(bytes(`sit: ${URL}\nnext`))).toEqual([`# To authenticate, visit: ${URL}`]);
    expect(scanner.push(bytes('\n'))).toEqual(['next']);
  });

  it('joins a line split inside a multi-byte character', () => {
    const line = bytes('résumé\n');
    const split = line.indexOf(0xc3) + 1;
    const scanner = new LineScanner();
    expect(scanner.push(line.subarray(0, split))).toEqual([]);
    expect(scanner.push(line.subarray(split))).toEqual(['résumé']);
  });

  it('holds at most 4 KiB of a line without a newline', () => {
    const scanner = new LineScanner();
    for (let i = 0; i < 64; i++) expect(scanner.push(bytes('x'.repeat(1024)))).toEqual([]);
    expect(scanner.size).toBeLessThanOrEqual(4096);
    const [line] = scanner.push(bytes('\n'));
    expect(line?.length ?? 0).toBeLessThanOrEqual(4096);
  });

  it('yields a whole line again after a capped one', () => {
    const scanner = new LineScanner();
    scanner.push(bytes('y'.repeat(10_000)));
    expect(scanner.push(bytes(`\n# To authenticate, visit: ${URL}\n`)).at(-1)).toBe(`# To authenticate, visit: ${URL}`);
  });
});
