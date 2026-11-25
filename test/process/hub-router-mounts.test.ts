import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { alive, git, sleep, waitUntil } from '../support/daemon-host.js';
import { pathWithout } from '../support/fake-ssh.js';
import { errorMessage, launchesOf, openEditor, recorder, useEditorRecorders } from '../support/hub-editor.js';
import { boxWithWorktree, mountDirEntries, mountPoint, mx, unmounted, useFakeSshfs, watchingBox } from '../support/hub-mounts.js';
import { configure, fx, restartHub, useHubRouterHost } from '../support/hub-router.js';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });
useHubRouterHost();
useFakeSshfs();
useEditorRecorders();

/** A reply to wait for while a mount is held. */
const HELD_TIMEOUT = 15_000;

describe('opening a remote worktree in an editor', () => {
  it('mounts box:/srv/app-wt and starts the editor with the mount point as its path and working directory', async () => {
    const editor = recorder(fx.host.dir);
    const { remoteRepo, remoteWt } = await boxWithWorktree(editor.command);
    const client = await watchingBox(remoteRepo);
    expect(await openEditor(client, 1, remoteWt)).toEqual({ from: 'hub', m: { t: 'done', req: 2 } });
    const point = mountPoint('box', 'box', remoteWt);
    const mounts = mx.sshfs.calls('sshfs');
    expect(mounts).toHaveLength(1);
    expect(mounts[0]?.args.slice(-2)).toEqual([`box:${remoteWt}`, point]);
    expect(mx.sshfs.mounted()).toEqual([point]);
    const [launch] = await launchesOf(editor.launches);
    expect(launch?.args).toEqual([point]);
    expect(launch?.cwd).toBe(realpathSync(point));
  });

  it('refuses a worktree of another host with not-a-worktree, mounting and starting nothing', async () => {
    const editor = recorder(fx.host.dir);
    const { remoteRepo, remoteWt } = await boxWithWorktree(editor.command);
    const client = await watchingBox(remoteRepo);
    await client.watch(0, fx.repo);
    const local = await openEditor(client, 1, fx.wt);
    expect(local).toMatchObject({ from: 'hub', m: { t: 'error', req: 3, host: null, code: 'not-a-worktree' } });
    expect(errorMessage(local)).toContain(fx.wt);
    const remote = await openEditor(client, 0, remoteWt);
    expect(remote).toMatchObject({ from: 'hub', m: { t: 'error', req: 4, host: null, code: 'not-a-worktree' } });
    expect(errorMessage(remote)).toContain(remoteWt);
    await sleep(300);
    expect(mx.sshfs.calls()).toEqual([]);
    expect(editor.launches()).toEqual([]);
  });

  it('answers host-unavailable for a worktree of a host that is reconnecting, mounting nothing', async () => {
    const editor = recorder(fx.host.dir);
    const { remoteRepo, remoteWt } = await boxWithWorktree(editor.command);
    const client = await watchingBox(remoteRepo);
    const from = client.mark();
    fx.ssh.failHost('box', 'ssh: connect to host box port 22: Connection refused');
    for (const pid of fx.ssh.livePids('box')) process.kill(pid, 'SIGKILL');
    await client.waitHost(1, (h) => h.status === 'reconnecting', { from });
    expect(await openEditor(client, 1, remoteWt)).toMatchObject({
      from: 'hub',
      m: { t: 'error', req: 2, host: 1, code: 'host-unavailable' },
    });
    await sleep(300);
    expect(mx.sshfs.calls()).toEqual([]);
    expect(editor.launches()).toEqual([]);
  });

  it('answers editor-missing with the message sshfs when sshfs is not on the hub’s PATH', async () => {
    const { WTD_FUSERMOUNT, WTD_MOUNTINFO } = mx.sshfs.env;
    await restartHub({ WTD_FUSERMOUNT, WTD_MOUNTINFO, PATH: pathWithout(join(fx.host.dir, 'no-sshfs'), new Set(['sshfs'])) });
    const editor = recorder(fx.host.dir);
    const { remoteRepo, remoteWt } = await boxWithWorktree(editor.command);
    const client = await watchingBox(remoteRepo);
    const reply = await openEditor(client, 1, remoteWt);
    expect(reply).toMatchObject({ from: 'hub', m: { t: 'error', req: 2, host: null, code: 'editor-missing' } });
    expect(errorMessage(reply)).toBe('sshfs');
    expect(editor.launches()).toEqual([]);
  });

  it('answers editor-missing with the message fusermount3 when fusermount3 is not on the hub’s PATH', async () => {
    const { WTD_SSHFS, WTD_MOUNTINFO } = mx.sshfs.env;
    await restartHub({ WTD_SSHFS, WTD_MOUNTINFO, PATH: pathWithout(join(fx.host.dir, 'no-fusermount'), new Set(['fusermount3'])) });
    const editor = recorder(fx.host.dir);
    const { remoteRepo, remoteWt } = await boxWithWorktree(editor.command);
    const client = await watchingBox(remoteRepo);
    const reply = await openEditor(client, 1, remoteWt);
    expect(reply).toMatchObject({ from: 'hub', m: { t: 'error', req: 2, host: null, code: 'editor-missing' } });
    expect(errorMessage(reply)).toBe('fusermount3');
    expect(editor.launches()).toEqual([]);
  });

  it('answers editor-failed with the mount program’s last error line, leaving no mount point', async () => {
    const editor = recorder(fx.host.dir);
    const { remoteRepo, remoteWt } = await boxWithWorktree(editor.command);
    mx.sshfs.failWith('read: Connection reset by peer');
    const client = await watchingBox(remoteRepo);
    const reply = await openEditor(client, 1, remoteWt);
    expect(reply).toMatchObject({ from: 'hub', m: { t: 'error', req: 2, host: null, code: 'editor-failed' } });
    expect(errorMessage(reply)).toContain('read: Connection reset by peer');
    expect(existsSync(mountPoint('box', 'box', remoteWt))).toBe(false);
    expect(editor.launches()).toEqual([]);
  });
});

