import { describe, expect, it } from 'vitest';
import { Restorer, type RestoreDeps } from './restore.js';

interface Deferred {
  resolve: (ok: boolean) => void;
}

/** Records every dependency call in order; watches stay pending until resolved by the test. */
const harness = (attached: Record<string, number[]>, listed: Record<string, number[]>) => {
  const calls: string[] = [];
  const watches = new Map<string, Deferred>();
  const deps: RestoreDeps = {
    watch: (host, repo) =>
      new Promise((resolve) => {
        calls.push(`watch ${String(host)} ${repo}`);
        watches.set(`${String(host)} ${repo}`, { resolve });
      }),
    attached: (host, repo) => attached[`${String(host)} ${repo}`] ?? [],
    listed: (host, repo) => listed[`${String(host)} ${repo}`] ?? [],
    attach: (host, termId) => calls.push(`attach ${String(host)} ${String(termId)}`),
    dispose: (host) => calls.push(`dispose ${String(host)}`),
  };
  const finish = async (key: string, ok = true): Promise<void> => {
    const watch = watches.get(key);
    if (watch === undefined) throw new Error(`no watch ${key}`);
    watch.resolve(ok);
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { calls, deps, finish };
};

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('Restorer', () => {
  it('watches each repo and attaches its terminals only after that watch is done', async () => {
    const { calls, deps, finish } = harness({ '0 /a': [1, 2], '0 /b': [3] }, { '0 /a': [1, 2], '0 /b': [3] });
    const restoring = new Restorer(deps).connected(0, 'd1', ['/a', '/b']);
    await settle();
    expect(calls).toEqual(['watch 0 /a', 'watch 0 /b']);
    await finish('0 /b');
    expect(calls).toEqual(['watch 0 /a', 'watch 0 /b', 'attach 0 3']);
    await finish('0 /a');
    await restoring;
    expect(calls.slice(3).sort()).toEqual(['attach 0 1', 'attach 0 2']);
  });

  it('re-attaches only terminals that are still listed', async () => {
    const { calls, deps, finish } = harness({ '0 /a': [1, 2, 5] }, { '0 /a': [2, 5, 9] });
    const restoring = new Restorer(deps).connected(0, 'd1', ['/a']);
    await settle();
    await finish('0 /a');
    await restoring;
    expect(calls.filter((c) => c.startsWith('attach')).sort()).toEqual(['attach 0 2', 'attach 0 5']);
  });

  it('leaves a terminal opened while the watch runs to its own attach', async () => {
    const attached: Record<string, number[]> = { '0 /a': [1] };
    const { calls, deps, finish } = harness(attached, { '0 /a': [1, 2] });
    const restoring = new Restorer(deps).connected(0, 'd1', ['/a']);
    await settle();
    attached['0 /a'] = [1, 2];
    await finish('0 /a');
    await restoring;
    expect(calls.filter((c) => c.startsWith('attach'))).toEqual(['attach 0 1']);
  });

  it('attaches nothing for a repo whose watch failed', async () => {
    const { calls, deps, finish } = harness({ '0 /a': [1], '0 /b': [2] }, { '0 /a': [1], '0 /b': [2] });
    const restoring = new Restorer(deps).connected(0, 'd1', ['/a', '/b']);
    await settle();
    await finish('0 /a', false);
    await finish('0 /b');
    await restoring;
    expect(calls.filter((c) => c.startsWith('attach'))).toEqual(['attach 0 2']);
  });

  it('keeps the terminals of a host reconnected to the same daemon instance', async () => {
    const { calls, deps, finish } = harness({ '0 /a': [1] }, { '0 /a': [1] });
    const restorer = new Restorer(deps);
    const first = restorer.connected(0, 'd1', ['/a']);
    await settle();
    await finish('0 /a');
    await first;
    calls.length = 0;
    const second = restorer.connected(0, 'd1', ['/a']);
    await settle();
    await finish('0 /a');
    await second;
    expect(calls).toEqual(['watch 0 /a', 'attach 0 1']);
  });

  it('disposes the terminals of a host whose daemon instance changed before watching again', async () => {
    const { calls, deps, finish } = harness({}, {});
    const restorer = new Restorer(deps);
    const first = restorer.connected(0, 'd1', ['/a']);
    await settle();
    await finish('0 /a');
    await first;
    calls.length = 0;
    const second = restorer.connected(0, 'd2', ['/a']);
    await settle();
    expect(calls).toEqual(['dispose 0', 'watch 0 /a']);
    await finish('0 /a');
    await second;
  });

  it('does not dispose on the first connection of a host', async () => {
    const { calls, deps, finish } = harness({}, {});
    const restoring = new Restorer(deps).connected(0, 'd1', ['/a']);
    await settle();
    await finish('0 /a');
    await restoring;
    expect(calls).not.toContain('dispose 0');
  });

  it('tracks the instance of each host separately', async () => {
    const { calls, deps, finish } = harness({}, {});
    const restorer = new Restorer(deps);
    const first = restorer.connected(0, 'd1', ['/a']);
    await settle();
    await finish('0 /a');
    await first;
    const other = restorer.connected(1, 'd9', ['/b']);
    await settle();
    await finish('1 /b');
    await other;
    calls.length = 0;
    const again = restorer.connected(0, 'd1', ['/a']);
    await settle();
    await finish('0 /a');
    await again;
    expect(calls).not.toContain('dispose 0');
    expect(calls).not.toContain('dispose 1');
  });
});
