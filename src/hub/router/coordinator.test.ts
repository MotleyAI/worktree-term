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
const setup = (): { coordinator: HostCoordinator; started: string[]; settle: (kind: string, error?: Error) => void } => {
  const started: string[] = [];
  const running = new Map<string, Deferred>();
  const op = (kind: string) => (): Promise<void> => {
    started.push(kind);
    const d = deferred();
    running.set(kind, d);
    return d.promise;
  };
  const coordinator = new HostCoordinator({ restart: op('restart'), reinstall: op('reinstall') });
  const settle = (kind: string, error?: Error): void => {
    const d = running.get(kind);
    if (d === undefined) throw new Error(`${kind} is not running`);
    running.delete(kind);
    if (error === undefined) d.resolve();
    else d.reject(error);
  };
  return { coordinator, started, settle };
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
});
