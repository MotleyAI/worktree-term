import { readFileSync, rmSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeRepo, sleep } from '../support/daemon-host.js';
import type { HubClient, HubMessageOf, Reply } from '../support/hub-client.js';
import { configFile, configure, connected, connectedHost, fx, installedBox, useHubRouterHost, watching } from '../support/hub-router.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });
useHubRouterHost();

const watchers: FSWatcher[] = [];

afterEach(() => {
  for (const watcher of watchers.splice(0)) watcher.close();
});

/** Counts the writes that replace `config.json` from now on. */
const configWrites = (): (() => number) => {
  let writes = 0;
  const watcher = watch(fx.host.configDir, (event, name) => {
    if (event === 'rename' && name === 'config.json') writes++;
  });
  watchers.push(watcher);
  return () => writes;
};

const errorMessage = (reply: Reply): string => (reply.m.t === 'error' ? reply.m.message : '');

/** The first `hosts` message after the `done` for `req`, from index `from`. */
const hostsAfterDone = async (client: HubClient, req: number, from: number): Promise<HubMessageOf<'hosts'>> => {
  await client.waitFor('done', (m) => m.req === req, { from });
  const doneAt = client.messages.findIndex((m, i) => i >= from && m.t === 'done' && m.req === req);
  return client.waitFor('hosts', () => true, { from: doneAt + 1 });
};

describe('removing repo groups', () => {
  it('removes a local and a remote repo in one config.json write, answering done, then hosts without both to every session', async () => {
    const { remoteRepo } = await installedBox();
    const a = await fx.host.session();
    const b = await fx.host.session();
    await connected(a);
    await connectedHost(a, 1);
    await connectedHost(b, 1);
    const writes = configWrites();
    const fromA = a.mark();
    const fromB = b.mark();
    const members = [
      { host: 0, repo: fx.repo },
      { host: 1, repo: remoteRepo },
    ];
    expect(await a.hubRequest({ t: 'removeRepos', members }, 15_000)).toEqual({ from: 'hub', m: { t: 'done', req: 1 } });
    const hosts = await hostsAfterDone(a, 1, fromA);
    expect(hosts.hosts.map((h) => [h.idx, h.repos])).toEqual([
      [0, []],
      [1, []],
    ]);
    await b.waitHost(1, (h) => h.repos.length === 0, { from: fromB });
    expect(b.hosts().map((h) => h.repos)).toEqual([[], []]);
    expect(configFile()).toEqual({ port: fx.host.port, repos: [], hosts: [{ name: 'box', ssh: 'box', repos: [] }] });
    await sleep(300);
    expect(writes()).toBe(1);
  });

  it('removes entries listed by a ~/ form and members whose directory is gone, leaving unlisted members alone', async () => {
    const app = makeRepo(join(fx.host.home, 'app'));
    const gone = makeRepo(join(fx.host.dir, 'gone'));
    fx.host.writeConfig({ port: fx.host.port, repos: [fx.repo, '~/app', gone] });
    rmSync(gone, { recursive: true, force: true });
    const client = await fx.host.session();
    await connected(client);
    const writes = configWrites();
    const members = [
      { host: 0, repo: app },
      { host: 0, repo: gone },
      { host: 0, repo: join(fx.host.dir, 'never') },
    ];
    expect((await client.hubRequest({ t: 'removeRepos', members })).m).toEqual({ t: 'done', req: 1 });
    expect(configFile()).toEqual({ port: fx.host.port, repos: [fx.repo] });
    await sleep(300);
    expect(writes()).toBe(1);
  });

  it('refuses the whole group with busy naming the second member’s host and repo when it has a running terminal', async () => {
    const { remoteRepo } = await installedBox();
    const client = await fx.host.session();
    await connected(client);
    await connectedHost(client, 1);
    await client.watch(1, remoteRepo);
    await client.create(1, remoteRepo, { command: 'exec sleep 60' });
    const before = readFileSync(fx.host.configPath, 'utf8');
    const members = [
      { host: 0, repo: fx.repo },
      { host: 1, repo: remoteRepo },
    ];
    const reply = await client.hubRequest({ t: 'removeRepos', members }, 15_000);
    expect(reply).toMatchObject({ from: 'hub', m: { t: 'error', req: 3, host: 1, code: 'busy' } });
    expect(errorMessage(reply)).toContain('box');
    expect(errorMessage(reply)).toContain(remoteRepo);
    expect(readFileSync(fx.host.configPath, 'utf8')).toBe(before);
    expect(client.hosts().map((h) => h.repos)).toEqual([[fx.repo], [remoteRepo]]);
  });

  it('answers with the first failing member’s error when several members fail', async () => {
    const second = makeRepo(join(fx.host.dir, 'second'));
    fx.host.writeRepos([fx.repo, second]);
    const client = await watching();
    await client.watch(0, second);
    await client.create(0, fx.repo, { command: 'exec sleep 60' });
    await client.create(0, second, { command: 'exec sleep 60' });
    const before = readFileSync(fx.host.configPath, 'utf8');
    const members = [
      { host: 0, repo: second },
      { host: 0, repo: fx.repo },
    ];
    const reply = await client.hubRequest({ t: 'removeRepos', members });
    expect(reply).toMatchObject({ from: 'hub', m: { t: 'error', req: 5, host: 0, code: 'busy' } });
    expect(errorMessage(reply)).toContain(client.hosts()[0]?.name ?? 'no host');
    expect(errorMessage(reply)).toContain(second);
    expect(errorMessage(reply)).not.toContain(fx.repo);
    expect(readFileSync(fx.host.configPath, 'utf8')).toBe(before);
  });

  it('refuses the whole group with host-unavailable naming the member whose host is down', async () => {
    fx.ssh.failHost('box', 'ssh: Could not resolve hostname box');
    configure([{ name: 'box', ssh: 'box', repos: ['/srv/app'] }]);
    const client = await fx.host.session();
    await connected(client);
    await client.waitHost(1, (h) => h.status === 'down', { timeout: 15_000 });
    const before = readFileSync(fx.host.configPath, 'utf8');
    const members = [
      { host: 0, repo: fx.repo },
      { host: 1, repo: '/srv/app' },
    ];
    const reply = await client.hubRequest({ t: 'removeRepos', members });
    expect(reply).toMatchObject({ from: 'hub', m: { t: 'error', req: 1, host: 1, code: 'host-unavailable' } });
    expect(errorMessage(reply)).toContain('box');
    expect(errorMessage(reply)).toContain('/srv/app');
    expect(readFileSync(fx.host.configPath, 'utf8')).toBe(before);
    expect(client.hosts().map((h) => h.repos)).toEqual([[fx.repo], ['/srv/app']]);
  });
});
