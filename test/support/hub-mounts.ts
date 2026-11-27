import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach } from 'vitest';
import { addWorktree } from './daemon-host.js';
import type { FakeRemote } from './fake-ssh.js';
import { FakeSshfs } from './fake-sshfs.js';
import type { HubClient } from './hub-client.js';
import { configure, connectedHost, fx, installedBox, restartHub } from './hub-router.js';

/** Per-test fake mount programs, refilled by the `beforeEach` that `useFakeSshfs` registers. */
class MountFixture {
  sshfs!: FakeSshfs;
}

export const mx = new MountFixture();

/** Registers a fresh FakeSshfs per test and restarts the hub with its environment. */
export const useFakeSshfs = (): void => {
  beforeEach(async () => {
    mx.sshfs = new FakeSshfs(join(fx.host.dir, 'sshfs'));
    await restartHub({ ...mx.sshfs.env });
  });
};

/** The hub's mount directory. */
export const mountDir = (): string => join(fx.host.runDir, 'mounts');

/** The mount point of `path` on `alias` for the host `name`. */
export const mountPoint = (name: string, alias: string, path: string): string =>
  join(mountDir(), createHash('sha256').update([name, alias, path].join('\0')).digest('hex').slice(0, 32));

/** Entries of the mount directory; none when it does not exist. */
export const mountDirEntries = (): string[] => (existsSync(mountDir()) ? readdirSync(mountDir()) : []);

/** The mount points `fusermount3` was run for, in order. */
export const unmounted = (): string[] => mx.sshfs.calls('fusermount3').map((call) => call.args.at(-1) ?? '');

/** The remote `box` as host 1 with `editor` as the editor command, its repo holding a second worktree. */
export const boxWithWorktree = async (editor: string): Promise<{ remote: FakeRemote; remoteRepo: string; remoteWt: string }> => {
  const { remote, remoteRepo } = await installedBox();
  const remoteWt = addWorktree(remoteRepo, join(remote.home, 'src', 'app-wt'), 'wt');
  configure([{ name: 'box', ssh: 'box', repos: [remoteRepo] }], { editor });
  return { remote, remoteRepo, remoteWt };
};

/** A session with host 1 connected, watching `repo` there. */
export const watchingBox = async (repo: string): Promise<HubClient> => {
  const client = await fx.host.session();
  await connectedHost(client, 1);
  await client.watch(1, repo);
  return client;
};
