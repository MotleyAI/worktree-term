import { describe, expect, it } from 'vitest';
import { ACK_EVERY, FLOW_HIGH, FLOW_LOW, LAG_EVICT_MS, MAX_FRAME, MAX_INPUT, PROTOCOL_VERSION } from './index.js';

describe('shared constants', () => {
  it('hold their specified values', () => {
    expect({ PROTOCOL_VERSION, MAX_FRAME, MAX_INPUT, FLOW_HIGH, FLOW_LOW, ACK_EVERY, LAG_EVICT_MS }).toEqual({
      PROTOCOL_VERSION: 1,
      MAX_FRAME: 16 * 1024 * 1024,
      MAX_INPUT: 64 * 1024,
      FLOW_HIGH: 512 * 1024,
      FLOW_LOW: 128 * 1024,
      ACK_EVERY: 64 * 1024,
      LAG_EVICT_MS: 2000,
    });
  });
});
