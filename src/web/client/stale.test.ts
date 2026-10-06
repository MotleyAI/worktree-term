import { describe, expect, it } from 'vitest';
import { checkBundle } from './stale.js';

const page = { protocol: 3, version: '0.1.0' };
const hub = { protocol: 3, version: '0.1.0', instance: 'hub_A' };

describe('checkBundle', () => {
  it('keeps a bundle matching the hub', () => {
    expect(checkBundle(page, hub, null)).toBe('current');
    expect(checkBundle(page, hub, 'hub_A')).toBe('current');
  });

  it.each([
    ['version', { ...hub, version: '0.2.0' }],
    ['protocol', { ...hub, protocol: 4 }],
  ])('reloads once for a hub of another %s', (_name, other) => {
    expect(checkBundle(page, other, null)).toBe('reload');
    expect(checkBundle(page, other, 'hub_old')).toBe('reload');
  });

  it('reports the bundle outdated when it still differs after reloading for that hub', () => {
    expect(checkBundle(page, { ...hub, version: '0.2.0' }, 'hub_A')).toBe('outdated');
  });
});