describe('remote worktree mounts', () => {
  it('reuses the mount when two sessions open the same remote worktree one after the other', async () => {
    const editor = recorder(fx.host.dir);
    const { remoteRepo, remoteWt } = await boxWithWorktree(editor.command);
    const a = await watchingBox(remoteRepo);
    expect((await openEditor(a, 1, remoteWt)).m).toEqual({ t: 'done', req: 2 });
    const b = await watchingBox(remoteRepo);
    expect((await openEditor(b, 1, remoteWt)).m).toEqual({ t: 'done', req: 2 });
    const point = mountPoint('box', 'box', remoteWt);
    expect(mx.sshfs.calls('sshfs')).toHaveLength(1);
    expect((await launchesOf(editor.launches, 2)).map((launch) => launch.args)).toEqual([[point], [point]]);
  });

  it('runs the mount program once for two openEditor requests that arrive before the mount is ready, answering both after it', async () => {
    const editor = recorder(fx.host.dir);
    const { remoteRepo, remoteWt } = await boxWithWorktree(editor.command);
    const a = await watchingBox(remoteRepo);
    const b = await watchingBox(remoteRepo);
    mx.sshfs.hold();
    let answered = 0;
    const replies = [openEditor(a, 1, remoteWt, HELD_TIMEOUT), openEditor(b, 1, remoteWt, HELD_TIMEOUT)].map((reply) =>
      reply.then((r) => {
        answered++;
        return r;
      }),
    );
    await waitUntil(() => mx.sshfs.calls('sshfs').length === 1, 'the held mount');
    await sleep(500);
    expect(answered).toBe(0);
    expect(mx.sshfs.calls('sshfs')).toHaveLength(1);
    mx.sshfs.release();
    expect((await Promise.all(replies)).map((reply) => reply.m)).toEqual([
      { t: 'done', req: 2 },
      { t: 'done', req: 2 },
    ]);
    expect(mx.sshfs.calls('sshfs')).toHaveLength(1);
    const point = mountPoint('box', 'box', remoteWt);
    expect((await launchesOf(editor.launches, 2)).map((launch) => launch.args)).toEqual([[point], [point]]);
  });

  it('keeps the mount when the session that opened it closes', async () => {
    const editor = recorder(fx.host.dir);
    const { remoteRepo, remoteWt } = await boxWithWorktree(editor.command);
    const client = await watchingBox(remoteRepo);
    expect((await openEditor(client, 1, remoteWt)).m).toEqual({ t: 'done', req: 2 });
    const pids = fx.ssh.livePids('box');
    client.close();
    await waitUntil(() => pids.every((pid) => !alive(pid)), 'the session’s SSH processes to end');
    await fx.host.session();
    await sleep(500);
    const point = mountPoint('box', 'box', remoteWt);
    expect(mx.sshfs.mounted()).toEqual([point]);
    expect(existsSync(point)).toBe(true);
    expect(unmounted()).toEqual([]);
  });

  it('unmounts lazily and removes the mount point once the host’s daemon lists the repo without the worktree', async () => {
    const editor = recorder(fx.host.dir);
    const { remoteRepo, remoteWt } = await boxWithWorktree(editor.command);
    const client = await watchingBox(remoteRepo);
    expect((await openEditor(client, 1, remoteWt)).m).toEqual({ t: 'done', req: 2 });
    const point = mountPoint('box', 'box', remoteWt);
    expect(unmounted()).toEqual([]);
    const from = client.mark();
    git(remoteRepo, 'worktree', 'remove', remoteWt);
    await client.waitEvent(1, 'worktreesChanged', (m) => !m.worktrees.some((w) => w.path === remoteWt), { from, timeout: 10_000 });
    await waitUntil(() => unmounted().includes(point) && !existsSync(point), 'the mount to be unmounted and removed');
    expect(mx.sshfs.calls('fusermount3')[0]?.args).toEqual(['-u', '-z', point]);
    expect(mx.sshfs.mounted()).toEqual([]);
  });

  it('only logs a failed unmount, and goes on answering', async () => {
    const failing = join(fx.host.dir, 'failing-fusermount3');
    writeFileSync(failing, "#!/bin/sh\necho 'fusermount3: failed to unmount: Device or resource busy' >&2\nexit 1\n", { mode: 0o755 });
    await restartHub({ ...mx.sshfs.env, WTD_FUSERMOUNT: failing });
    const editor = recorder(fx.host.dir);
    const { remoteRepo, remoteWt } = await boxWithWorktree(editor.command);
    const client = await watchingBox(remoteRepo);
    expect((await openEditor(client, 1, remoteWt)).m).toEqual({ t: 'done', req: 2 });
    const before = fx.hub.stderr.length;
    git(remoteRepo, 'worktree', 'remove', remoteWt);
    await waitUntil(() => fx.hub.stderr.slice(before).includes('Device or resource busy'), 'the reported unmount failure', 10_000);
    expect((await openEditor(client, 1, remoteRepo)).m).toEqual({ t: 'done', req: 3 });
  });

  it('unmounts a host’s mounts once config.json no longer lists the host and a new session starts', async () => {
    const editor = recorder(fx.host.dir);
    const { remoteRepo, remoteWt } = await boxWithWorktree(editor.command);
    const client = await watchingBox(remoteRepo);
    expect((await openEditor(client, 1, remoteWt)).m).toEqual({ t: 'done', req: 2 });
    const point = mountPoint('box', 'box', remoteWt);
    configure([], { editor: editor.command });
    await fx.host.session();
    await waitUntil(() => unmounted().includes(point), 'the removed host’s mount to be unmounted', 10_000);
    expect(mx.sshfs.mounted()).toEqual([]);
  });

  it('unmounts a host’s mounts once config.json lists its name under another SSH alias and a new session starts', async () => {
    const editor = recorder(fx.host.dir);
    const { remoteRepo, remoteWt } = await boxWithWorktree(editor.command);
    const client = await watchingBox(remoteRepo);
    expect((await openEditor(client, 1, remoteWt)).m).toEqual({ t: 'done', req: 2 });
    const point = mountPoint('box', 'box', remoteWt);
    fx.ssh.failHost('box-other', 'ssh: Could not resolve hostname box-other');
    configure([{ name: 'box', ssh: 'box-other', repos: [remoteRepo] }], { editor: editor.command });
    await fx.host.session();
    await waitUntil(() => unmounted().includes(point), 'the re-aliased host’s mount to be unmounted', 10_000);
    expect(mx.sshfs.mounted()).toEqual([]);
  });

  it('unmounts both mounts before it exits when the hub shuts down', async () => {
    const editor = recorder(fx.host.dir);
    const { remoteRepo, remoteWt } = await boxWithWorktree(editor.command);
    const client = await watchingBox(remoteRepo);
    expect((await openEditor(client, 1, remoteWt)).m).toEqual({ t: 'done', req: 2 });
    expect((await openEditor(client, 1, remoteRepo)).m).toEqual({ t: 'done', req: 3 });
    const points = [mountPoint('box', 'box', remoteWt), mountPoint('box', 'box', remoteRepo)];
    expect(mx.sshfs.mounted().sort()).toEqual([...points].sort());
    fx.hub.kill('SIGTERM');
    await fx.hub.exited;
    expect(unmounted().sort()).toEqual([...points].sort());
    expect(mx.sshfs.mounted()).toEqual([]);
  });

  it('unmounts a mount left by a killed hub and removes leftover directories when a new hub starts', async () => {
    fx.hub.kill('SIGKILL');
    await fx.hub.exited;
    const stale = mountPoint('box', 'box', '/srv/app');
    const leftover = mountPoint('box', 'box', '/srv/gone');
    mkdirSync(stale, { recursive: true });
    mkdirSync(leftover, { recursive: true });
    mx.sshfs.addMount(stale);
    const elsewhere = join(fx.host.dir, 'elsewhere');
    mkdirSync(elsewhere);
    mx.sshfs.addMount(elsewhere, 'other:/srv/other');
    fx.hub = await fx.host.startHub({ ...mx.sshfs.env });
    await waitUntil(() => unmounted().includes(stale) && mountDirEntries().length === 0, 'the stale mount and leftovers to go', 10_000);
    expect(mx.sshfs.calls('fusermount3').map((call) => call.args)).toEqual([['-u', '-z', stale]]);
    expect(mx.sshfs.mounted()).toEqual([elsewhere]);
    expect(mountDirEntries()).toEqual([]);
  });
});
