import { describe, expect, it } from 'vitest';
import { hasBanner, hostAction, offeredRepos } from './hosts.js';

describe('hostAction', () => {
  it.each([
    [false, 'outdated', { kind: 'restart', label: 'Restart daemon' }],
    [true, 'outdated', { kind: 'reinstall', label: 'Reinstall & restart' }],
    [true, 'down', { kind: 'reinstall', label: 'Install' }],
    [false, 'down', null],
    [true, 'connected', null],
    [true, 'reconnecting', null],
    [false, 'connecting', null],
  ] as const)('gives a %s host that is %s the action %j', (remote, status, action) => {
    expect(hostAction({ remote, status })).toEqual(action);
  });
});

describe('hasBanner', () => {
  it.each([
    ['down', true],
    ['outdated', true],
    ['connected', false],
    ['connecting', false],
    ['reconnecting', false],
  ] as const)('is %s for a %s host', (status, banner) => {
    expect(hasBanner({ status })).toBe(banner);
  });
});

describe('offeredRepos', () => {
  const discovered = ['/r/alpha', '/r/beta', '/r/betamax'];

  it('offers the discovered repos the host does not list, in order', () => {
    expect(offeredRepos(discovered, ['/r/beta'], '')).toEqual(['/r/alpha', '/r/betamax']);
  });

  it('narrows them to paths containing the filter', () => {
    expect(offeredRepos(discovered, [], 'beta')).toEqual(['/r/beta', '/r/betamax']);
    expect(offeredRepos(discovered, [], 'max')).toEqual(['/r/betamax']);
    expect(offeredRepos(discovered, [], 'zzz')).toEqual([]);
  });
});
