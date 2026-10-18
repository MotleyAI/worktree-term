import { describe, expect, it } from 'vitest';
import { keptRemote, pageTitle, readFragment, type PageFragment, type RemotePage } from './page.js';

const CODE = '0123456789abcdef'.repeat(4);
const OTHER = 'f'.repeat(64);

/** An in-memory stand-in for `sessionStorage`. */
const mapStorage = (): Pick<Storage, 'getItem' | 'setItem'> & { items: Map<string, string> } => {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
  };
};

const remoteFragment = (host: string, hubs: string[], code = CODE): PageFragment => ({ kind: 'remote', code, host, home: 7417, hubs });

describe('readFragment', () => {
  it('reads a remote fragment', () => {
    expect(readFragment(`#code=${CODE}&host=box&home=7417&hubs=box,gpu`)).toEqual({
      kind: 'remote',
      code: CODE,
      host: 'box',
      home: 7417,
      hubs: ['box', 'gpu'],
    });
  });

  it.each([
    [`#code=${CODE}`, { code: CODE, hub: null }],
    ['#hub=box', { code: null, hub: 'box' }],
    [`#code=${CODE}&hub=box`, { code: CODE, hub: 'box' }],
  ])('reads %s as a home fragment', (hash, fragment) => {
    expect(readFragment(hash)).toEqual({ kind: 'home', ...fragment });
  });

  it.each(['', '#'])('reads %j as no fragment', (hash) => {
    expect(readFragment(hash)).toEqual({ kind: 'none' });
  });

  it.each([
    '#code=x&hub=a b',
    '#code=x&hub=a%20b',
    '#hub=box&hub=gpu',
    `#token=${CODE}`,
    '#code=x',
    `#code=${CODE}&host=box&hubs=box`,
    `#code=${CODE}&host=box&home=0080&hubs=box`,
    `#code=${CODE}&host=box&home=7417&hubs=gpu`,
  ])('ignores the malformed fragment %s', (hash) => {
    expect(readFragment(hash)).toEqual({ kind: 'none' });
  });
});

describe('keptRemote', () => {
  it('keeps a remote fragment and returns it', () => {
    const storage = mapStorage();
    const kept: RemotePage = { host: 'box', home: 7417, hubs: ['box', 'gpu'] };
    expect(keptRemote(storage, remoteFragment('box', ['box', 'gpu']))).toEqual(kept);
    expect(storage.items.size).toBeGreaterThan(0);
  });

  it('gives the kept values after a reload without a fragment', () => {
    const storage = mapStorage();
    keptRemote(storage, remoteFragment('box', ['box', 'gpu']));
    expect(keptRemote(storage, { kind: 'none' })).toEqual({ host: 'box', home: 7417, hubs: ['box', 'gpu'] });
  });

  it('replaces the kept values with a new remote fragment', () => {
    const storage = mapStorage();
    keptRemote(storage, remoteFragment('box', ['box', 'gpu']));
    expect(keptRemote(storage, remoteFragment('gpu', ['gpu'], OTHER))).toEqual({ host: 'gpu', home: 7417, hubs: ['gpu'] });
    expect(keptRemote(storage, { kind: 'none' })).toEqual({ host: 'gpu', home: 7417, hubs: ['gpu'] });
  });

  it('never keeps the one-time code', () => {
    const storage = mapStorage();
    keptRemote(storage, remoteFragment('box', ['box']));
    expect([...storage.items.values()].join('')).not.toContain(CODE);
  });

  it.each<PageFragment>([{ kind: 'none' }, { kind: 'home', code: CODE, hub: null }, { kind: 'home', code: null, hub: 'box' }])(
    'is a home page for %j with nothing kept',
    (fragment) => {
      expect(keptRemote(mapStorage(), fragment)).toBeNull();
    },
  );

  it('ignores a kept value that does not parse', () => {
    const storage = mapStorage();
    keptRemote(storage, remoteFragment('box', ['box']));
    for (const key of storage.items.keys()) storage.items.set(key, '{"host":"a b","home":1,"hubs":[]}');
    expect(keptRemote(storage, { kind: 'none' })).toBeNull();
    for (const key of storage.items.keys()) storage.items.set(key, 'not json');
    expect(keptRemote(storage, { kind: 'none' })).toBeNull();
  });
});

describe('pageTitle', () => {
  it('titles a home page worktree-term', () => {
    expect(pageTitle(null)).toBe('worktree-term');
  });

  it('titles a remote page by its host', () => {
    expect(pageTitle({ host: 'devbox', home: 7417, hubs: ['devbox'] })).toBe('worktree-term — devbox');
  });
});
