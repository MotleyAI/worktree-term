import { describe, expect, it } from 'vitest';
import { hostKey, TerminalMemory, type RememberedTerminal, type TerminalStorage } from './memory.js';

/** An in-memory stand-in for `localStorage`. */
const mapStorage = (): TerminalStorage & { items: Map<string, string> } => {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
  };
};

const throwing: TerminalStorage = {
  getItem: () => {
    throw new Error('SecurityError');
  },
  setItem: () => {
    throw new Error('QuotaExceededError');
  },
};

const TERMS: RememberedTerminal[] = [
  { worktree: 'feat', preset: 'claude' },
  { worktree: 'main', preset: 'shell' },
];

describe('hostKey', () => {
  it('keys the local host and each remote host name separately', () => {
    expect(hostKey({ remote: false, name: 'laptop' })).toBe('local');
    expect(hostKey({ remote: true, name: 'box' })).toBe('remote:box');
    expect(hostKey({ remote: true, name: 'local' })).not.toBe(hostKey({ remote: false, name: 'local' }));
  });
});

describe('TerminalMemory', () => {
  it('recalls the terminals remembered for a host and instance, with the time it saw them', () => {
    const memory = new TerminalMemory(mapStorage());
    memory.remember('local', 'inst_1', TERMS, 1000);
    expect(memory.recall('local', 'inst_1')).toEqual({ at: 1000, terminals: TERMS });
  });

  it('survives a reload through its storage', () => {
    const storage = mapStorage();
    new TerminalMemory(storage).remember('remote:box', 'inst_1', TERMS, 2000);
    expect(new TerminalMemory(storage).recall('remote:box', 'inst_1')).toEqual({ at: 2000, terminals: TERMS });
  });

  it('recalls nothing for another instance or a null one', () => {
    const memory = new TerminalMemory(mapStorage());
    memory.remember('local', 'inst_1', TERMS, 1000);
    expect(memory.recall('local', 'inst_2')).toBeNull();
    expect(memory.recall('local', null)).toBeNull();
  });

  it('keeps hosts apart', () => {
    const memory = new TerminalMemory(mapStorage());
    memory.remember('local', 'inst_1', TERMS, 1000);
    memory.remember('remote:box', 'inst_1', [{ worktree: 'x', preset: 'shell' }], 3000);
    expect(memory.recall('local', 'inst_1')?.terminals).toEqual(TERMS);
    expect(memory.recall('remote:box', 'inst_1')?.terminals).toEqual([{ worktree: 'x', preset: 'shell' }]);
    expect(memory.recall('remote:gpu', 'inst_1')).toBeNull();
  });

  it('replaces what it remembered for a host, including an empty list', () => {
    const memory = new TerminalMemory(mapStorage());
    memory.remember('local', 'inst_1', TERMS, 1000);
    memory.remember('local', 'inst_2', [], 5000);
    expect(memory.recall('local', 'inst_1')).toBeNull();
    expect(memory.recall('local', 'inst_2')).toEqual({ at: 5000, terminals: [] });
  });

  it('keeps at most 256 terminals per host', () => {
    const memory = new TerminalMemory(mapStorage());
    const many = Array.from({ length: 300 }, (_, i) => ({ worktree: `wt${String(i)}`, preset: 'shell' }));
    memory.remember('local', 'inst_1', many, 1000);
    expect(memory.recall('local', 'inst_1')?.terminals).toHaveLength(256);
  });

  it('loses only the list when storage throws', () => {
    const memory = new TerminalMemory(throwing);
    expect(() => {
      memory.remember('local', 'inst_1', TERMS, 1000);
    }).not.toThrow();
    expect(memory.recall('local', 'inst_1')).toBeNull();
  });

  it('works without storage', () => {
    const memory = new TerminalMemory(null);
    memory.remember('local', 'inst_1', TERMS, 1000);
    expect(memory.recall('local', 'inst_1')).toBeNull();
  });

  it('ignores stored data it cannot read', () => {
    const storage = mapStorage();
    const memory = new TerminalMemory(storage);
    memory.remember('local', 'inst_1', TERMS, 1000);
    for (const key of storage.items.keys()) storage.items.set(key, '{"not":"a record"');
    expect(new TerminalMemory(storage).recall('local', 'inst_1')).toBeNull();
    for (const key of storage.items.keys()) storage.items.set(key, JSON.stringify({ instance: 'inst_1', at: 'x', terminals: 7 }));
    expect(new TerminalMemory(storage).recall('local', 'inst_1')).toBeNull();
  });
});
