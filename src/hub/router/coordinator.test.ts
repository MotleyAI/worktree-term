import { describe, expect, it } from 'vitest';
import { HostCoordinator } from './coordinator.js';

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
}

const deferred = (): Deferred => {
  let resolve: () => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

/** A coordinator whose operations record their start and finish when the test settles them. */
const setup = (): {
  coordinator: HostCoordinator;
  started: string[];
  settle: (kind: string, error?: Error) => void;
  /** The most operations that ran at once. */
  peak: () => number;
} => {
  const started: string[] = [];
  const running = new Map<string, Deferred>();
  let peak = 0;
  const op = (kind: string) => (): Promise<void> => {
    started.push(kind);
    const d = deferred();
    running.set(kind, d);
    peak = Math.max(peak, running.size);
    return d.promise;
  };
  const coordinator = new HostCoordinator({ restart: op('restart'), reinstall: op('reinstall'), install: op('install') });
  const settle = (kind: string, error?: Error): void => {
    const d = running.get(kind);
    if (d === undefined) throw new Error(`${kind} is not running`);
    running.delete(kind);
    if (error === undefined) d.resolve();
    else d.reject(error);
  };
  return { coordinator, started, settle, peak: () => peak };
};

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Whether `promise` has settled by now. */
const settled = async (promise: Promise<unknown>): Promise<boolean> => {
  let done = false;
  void promise.then(
    () => (done = true),
    () => (done = true),
  );
  await tick();
  return done;
};

describe('HostCoordinator', () => {
  it('shares one restart between concurrent requests', async () => {
    const { coordinator, started, settle } = setup();
    const a = coordinator.restart();
    const b = coordinator.restart();
    await tick();
    expect(started).toEqual(['restart']);
    settle('restart');
    await expect(Promise.all([a, b])).resolves.toEqual([undefined, undefined]);
  });

  it('shares one reinstall between concurrent requests', async () => {
    const { coordinator, started, settle } = setup();
    const a = coordinator.reinstall();
    const b = coordinator.reinstall();
    await tick();
    expect(started).toEqual(['reinstall']);
    settle('reinstall');
    await expect(Promise.all([a, b])).resolves.toEqual([undefined, undefined]);
  });

  it('lets a restart requested during a reinstall share the reinstall', async () => {
    const { coordinator, started, settle } = setup();
    const reinstall = coordinator.reinstall();
    await tick();
    const restart = coordinator.restart();
    await tick();
    expect(started).toEqual(['reinstall']);
    expect(await settled(restart)).toBe(false);
    settle('reinstall');
    await expect(Promise.all([reinstall, restart])).resolves.toEqual([undefined, undefined]);
    expect(started).toEqual(['reinstall']);
  });

  it('gives a restart sharing a failed reinstall that failure', async () => {
    const { coordinator, settle } = setup();
    const reinstall = coordinator.reinstall();
    await tick();
    const restart = coordinator.restart();
    settle('reinstall', new Error('install: no Node'));
    await expect(reinstall).rejects.toThrow('install: no Node');
    await expect(restart).rejects.toThrow('install: no Node');
  });

  it('runs a reinstall requested during a restart once the restart ended', async () => {
    const { coordinator, started, settle } = setup();
    const restart = coordinator.restart();
    await tick();
    const reinstall = coordinator.reinstall();
    await tick();
    expect(started).toEqual(['restart']);
    settle('restart');
    await restart;
    await tick();
    expect(started).toEqual(['restart', 'reinstall']);
    expect(await settled(reinstall)).toBe(false);
    settle('reinstall');
    await expect(reinstall).resolves.toBeUndefined();
  });

  it('runs a queued reinstall even when the restart before it failed', async () => {
    const { coordinator, started, settle } = setup();
    const restart = coordinator.restart();
    await tick();
    const reinstall = coordinator.reinstall();
    settle('restart', new Error('no new daemon'));
    await expect(restart).rejects.toThrow('no new daemon');
    await tick();
    expect(started).toEqual(['restart', 'reinstall']);
    settle('reinstall');
    await expect(reinstall).resolves.toBeUndefined();
  });

  it('shares one queued reinstall between requests made during a restart', async () => {
    const { coordinator, started, settle } = setup();
    void coordinator.restart();
    await tick();
    const a = coordinator.reinstall();
    const b = coordinator.reinstall();
    settle('restart');
    await tick();
    await tick();
    expect(started).toEqual(['restart', 'reinstall']);
    settle('reinstall');
    await expect(Promise.all([a, b])).resolves.toEqual([undefined, undefined]);
  });

  it('starts a fresh run for a request after the previous one ended', async () => {
    const { coordinator, started, settle } = setup();
    const first = coordinator.restart();
    await tick();
    settle('restart');
    await first;
    const second = coordinator.restart();
    await tick();
    expect(started).toEqual(['restart', 'restart']);
    settle('restart');
    await expect(second).resolves.toBeUndefined();
  });

  it('starts a fresh run after a failed one', async () => {
    const { coordinator, started, settle } = setup();
    const first = coordinator.restart();
    await tick();
    settle('restart', new Error('boom'));
    await expect(first).rejects.toThrow('boom');
    const second = coordinator.restart();
    await tick();
    expect(started).toEqual(['restart', 'restart']);
    settle('restart');
    await expect(second).resolves.toBeUndefined();
  });

  it('gives the running or queued reinstall to share, and none otherwise', async () => {
    const { coordinator, settle } = setup();
    expect(coordinator.reinstalling()).toBeNull();
    const restart = coordinator.restart();
    await tick();
    expect(coordinator.reinstalling()).toBeNull();
    const queued = coordinator.reinstall();
    expect(coordinator.reinstalling()).toBe(queued);
    settle('restart');
    await restart;
    await tick();
    expect(coordinator.reinstalling()).not.toBeNull();
    settle('reinstall');
    await queued;
    expect(coordinator.reinstalling()).toBeNull();
  });
});

type Kind = 'install' | 'restart' | 'reinstall';

const request = (coordinator: HostCoordinator, kind: Kind): Promise<void> => coordinator[kind]();

const permutations = <T>(items: readonly T[]): T[][] =>
  items.length <= 1
    ? [[...items]]
    : items.flatMap((item, i) => permutations(items.filter((_, j) => j !== i)).map((rest) => [item, ...rest]));

describe('HostCoordinator installs', () => {
  it('shares one install between concurrent requests', async () => {
    const { coordinator, started, settle } = setup();
    const a = coordinator.install();
    const b = coordinator.install();
    await tick();
    expect(started).toEqual(['install']);
    settle('install');
    await expect(Promise.all([a, b])).resolves.toEqual([undefined, undefined]);
  });

  it('lets an install share a running reinstall', async () => {
    const { coordinator, started, settle } = setup();
    const reinstall = coordinator.reinstall();
    await tick();
    const install = coordinator.install();
    await tick();
    expect(started).toEqual(['reinstall']);
    expect(await settled(install)).toBe(false);
    settle('reinstall');
    await expect(Promise.all([reinstall, install])).resolves.toEqual([undefined, undefined]);
    expect(started).toEqual(['reinstall']);
  });

  it('lets an install share a queued reinstall', async () => {
    const { coordinator, started, settle } = setup();
    void coordinator.restart();
    await tick();
    const reinstall = coordinator.reinstall();
    const install = coordinator.install();
    settle('restart');
    await tick();
    await tick();
    expect(started).toEqual(['restart', 'reinstall']);
    settle('reinstall');
    await expect(Promise.all([reinstall, install])).resolves.toEqual([undefined, undefined]);
    expect(started).toEqual(['restart', 'reinstall']);
  });

  it('lets an install share a queued install', async () => {
    const { coordinator, started, settle } = setup();
    void coordinator.restart();
    await tick();
    const a = coordinator.install();
    const b = coordinator.install();
    settle('restart');
    await tick();
    await tick();
    expect(started).toEqual(['restart', 'install']);
    settle('install');
    await expect(Promise.all([a, b])).resolves.toEqual([undefined, undefined]);
  });

  it.each(['restart', 'reinstall'] as const)('runs a %s requested during an install once the install ended', async (kind) => {
    const { coordinator, started, settle } = setup();
    const install = coordinator.install();
    await tick();
    const later = request(coordinator, kind);
    await tick();
    expect(started).toEqual(['install']);
    expect(await settled(later)).toBe(false);
    settle('install');
    await install;
    await tick();
    expect(started).toEqual(['install', kind]);
    settle(kind);
    await expect(later).resolves.toBeUndefined();
  });

  it('runs an install requested during a restart once the restart ended', async () => {
    const { coordinator, started, settle } = setup();
    const restart = coordinator.restart();
    await tick();
    const install = coordinator.install();
    await tick();
    expect(started).toEqual(['restart']);
    expect(await settled(install)).toBe(false);
    settle('restart');
    await restart;
    await tick();
    expect(started).toEqual(['restart', 'install']);
    settle('install');
    await expect(install).resolves.toBeUndefined();
  });

  it('runs a queued install even when the restart before it failed', async () => {
    const { coordinator, started, settle } = setup();
    const restart = coordinator.restart();
    await tick();
    const install = coordinator.install();
    settle('restart', new Error('no new daemon'));
    await expect(restart).rejects.toThrow('no new daemon');
    await tick();
    expect(started).toEqual(['restart', 'install']);
    settle('install');
    await expect(install).resolves.toBeUndefined();
  });

  it('gives an install sharing a failed reinstall that failure', async () => {
    const { coordinator, settle } = setup();
    const reinstall = coordinator.reinstall();
    await tick();
    const install = coordinator.install();
    settle('reinstall', new Error('install: no Node'));
    await expect(install).rejects.toThrow('install: no Node');
    await expect(reinstall).rejects.toThrow('install: no Node');
  });

  /** The runs, in order, that requests made in this order start. */
  const RUNS: readonly (readonly [readonly Kind[], readonly Kind[]])[] = [
    [
      ['install', 'restart', 'reinstall'],
      ['install', 'restart', 'reinstall'],
    ],
    [
      ['install', 'reinstall', 'restart'],
      ['install', 'reinstall'],
    ],
    [
      ['restart', 'install', 'reinstall'],
      ['restart', 'install', 'reinstall'],
    ],
    [
      ['restart', 'reinstall', 'install'],
      ['restart', 'reinstall'],
    ],
    [['reinstall', 'install', 'restart'], ['reinstall']],
    [['reinstall', 'restart', 'install'], ['reinstall']],
  ];

  it('lists every ordering of three requests', () => {
    expect(RUNS.map(([kinds]) => kinds)).toEqual(expect.arrayContaining(permutations<Kind>(['install', 'restart', 'reinstall'])));
    expect(RUNS).toHaveLength(6);
  });

  it.each(RUNS)('runs requests made as %j one at a time, in order, as the runs %j', async (kinds, runs) => {
    const { coordinator, started, settle, peak } = setup();
    const requests = kinds.map((kind) => request(coordinator, kind));
    for (let i = 0; i < runs.length; i++) {
      await tick();
      await tick();
      expect(started).toEqual(runs.slice(0, i + 1));
      settle(runs[i] ?? '');
    }
    await expect(Promise.all(requests)).resolves.toEqual([undefined, undefined, undefined]);
    expect(started).toEqual(runs);
    expect(peak()).toBe(1);
  });
});
