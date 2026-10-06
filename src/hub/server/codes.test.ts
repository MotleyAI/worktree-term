import { describe, expect, it } from 'vitest';
import { CodeStore } from './codes.js';

const clock = (): { now: () => number; advance: (ms: number) => void } => {
  let time = 1_000_000;
  return {
    now: () => time,
    advance: (ms) => {
      time += ms;
    },
  };
};

describe('CodeStore', () => {
  it('issues distinct codes of 64 lowercase hex digits', () => {
    const store = new CodeStore(clock().now);
    const codes = Array.from({ length: 16 }, () => store.issue());
    for (const code of codes) expect(code).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(codes).size).toBe(16);
  });

  it('accepts a code once', () => {
    const store = new CodeStore(clock().now);
    const code = store.issue();
    expect(store.consume(code)).toBe(true);
    expect(store.consume(code)).toBe(false);
  });

  it('checks a code without using it up', () => {
    const store = new CodeStore(clock().now);
    const code = store.issue();
    expect(store.valid(code)).toBe(true);
    expect(store.consume(code)).toBe(true);
    expect(store.valid(code)).toBe(false);
  });

  it('reports an expired code as invalid', () => {
    const time = clock();
    const store = new CodeStore(time.now);
    const code = store.issue();
    time.advance(30_001);
    expect(store.valid(code)).toBe(false);
  });

  it('refuses a code it never issued', () => {
    const store = new CodeStore(clock().now);
    store.issue();
    expect(store.consume('a'.repeat(64))).toBe(false);
    expect(store.consume('')).toBe(false);
  });

  it('accepts a code just within 30 s of its issue', () => {
    const time = clock();
    const store = new CodeStore(time.now);
    const code = store.issue();
    time.advance(29_999);
    expect(store.consume(code)).toBe(true);
  });

  it('refuses a code more than 30 s after its issue', () => {
    const time = clock();
    const store = new CodeStore(time.now);
    const code = store.issue();
    time.advance(30_001);
    expect(store.consume(code)).toBe(false);
  });

  it('keeps at most 16 codes outstanding, dropping the oldest', () => {
    const store = new CodeStore(clock().now);
    const codes = Array.from({ length: 17 }, () => store.issue());
    expect(store.consume(codes[0] ?? '')).toBe(false);
    for (const code of codes.slice(1)) expect(store.consume(code)).toBe(true);
  });

  it('does not count used codes as outstanding', () => {
    const store = new CodeStore(clock().now);
    const first = store.issue();
    expect(store.consume(first)).toBe(true);
    const codes = Array.from({ length: 16 }, () => store.issue());
    for (const code of codes) expect(store.consume(code)).toBe(true);
  });
});
