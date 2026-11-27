import { beforeEach, expect, it, vi } from 'vitest';
import { hostPaths } from '../../platform/files/index.js';
import type * as Mounts from '../../platform/mounts/index.js';
import { MountRegistry, type WorktreeMount } from './mounts.js';

// `calls` records mounts and unmounts in order. `nextMount`, when set, is what the next mount gives;
// with `holdUnmount`, each unmount waits for `release()`.
const fake = vi.hoisted((): { calls: string[]; nextMount: Promise<string> | null; holdUnmount: boolean; release: () => void } => ({
  calls: [],
  nextMount: null,
  holdUnmount: false,
  release: () => undefined,
}));

vi.mock('../../platform/mounts/index.js', async (importOriginal) => {
  const real = await importOriginal<typeof Mounts>();
  return {
    ...real,
    mountPoint: (_paths: unknown, target: Mounts.MountTarget) => `/m/${target.path}`,
    listMounts: () => {
      fake.calls.push('list');
      return Promise.resolve([]);
    },
    removeLeftovers: () => Promise.resolve(),
    mount: (_paths: unknown, target: Mounts.MountTarget) => {
      fake.calls.push(`mount ${target.path}`);
      const next = fake.nextMount ?? Promise.resolve(`/m/${target.path}`);
      fake.nextMount = null;
      return next;
    },
    unmount: (point: string) => {
      fake.calls.push(`unmount ${point}`);
      if (!fake.holdUnmount) return Promise.resolve();
      return new Promise<void>((resolve) => {
        fake.release = resolve;
      });
    },
  };
});

const WT: WorktreeMount = { host: 'box', alias: 'box', path: 'wt', repo: '/srv/app' };
const paths = hostPaths({ env: {}, home: '/nonexistent', host: 'local' });

beforeEach(() => {
  fake.calls = [];
  fake.nextMount = null;
  fake.holdUnmount = false;
});

it('remounts a dropped worktree only after its unmount finished', async () => {
  fake.holdUnmount = true;
  const registry = new MountRegistry(paths, () => undefined);
  registry.start();
  await registry.mount(WT);
  registry.listed('box', 'box', '/srv/app', []);
  await vi.waitFor(() => {
    expect(fake.calls).toEqual(['list', 'mount wt', 'unmount /m/wt']);
  });
  const again = registry.mount(WT);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(fake.calls).toEqual(['list', 'mount wt', 'unmount /m/wt']);
  fake.release();
  await expect(again).resolves.toEqual({ kind: 'mounted', point: '/m/wt' });
  expect(fake.calls).toEqual(['list', 'mount wt', 'unmount /m/wt', 'mount wt']);
});

it('keeps tracking a remount when the dropped mount it replaced fails', async () => {
  let fail: (error: Error) => void = () => undefined;
  fake.nextMount = new Promise((_resolve, reject) => {
    fail = reject;
  });
  const registry = new MountRegistry(paths, () => undefined);
  registry.start();
  const first = registry.mount(WT);
  await vi.waitFor(() => {
    expect(fake.calls).toEqual(['list', 'mount wt']);
  });
  registry.listed('box', 'box', '/srv/app', []);
  const again = registry.mount(WT);
  fail(new Error('sshfs failed'));
  await expect(first).resolves.toMatchObject({ kind: 'error', code: 'editor-failed' });
  await expect(again).resolves.toEqual({ kind: 'mounted', point: '/m/wt' });
  await registry.close();
  expect(fake.calls).toEqual(['list', 'mount wt', 'mount wt', 'unmount /m/wt']);
});

it('refuses to mount once closing has begun', async () => {
  const registry = new MountRegistry(paths, () => undefined);
  registry.start();
  const closed = registry.close();
  await expect(registry.mount(WT)).resolves.toMatchObject({ kind: 'error', code: 'editor-failed' });
  await closed;
  expect(fake.calls).toEqual(['list']);
});

it('touches no mount before it is started, then cleans up before mounting', async () => {
  const registry = new MountRegistry(paths, () => undefined);
  const mounted = registry.mount(WT);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(fake.calls).toEqual([]);
  registry.start();
  await expect(mounted).resolves.toEqual({ kind: 'mounted', point: '/m/wt' });
  expect(fake.calls).toEqual(['list', 'mount wt']);
});
