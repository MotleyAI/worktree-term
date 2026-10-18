import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { DaemonClient } from '../support/daemon-client.js';
import {
  addWorktree,
  alive,
  canConnect,
  fakeWorktrees,
  makeRepo,
  residentBytes,
  sleep,
  waitUntil,
  type WtdProcess,
} from '../support/daemon-host.js';
import { host, useDaemonServerHost } from '../support/daemon-server.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });
useDaemonServerHost();

const MiB = 1024 * 1024;

describe('multiple clients', () => {
  it('serves concurrent clients independently', async () => {
    const repo = makeRepo(join(host.dir, 'repo'));
    await host.start();
    const clients = await Promise.all([host.client(), host.client(), host.client()]);
    const states = await Promise.all(clients.map((c) => c.watch(repo)));
    for (const state of states) expect(state.worktrees.map((w) => w.path)).toEqual([repo]);
    const [a, b] = clients;
    const from = b.mark();
    expect((await a.request({ t: 'detach', termId: 1 })).t).toBe('error');
    await sleep(200);
    expect(b.messages.slice(from)).toEqual([]);
  });
});

describe('bounded connection queue', () => {
  it('keeps memory bounded and the PTY running for others when a client stops reading', async () => {
    const repo = makeRepo(join(host.dir, 'repo'));
    const daemon = await host.start();
    const reader = await host.client();
    await reader.watch(repo);
    const term = await reader.create(repo, { command: 'yes 0123456789abcdefghijklmnopqrstuvwxyz' });
    const stalled = await host.client();
    await stalled.watch(repo);
    stalled.autoAck = false;
    await stalled.attach(term.termId);
    stalled.pauseReading();
    const view = await reader.attach(term.termId);
    const baseline = residentBytes(daemon.pid);
    let peak = baseline;
    const start = view.position;
    for (let i = 0; i < 20; i++) {
      await sleep(250);
      peak = Math.max(peak, residentBytes(daemon.pid));
    }
    // Waits for the volume rather than timing it: a loaded machine slows `yes`, not only a blocked PTY.
    await waitUntil(
      () => {
        peak = Math.max(peak, residentBytes(daemon.pid));
        return view.position - start > 8 * MiB;
      },
      'the reader to receive 8 MiB',
      30_000,
    );
    expect(peak - baseline).toBeLessThan(128 * MiB);
    expect(view.gaps).toEqual([]);
    stalled.resumeReading();
    expect(await stalled.waitFor('detached')).toEqual({ t: 'detached', termId: term.termId, reason: 'lagging' });
  });

  it('closes a connection whose unread replies exceed 64 MiB', async () => {
    const repo = makeRepo(join(host.dir, 'repo'));
    fakeWorktrees(repo, 1000, 200);
    const daemon = await host.start();
    const flooder = await host.client();
    const first = await flooder.watch(repo);
    expect(first.worktrees).toHaveLength(1001);
    const replySize = JSON.stringify(first).length;
    flooder.pauseReading();
    const baseline = residentBytes(daemon.pid);
    const requests = Math.ceil((160 * MiB) / replySize);
    for (let req = 100; req < 100 + requests; req++) flooder.sendJson({ t: 'watchRepo', req, repo });
    let peak = baseline;
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      peak = Math.max(peak, residentBytes(daemon.pid));
    }
    flooder.resumeReading();
    await flooder.waitClosed(30_000);
    expect(flooder.messages.filter((m) => m.t === 'repoState').length).toBeLessThan(requests);
    expect(peak - baseline).toBeLessThan(160 * MiB);
    const other = await host.client();
    expect((await other.watch(repo)).worktrees).toHaveLength(1001);
  });
});

describe('shutdown', () => {
  const stopBy: readonly [string, (daemon: WtdProcess, client: DaemonClient) => void][] = [
    [
      'shutdown',
      (_daemon, client) => {
        client.send({ t: 'shutdown' });
      },
    ],
    [
      'SIGTERM',
      (daemon) => {
        daemon.kill('SIGTERM');
      },
    ],
    [
      'SIGINT',
      (daemon) => {
        daemon.kill('SIGINT');
      },
    ],
  ];

  it.each(stopBy)('%s ends every terminal, removes the socket and exits 0', async (_name, stop) => {
    const repo = makeRepo(join(host.dir, 'repo'));
    const daemon = await host.start();
    const client = await host.client();
    await client.watch(repo);
    for (const name of ['a', 'b']) {
      await client.create(repo, { command: `echo $$ > ${name}.pid; exec sleep 600` });
    }
    const pids = await waitUntil(() => {
      const files = ['a', 'b'].map((name) => join(repo, `${name}.pid`));
      return (
        files.every((f) => existsSync(f) && readFileSync(f, 'utf8').endsWith('\n')) && files.map((f) => Number(readFileSync(f, 'utf8')))
      );
    }, 'terminal pids');
    stop(daemon, client);
    expect(await daemon.exited).toEqual({ code: 0, signal: null });
    expect(existsSync(host.socket)).toBe(false);
    await waitUntil(() => pids.every((pid) => !alive(pid)), 'terminal processes to end', 8000);
  });

  it('completes a state write requested just before shutdown', async () => {
    const repo = makeRepo(join(host.dir, 'repo'));
    const wt = addWorktree(repo, join(host.dir, 'wt'), 'wt');
    const daemon = await host.start();
    const client = await host.client();
    await client.watch(repo);
    client.sendJson({ t: 'setChecked', req: 50, worktree: wt, checked: true });
    client.send({ t: 'shutdown' });
    expect((await daemon.exited).code).toBe(0);
    await host.start();
    expect((await (await host.client()).watch(repo)).checked).toEqual([wt]);
  });

  it('ignores SIGHUP', async () => {
    const daemon = await host.start();
    daemon.kill('SIGHUP');
    await sleep(300);
    expect(alive(daemon.pid)).toBe(true);
    expect(await canConnect(host.socket)).toBe(true);
  });
});
