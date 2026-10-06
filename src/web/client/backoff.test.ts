import { describe, expect, it } from 'vitest';
import { reconnectDelay } from './backoff.js';

describe('reconnectDelay', () => {
  it.each([
    [1, 250],
    [2, 500],
    [3, 1000],
    [4, 2000],
    [5, 4000],
    [6, 5000],
    [7, 5000],
    [100, 5000],
  ])('waits after attempt %d for %d ms', (attempt, delay) => {
    expect(reconnectDelay(attempt)).toBe(delay);
  });
});
