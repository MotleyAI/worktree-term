import { describe, expect, it } from 'vitest';
import { WEBGL_LIMIT, WebglLru } from './webgl-lru.js';

class FakeAddon {
  disposed = 0;

  constructor(readonly key: number) {}

  dispose(): void {
    this.disposed++;
  }
}

/** A factory recording every addon it creates; `fail` makes creation throw for those keys. */
const factory = (fail: ReadonlySet<number> = new Set()) => {
  const created: FakeAddon[] = [];
  const create = (key: number): FakeAddon => {
    if (fail.has(key)) throw new Error('WebGL unavailable');
    const addon = new FakeAddon(key);
    created.push(addon);
    return addon;
  };
  return { created, create };
};

/** Asserts the budget and that exactly the live entries hold undisposed addons. */
const expectConsistent = (lru: WebglLru<number, FakeAddon>, created: readonly FakeAddon[]): void => {
  const live = created.filter((a) => a.disposed === 0);
  expect(lru.webglKeys().length).toBeLessThanOrEqual(WEBGL_LIMIT);
  expect(live.map((a) => a.key).sort((a, b) => a - b)).toEqual([...lru.webglKeys()].sort((a, b) => a - b));
  for (const addon of created) expect(addon.disposed).toBeLessThanOrEqual(1);
};

describe('WebglLru', () => {
  it('allows 8 WebGL terminals', () => {
    expect(WEBGL_LIMIT).toBe(8);
  });

  it('gives a shown terminal WebGL', () => {
    const { created, create } = factory();
    const lru = new WebglLru(WEBGL_LIMIT, create);
    expect(lru.show(1)).toBe(created[0]);
    expect(lru.rendererOf(1)).toBe('webgl');
    expect(lru.rendererOf(2)).toBeNull();
  });

  it('keeps the addon of a terminal shown again', () => {
    const { created, create } = factory();
    const lru = new WebglLru(WEBGL_LIMIT, create);
    lru.show(1);
    lru.show(2);
    expect(lru.show(1)).toBe(created[0]);
    expect(created).toHaveLength(2);
  });

  it('evicts the least recently shown terminal to DOM when a ninth enters', () => {
    const { created, create } = factory();
    const lru = new WebglLru(WEBGL_LIMIT, create);
    for (let key = 1; key <= 8; key++) lru.show(key);
    lru.show(1);
    lru.show(9);
    expect(lru.rendererOf(2)).toBe('dom');
    expect(created.find((a) => a.key === 2)?.disposed).toBe(1);
    expect(lru.webglKeys()).toEqual([9, 1, 8, 7, 6, 5, 4, 3]);
    expectConsistent(lru, created);
  });

  it('disposes the evicted addon before creating the new one', () => {
    const events: string[] = [];
    const lru = new WebglLru(1, (key: number) => {
      events.push(`create ${String(key)}`);
      return { dispose: () => events.push(`dispose ${String(key)}`) };
    });
    lru.show(1);
    lru.show(2);
    expect(events).toEqual(['create 1', 'dispose 1', 'create 2']);
  });

  it('gives an evicted terminal WebGL again when it is next shown', () => {
    const { created, create } = factory();
    const lru = new WebglLru(WEBGL_LIMIT, create);
    for (let key = 1; key <= 9; key++) lru.show(key);
    expect(lru.rendererOf(1)).toBe('dom');
    lru.show(1);
    expect(lru.rendererOf(1)).toBe('webgl');
    expect(lru.rendererOf(2)).toBe('dom');
    expectConsistent(lru, created);
  });

  it('leaves a terminal on DOM when WebGL cannot be created', () => {
    const { created, create } = factory(new Set([3]));
    const lru = new WebglLru(WEBGL_LIMIT, create);
    expect(lru.show(3)).toBeNull();
    expect(lru.rendererOf(3)).toBe('dom');
    expectConsistent(lru, created);
  });

  it('keeps the budget when creation fails at capacity', () => {
    const { created, create } = factory(new Set([9]));
    const lru = new WebglLru(WEBGL_LIMIT, create);
    for (let key = 1; key <= 9; key++) lru.show(key);
    expect(lru.rendererOf(9)).toBe('dom');
    expectConsistent(lru, created);
  });

  it('drops a terminal’s addon on context loss and restores WebGL on its next show', () => {
    const { created, create } = factory();
    const lru = new WebglLru(WEBGL_LIMIT, create);
    const addon = lru.show(1);
    if (addon === null) throw new Error('no addon');
    lru.lost(1, addon);
    expect(addon.disposed).toBe(1);
    expect(lru.rendererOf(1)).toBe('dom');
    expect(lru.webglKeys()).toEqual([]);
    const again = lru.show(1);
    expect(again).not.toBe(addon);
    expect(lru.rendererOf(1)).toBe('webgl');
    expectConsistent(lru, created);
  });

  it('ignores a context loss reported for an addon already disposed', () => {
    const { created, create } = factory();
    const lru = new WebglLru(WEBGL_LIMIT, create);
    const first = lru.show(1);
    if (first === null) throw new Error('no addon');
    lru.lost(1, first);
    const second = lru.show(1);
    lru.lost(1, first);
    expect(first.disposed).toBe(1);
    expect(second?.disposed).toBe(0);
    expect(lru.rendererOf(1)).toBe('webgl');
    expectConsistent(lru, created);
  });

  it('ignores a context loss reported for an evicted addon', () => {
    const { create } = factory();
    const lru = new WebglLru(1, create);
    const first = lru.show(1);
    if (first === null) throw new Error('no addon');
    lru.show(2);
    lru.lost(1, first);
    expect(first.disposed).toBe(1);
    expect(lru.webglKeys()).toEqual([2]);
  });

  it('disposes the addon of a removed terminal and forgets it', () => {
    const { created, create } = factory();
    const lru = new WebglLru(WEBGL_LIMIT, create);
    lru.show(1);
    lru.show(2);
    lru.remove(1);
    expect(created[0]?.disposed).toBe(1);
    expect(lru.rendererOf(1)).toBeNull();
    expect(lru.webglKeys()).toEqual([2]);
    lru.remove(42);
    expectConsistent(lru, created);
  });

  it('holds at most 8 WebGL terminals, the most recently shown, after every transition', () => {
    let seed = 7;
    const random = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    const { created, create } = factory(new Set([13]));
    const lru = new WebglLru(WEBGL_LIMIT, create);
    for (let step = 0; step < 2000; step++) {
      const key = random(20);
      const action = random(10);
      if (action < 7) lru.show(key);
      else if (action < 9) {
        const addon = created.findLast((a) => a.key === key);
        if (addon !== undefined) lru.lost(key, addon);
      } else lru.remove(key);
      expectConsistent(lru, created);
    }
    lru.show(1);
    lru.show(2);
    for (const key of [1, 2]) expect(lru.rendererOf(key)).toBe('webgl');
    expect(lru.webglKeys().slice(0, 2)).toEqual([2, 1]);
  });

  it('gives the 8 most recently shown terminals WebGL', () => {
    const { created, create } = factory();
    const lru = new WebglLru(WEBGL_LIMIT, create);
    const order = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 3, 5];
    for (const key of order) lru.show(key);
    expect(lru.webglKeys()).toEqual([5, 3, 12, 11, 10, 9, 8, 7]);
    for (const key of [1, 2, 4, 6]) expect(lru.rendererOf(key)).toBe('dom');
    expectConsistent(lru, created);
  });
});
