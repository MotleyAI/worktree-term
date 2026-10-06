import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addWorktree, makeRepo, sleep } from '../support/daemon-host.js';
import { HubHost } from '../support/hub-host.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

const MB = 1000 * 1000;

/** Private resident memory of `pid`: its anonymous pages, without the shared node binary. */
const privateBytes = (pid: number): number => {
  const match = /^RssAnon:\s+(\d+) kB$/m.exec(readFileSync(`/proc/${String(pid)}/status`, 'utf8'));
  if (match?.[1] === undefined) throw new Error(`no RssAnon for ${String(pid)}`);
  return Number(match[1]) * 1024;
};

let host: HubHost;

beforeEach(async () => {
  host = await HubHost.createHub();
});

afterEach(async () => {
  await host.cleanup();
});

describe('resident memory', () => {
  it('keeps hub and daemon under 150 MB of private memory with 58 worktrees watched and 10 terminals attached', async () => {
    const repo = makeRepo(join(host.dir, 'repo'));
    const worktrees = Array.from({ length: 57 }, (_, i) => addWorktree(repo, join(host.dir, 'wts', `wt${String(i)}`), `wt${String(i)}`));
    host.writeRepos([repo]);
    const hub = await host.startHub();
    const client = await host.session();
    await client.waitHost(0, (h) => h.status === 'connected', { timeout: 10_000 });
    const state = await client.watch(0, repo);
    expect(state.worktrees).toHaveLength(58);
    for (const worktree of worktrees.slice(0, 10)) {
      const term = await client.create(0, worktree);
      await client.attach(0, term.termId);
      client.sendInput(0, term.termId, 'echo READY-$((6*7))\r');
      await client.waitOutput(0, term.termId, 'READY-42\r\n', 10_000);
    }
    await sleep(3000);
    const [daemon] = host.daemonPids();
    if (daemon === undefined) throw new Error('no daemon');
    expect(privateBytes(hub.pid) + privateBytes(daemon)).toBeLessThan(150 * MB);
  });
});
