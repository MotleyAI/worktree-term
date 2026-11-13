import { mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { makeRepo, sleep, waitUntil } from '../support/daemon-host.js';
import { FakeDaemon } from '../support/fake-daemon.js';
import { installRemote } from '../support/fake-ssh.js';
import type { HubClient, HubMessageOf } from '../support/hub-client.js';
import {
  configFile,
  configure,
  connected,
  connectedHost,
  fx,
  installedBox,
  nodeRemote,
  restartHub,
  useHubRouterHost,
  watching,
} from '../support/hub-router.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });
useHubRouterHost();

const SHELL = { name: 'shell', command: null };
const CLAUDE = { name: 'claude', command: 'claude' };
/** The presets of a configuration without `presets`. */
const DEFAULT_PRESETS = [SHELL, CLAUDE, { name: 'codex', command: 'codex' }];

/** The commands of every `editor` message received so far. */
const editorsOf = (client: HubClient): string[] => client.messages.flatMap((m) => (m.t === 'editor' ? [m.command] : []));

/** The preset lists of every `presets` message received so far. */
const presetsOf = (client: HubClient): HubMessageOf<'presets'>['presets'][] =>
  client.messages.flatMap((m) => (m.t === 'presets' ? [m.presets] : []));

describe('configuration snapshots', () => {
  it('lists no repos when the configuration has none', async () => {
    fx.host.writeConfig({ port: fx.host.port });
    const client = await fx.host.session();
    expect(client.hosts()[0]?.repos).toEqual([]);
  });

  it('lists the configured repos for host 0', async () => {
    const client = await fx.host.session();
    expect(client.hosts()[0]?.repos).toEqual([fx.repo]);
  });

  it('expands ~/ against the home directory without resolving symbolic links', async () => {
    symlinkSync(fx.repo, join(fx.host.home, 'linked'));
    fx.host.writeConfig({ port: fx.host.port, repos: ['~/linked'] });
    const client = await fx.host.session();
    expect(client.hosts()[0]?.repos).toEqual([join(fx.host.home, 'linked')]);
  });

  it('sends the configured presets exactly, in their order', async () => {
    fx.host.presets = [CLAUDE, SHELL];
    fx.host.writeRepos([fx.repo]);
    const client = await fx.host.session();
    expect(presetsOf(client)).toEqual([[CLAUDE, SHELL]]);
  });

  it('gives a new session an edited configuration, leaving an open session unchanged', async () => {
    const open = await fx.host.session();
    expect(presetsOf(open)).toEqual([DEFAULT_PRESETS]);
    const other = makeRepo(join(fx.host.dir, 'other'));
    fx.host.presets = [SHELL, CLAUDE];
    fx.host.writeRepos([fx.repo, other]);
    const fresh = await fx.host.session();
    expect(fresh.hosts()[0]?.repos).toEqual([fx.repo, other]);
    expect(presetsOf(fresh)).toEqual([[SHELL, CLAUDE]]);
    await open.expectNone('hosts', (m) => m.hosts.some((h) => h.repos.includes(other)), 1000);
    expect(open.hosts()[0]?.repos).toEqual([fx.repo]);
    expect(presetsOf(open)).toEqual([DEFAULT_PRESETS]);
  });

  it.each([
    ['an empty presets list', []],
    [
      'two presets named a',
      [
        { name: 'a', command: null },
        { name: 'a', command: 'x' },
      ],
    ],
    ['a preset whose command is empty', [{ name: 'a', command: '' }]],
  ])('gives a new session an internal error and the last valid repos and presets after an edit to %s', async (_name, presets) => {
    fx.host.presets = [CLAUDE, SHELL];
    fx.host.writeRepos([fx.repo]);
    expect(presetsOf(await fx.host.session())).toEqual([[CLAUDE, SHELL]]);
    fx.host.writeConfig({ port: fx.host.port, repos: [join(fx.host.dir, 'x')], presets });
    const client = await fx.host.open(['wtd', `wtd.token.${fx.host.token()}`]);
    await client.handshake();
    const error = await client.waitFor('error');
    expect(error).toMatchObject({ req: null, host: null, code: 'internal' });
    expect(error.message).toContain('presets');
    expect(client.hosts()[0]?.repos).toEqual([fx.repo]);
    expect(presetsOf(client)).toEqual([[CLAUDE, SHELL]]);
  });
});

describe('repo discovery through the hub', () => {
  it('discovers repos below the host’s configured roots, at depth 3', async () => {
    const one = makeRepo(join(fx.host.home, 'src', 'one'));
    const deep = makeRepo(join(fx.host.home, 'src', 'a', 'b', 'deep'));
    makeRepo(join(fx.host.home, 'src', 'a', 'b', 'c', 'too-deep'));
    makeRepo(join(fx.host.home, 'elsewhere', 'outside'));
    fx.host.writeConfig({ port: fx.host.port, repos: [fx.repo], roots: ['~/src'] });
    const client = await fx.host.session();
    await connected(client);
    const reply = await client.hubRequest({ t: 'discoverRepos', host: 0 });
    expect(reply).toEqual({ from: 'hub', m: { t: 'reposDiscovered', req: 1, host: 0, repos: [deep, one] } });
  });

  it('discovers below the home directory by default', async () => {
    const mine = makeRepo(join(fx.host.home, 'GitHub', 'mine'));
    const client = await fx.host.session();
    await connected(client);
    const reply = await client.hubRequest({ t: 'discoverRepos', host: 0 });
    expect(reply.m.t === 'reposDiscovered' ? reply.m.repos : []).toContain(mine);
  });

  it('discovers on a remote host against the remote home', async () => {
    const remote = nodeRemote('box');
    await installRemote(fx.host, fx.ssh, 'box');
    const found = makeRepo(join(remote.home, 'code', 'found'));
    configure([{ name: 'box', ssh: 'box', roots: ['~/code'] }]);
    const client = await fx.host.session();
    await connectedHost(client, 1);
    const reply = await client.hubRequest({ t: 'discoverRepos', host: 1 });
    expect(reply).toEqual({ from: 'hub', m: { t: 'reposDiscovered', req: 1, host: 1, repos: [found] } });
  });

  it('keeps a hub-level request apart from a daemon request with the same id', async () => {
    const client = await fx.host.session();
    await connected(client);
    const from = client.mark();
    client.sendJson({ t: 'host', host: 0, m: { t: 'watchRepo', req: 7, repo: fx.repo } });
    client.sendJson({ t: 'discoverRepos', req: 7, host: 0 });
    await client.waitFor('reposDiscovered', (m) => m.req === 7, { from });
    await client.waitEvent(0, 'done', (m) => m.req === 7, { from });
    await sleep(1000);
    const replies = client.messages.slice(from).filter((m) => {
      if (m.t === 'host') return 'req' in m.m && m.m.req === 7;
      return 'req' in m && m.req === 7;
    });
    expect(replies.map((m) => (m.t === 'host' ? `host:${m.m.t}` : m.t)).sort()).toEqual(['host:done', 'reposDiscovered']);
  });

  it('answers discovery for a host that is not connected as routing does', async () => {
    fx.ssh.failHost('box', 'ssh: Could not resolve hostname box');
    configure([{ name: 'box', ssh: 'box' }]);
    const client = await fx.host.session();
    await client.waitHost(1, (h) => h.status === 'reconnecting' || h.status === 'down');
    expect(await client.hubRequest({ t: 'discoverRepos', host: 1 })).toMatchObject({
      from: 'hub',
      m: { t: 'error', req: 1, host: 1, code: 'host-unavailable' },
    });
    expect(await client.hubRequest({ t: 'discoverRepos', host: 9 })).toMatchObject({
      from: 'hub',
      m: { t: 'error', code: 'unknown-host' },
    });
  });

  it('answers discovery for an outdated host with version-mismatch', async () => {
    await FakeDaemon.listen(fx.host.socket, { protocol: 99 });
    const client = await fx.host.session();
    await client.waitHost(0, (h) => h.status === 'outdated');
    expect(await client.hubRequest({ t: 'discoverRepos', host: 0 })).toMatchObject({ m: { t: 'error', code: 'version-mismatch' } });
  });
});

describe('adding repos', () => {
  it('adds a repo to config.json, answers done, then lists it in hosts', async () => {
    const added = makeRepo(join(fx.host.dir, 'added'));
    const client = await fx.host.session();
    await connected(client);
    const from = client.mark();
    const reply = await client.hubRequest({ t: 'addRepo', host: 0, repo: added });
    expect(reply).toEqual({ from: 'hub', m: { t: 'done', req: 1 } });
    const listed = await client.waitHost(0, (h) => h.repos.includes(added), { from });
    expect(listed.repos).toEqual([fx.repo, added]);
    const doneAt = client.messages.findIndex((m, i) => i >= from && m.t === 'done');
    const hostsAt = client.messages.findIndex((m, i) => i >= from && m.t === 'hosts' && m.hosts[0]?.repos.includes(added) === true);
    expect(doneAt).toBeLessThan(hostsAt);
    expect(configFile()).toEqual({ port: fx.host.port, repos: [fx.repo, added] });
  });

  it('refuses a directory that is not a repository’s main worktree with not-a-repo, leaving config.json unchanged', async () => {
    const plain = join(fx.host.dir, 'plain');
    mkdirSync(plain);
    const before = readFileSync(fx.host.configPath, 'utf8');
    const client = await fx.host.session();
    await connected(client);
    expect(await client.hubRequest({ t: 'addRepo', host: 0, repo: plain })).toMatchObject({
      from: 'hub',
      m: { t: 'error', req: 1, host: 0, code: 'not-a-repo' },
    });
    expect(await client.hubRequest({ t: 'addRepo', host: 0, repo: fx.wt })).toMatchObject({ m: { t: 'error', code: 'not-a-repo' } });
    expect(readFileSync(fx.host.configPath, 'utf8')).toBe(before);
  });

  it('answers done without an edit for a repo already listed, as given or by a ~/ form', async () => {
    symlinkSync(fx.repo, join(fx.host.home, 'linked'));
    fx.host.writeConfig({ port: fx.host.port, repos: [fx.repo, '~/linked'] });
    const before = readFileSync(fx.host.configPath, 'utf8');
    const client = await fx.host.session();
    await connected(client);
    expect((await client.hubRequest({ t: 'addRepo', host: 0, repo: fx.repo })).m).toEqual({ t: 'done', req: 1 });
    expect((await client.hubRequest({ t: 'addRepo', host: 0, repo: join(fx.host.home, 'linked') })).m).toEqual({ t: 'done', req: 2 });
    expect(readFileSync(fx.host.configPath, 'utf8')).toBe(before);
  });

  it('lists a repo added to a remote host in every open session', async () => {
    const { remote, remoteRepo } = await installedBox();
    const second = makeRepo(join(remote.home, 'src', 'second'));
    const a = await fx.host.session();
    const b = await fx.host.session();
    await connectedHost(a, 1);
    await connectedHost(b, 1);
    const fromB = b.mark();
    expect((await a.hubRequest({ t: 'addRepo', host: 1, repo: second })).m).toEqual({ t: 'done', req: 1 });
    expect((await a.waitHost(1, (h) => h.repos.includes(second))).repos).toEqual([remoteRepo, second]);
    expect((await b.waitHost(1, (h) => h.repos.includes(second), { from: fromB })).repos).toEqual([remoteRepo, second]);
    expect(b.hosts()[0]?.repos).toEqual([fx.repo]);
    expect(configFile()).toEqual({
      port: fx.host.port,
      repos: [fx.repo],
      hosts: [{ name: 'box', ssh: 'box', repos: [remoteRepo, second] }],
    });
  });

  it('answers adding to a host that is not connected as routing does', async () => {
    fx.ssh.failHost('box', 'ssh: Could not resolve hostname box');
    configure([{ name: 'box', ssh: 'box' }]);
    const client = await fx.host.session();
    await client.waitHost(1, (h) => h.status === 'reconnecting' || h.status === 'down');
    expect(await client.hubRequest({ t: 'addRepo', host: 1, repo: '/srv/x' })).toMatchObject({
      m: { t: 'error', host: 1, code: 'host-unavailable' },
    });
  });
});

describe('removing repos', () => {
  it('removes a repo listed by a ~/ form, answers done, then drops it from hosts', async () => {
    const app = makeRepo(join(fx.host.home, 'app'));
    fx.host.writeConfig({ port: fx.host.port, repos: [fx.repo, '~/app'] });
    const client = await fx.host.session();
    await connected(client);
    expect(client.hosts()[0]?.repos).toEqual([fx.repo, app]);
    const from = client.mark();
    expect((await client.hubRequest({ t: 'removeRepo', host: 0, repo: app })).m).toEqual({ t: 'done', req: 1 });
    expect((await client.waitHost(0, (h) => !h.repos.includes(app), { from })).repos).toEqual([fx.repo]);
    expect(configFile()).toEqual({ port: fx.host.port, repos: [fx.repo] });
  });

  it('refuses a repo with a running terminal with busy, leaving config.json unchanged', async () => {
    const client = await watching();
    await client.create(0, fx.wt, { command: 'exec sleep 60' });
    const before = readFileSync(fx.host.configPath, 'utf8');
    expect(await client.hubRequest({ t: 'removeRepo', host: 0, repo: fx.repo })).toMatchObject({
      from: 'hub',
      m: { t: 'error', req: 3, host: 0, code: 'busy' },
    });
    expect(readFileSync(fx.host.configPath, 'utf8')).toBe(before);
  });

  it('refuses a repo with an exited terminal not yet closed, and removes it once closed', async () => {
    const client = await watching();
    const term = await client.create(0, fx.repo, { command: 'exit 1' });
    await client.waitEvent(0, 'termExited', (m) => m.termId === term.termId, { timeout: 10_000 });
    expect((await client.hubRequest({ t: 'removeRepo', host: 0, repo: fx.repo })).m).toMatchObject({ t: 'error', code: 'busy' });
    await client.ok(0, { t: 'closeTerm', termId: term.termId });
    expect((await client.hubRequest({ t: 'removeRepo', host: 0, repo: fx.repo })).m).toMatchObject({ t: 'done' });
    expect(configFile()).toEqual({ port: fx.host.port, repos: [] });
  });

  it('removes a listed repo whose directory no longer exists', async () => {
    const gone = makeRepo(join(fx.host.dir, 'gone'));
    fx.host.writeRepos([fx.repo, gone]);
    rmSync(gone, { recursive: true, force: true });
    const client = await fx.host.session();
    await connected(client);
    expect((await client.hubRequest({ t: 'removeRepo', host: 0, repo: gone })).m).toEqual({ t: 'done', req: 1 });
    expect(configFile()).toEqual({ port: fx.host.port, repos: [fx.repo] });
  });

  it('answers done without an edit for a repo it does not list', async () => {
    const before = readFileSync(fx.host.configPath, 'utf8');
    const client = await fx.host.session();
    await connected(client);
    expect((await client.hubRequest({ t: 'removeRepo', host: 0, repo: join(fx.host.dir, 'never') })).m).toEqual({ t: 'done', req: 1 });
    expect(readFileSync(fx.host.configPath, 'utf8')).toBe(before);
  });
});

describe('editing presets', () => {
  const HTOP = { name: 'htop', command: 'htop' };

  it('adds a preset to config.json, answers done, then sends the presets to every open session', async () => {
    fx.host.presets = [SHELL];
    fx.host.writeRepos([fx.repo]);
    const a = await fx.host.session();
    const b = await fx.host.session();
    const [fromA, fromB] = [a.mark(), b.mark()];
    expect(await a.hubRequest({ t: 'addPreset', preset: HTOP })).toEqual({ from: 'hub', m: { t: 'done', req: 1 } });
    for (const [client, from] of [
      [a, fromA],
      [b, fromB],
    ] as const) {
      expect((await client.waitFor('presets', () => true, { from })).presets).toEqual([SHELL, HTOP]);
    }
    const doneAt = a.messages.findIndex((m, i) => i >= fromA && m.t === 'done');
    const presetsAt = a.messages.findIndex((m, i) => i >= fromA && m.t === 'presets');
    expect(doneAt).toBeLessThan(presetsAt);
    expect(configFile()).toEqual({ port: fx.host.port, repos: [fx.repo], presets: [SHELL, HTOP] });
  });

  it('removes a preset, writing the defaults without it when config.json had none', async () => {
    fx.host.writeConfig({ port: fx.host.port, repos: [fx.repo] });
    const client = await fx.host.session();
    const from = client.mark();
    expect((await client.hubRequest({ t: 'removePreset', name: 'claude' })).m).toEqual({ t: 'done', req: 1 });
    const expected = [SHELL, { name: 'codex', command: 'codex' }];
    expect((await client.waitFor('presets', () => true, { from })).presets).toEqual(expected);
    expect(configFile()).toEqual({ port: fx.host.port, repos: [fx.repo], presets: expected });
  });

  it('moves a preset in config.json, answers done, then sends the new order to every open session', async () => {
    fx.host.presets = [SHELL, CLAUDE, HTOP];
    fx.host.writeRepos([fx.repo]);
    const a = await fx.host.session();
    const b = await fx.host.session();
    const fromB = b.mark();
    expect((await a.hubRequest({ t: 'movePreset', name: 'htop', to: 0 })).m).toEqual({ t: 'done', req: 1 });
    expect((await b.waitFor('presets', () => true, { from: fromB })).presets).toEqual([HTOP, SHELL, CLAUDE]);
    expect(configFile()).toEqual({ port: fx.host.port, repos: [fx.repo], presets: [HTOP, SHELL, CLAUDE] });
  });

  it('answers done without sending presets for a name it does not list', async () => {
    fx.host.presets = [SHELL];
    fx.host.writeRepos([fx.repo]);
    const before = readFileSync(fx.host.configPath, 'utf8');
    const client = await fx.host.session();
    expect((await client.hubRequest({ t: 'removePreset', name: 'nope' })).m).toEqual({ t: 'done', req: 1 });
    await client.expectNone('presets', () => true, 300);
    expect(readFileSync(fx.host.configPath, 'utf8')).toBe(before);
  });

  it.each([
    ['adding a taken name', { t: 'addPreset', preset: { name: 'shell', command: 'zsh' } }, 'a preset named shell exists'],
    ['removing the last preset', { t: 'removePreset', name: 'shell' }, 'the last preset cannot be removed'],
  ] as const)('refuses %s with internal, leaving config.json unchanged', async (_name, body, text) => {
    fx.host.presets = [SHELL];
    fx.host.writeRepos([fx.repo]);
    const before = readFileSync(fx.host.configPath, 'utf8');
    const client = await fx.host.session();
    const reply = await client.hubRequest(body);
    expect(reply).toMatchObject({ from: 'hub', m: { t: 'error', req: 1, host: null, code: 'internal' } });
    expect(reply.m.t === 'error' ? reply.m.message : '').toContain(text);
    expect(readFileSync(fx.host.configPath, 'utf8')).toBe(before);
  });
});

describe('configuration edits', () => {
  it('refuses to edit an invalid config.json, naming the problem and leaving it unchanged', async () => {
    const added = makeRepo(join(fx.host.dir, 'added'));
    const client = await fx.host.session();
    await connected(client);
    writeFileSync(fx.host.configPath, JSON.stringify({ port: fx.host.port, theme: 'dark' }));
    const reply = await client.hubRequest({ t: 'addRepo', host: 0, repo: added });
    expect(reply).toMatchObject({ from: 'hub', m: { t: 'error', req: 1, code: 'internal' } });
    expect(reply.m.t === 'error' ? reply.m.message : '').toContain('theme');
    expect(configFile()).toEqual({ port: fx.host.port, theme: 'dark' });
  });

  it('refuses to edit a host the file no longer lists, leaving it unchanged', async () => {
    const { remote } = await installedBox();
    const other = makeRepo(join(remote.home, 'src', 'other'));
    const client = await fx.host.session();
    await connectedHost(client, 1);
    fx.host.writeConfig({ port: fx.host.port, repos: [fx.repo] });
    const before = readFileSync(fx.host.configPath, 'utf8');
    expect((await client.hubRequest({ t: 'addRepo', host: 1, repo: other })).m).toMatchObject({ t: 'error', code: 'internal' });
    expect(readFileSync(fx.host.configPath, 'utf8')).toBe(before);
  });

  it('creates config.json owner-only to record a repo when there was none', async () => {
    rmSync(fx.host.configPath);
    const added = makeRepo(join(fx.host.dir, 'added'));
    const client = await fx.host.session();
    await connected(client);
    expect((await client.hubRequest({ t: 'addRepo', host: 0, repo: added })).m).toEqual({ t: 'done', req: 1 });
    expect(configFile()).toEqual({ repos: [added] });
    expect(statSync(fx.host.configPath).mode & 0o777).toBe(0o600);
  });

  it('changes nothing else in an open session’s snapshot', async () => {
    const added = makeRepo(join(fx.host.dir, 'added'));
    const client = await fx.host.session();
    await connected(client);
    fx.host.presets = [CLAUDE, SHELL];
    fx.host.writeRepos([fx.repo]);
    const from = client.mark();
    expect((await client.hubRequest({ t: 'addRepo', host: 0, repo: added })).m).toEqual({ t: 'done', req: 1 });
    await client.waitHost(0, (h) => h.repos.includes(added), { from });
    expect(presetsOf(client)).toEqual([DEFAULT_PRESETS]);
  });
});

describe('preset memory limits', () => {
  const TESTS = { name: 'tests', command: null, memory: { max: '24G' } };
  const HTOP = { name: 'htop', command: 'htop' };

  it('sends every preset with its effective limits', async () => {
    fx.host.writeConfig({ port: fx.host.port, repos: [fx.repo], terminalMemory: { high: '16G', max: '32G' }, presets: [SHELL, TESTS] });
    expect(presetsOf(await fx.host.session())).toEqual([
      [
        { ...SHELL, memory: { high: '16G', max: '32G' } },
        { ...TESTS, memory: { high: '16G', max: '24G' } },
      ],
    ]);
  });

  it('sends no preset with memory when no limits are configured', async () => {
    const [presets] = presetsOf(await fx.host.session());
    expect(presets?.length).toBeGreaterThan(0);
    expect(presets?.filter((p) => 'memory' in p)).toEqual([]);
  });

  it('sends effective limits after a preset edit, keeping the stored ones in config.json', async () => {
    fx.host.writeConfig({ port: fx.host.port, repos: [fx.repo], terminalMemory: { high: '16G' }, presets: [SHELL, TESTS] });
    const client = await fx.host.session();
    const from = client.mark();
    expect((await client.hubRequest({ t: 'addPreset', preset: HTOP })).m).toEqual({ t: 'done', req: 1 });
    expect((await client.waitFor('presets', () => true, { from })).presets).toEqual([
      { ...SHELL, memory: { high: '16G' } },
      { ...TESTS, memory: { high: '16G', max: '24G' } },
      { ...HTOP, memory: { high: '16G' } },
    ]);
    expect(configFile()).toEqual({ port: fx.host.port, repos: [fx.repo], terminalMemory: { high: '16G' }, presets: [SHELL, TESTS, HTOP] });
  });

  it('stores the memory an added preset carries', async () => {
    const client = await fx.host.session();
    expect((await client.hubRequest({ t: 'addPreset', preset: TESTS })).m).toEqual({ t: 'done', req: 1 });
    const withTests: unknown = expect.arrayContaining([TESTS]);
    expect(configFile()).toMatchObject({ presets: withTests });
  });

  it("relays a createTerm's memory limits to the daemon", async () => {
    const client = await watching();
    const reply = await client.request(0, {
      t: 'createTerm',
      worktree: fx.repo,
      preset: 'tests',
      command: 'exec sleep 60',
      cols: 80,
      rows: 24,
      memory: { max: '64M' },
    });
    expect(reply.m).toMatchObject({ t: 'termCreated', term: { preset: 'tests' } });
    await waitUntil(
      () => readFileSync(fx.host.logPath, 'utf8').includes('memory limits ignored: terminal scopes are off'),
      'the daemon to ignore the limits it was given',
    );
  });
});

describe('editor command snapshots', () => {
  it('sends kate without an editor in config.json', async () => {
    expect(editorsOf(await fx.host.session())).toEqual(['kate']);
  });

  it('sends kate without a config.json', async () => {
    rmSync(fx.host.configPath);
    expect(editorsOf(await fx.host.session())).toEqual(['kate']);
  });

  it('sends the configured editor command as written', async () => {
    fx.host.writeConfig({ port: fx.host.port, repos: [fx.repo], editor: 'code --new-window {path}' });
    expect(editorsOf(await fx.host.session())).toEqual(['code --new-window {path}']);
  });

  it('gives a new session a hand-edited command, leaving an open session unchanged', async () => {
    const open = await fx.host.session();
    fx.host.writeConfig({ port: fx.host.port, repos: [fx.repo], editor: 'subl {path}' });
    const fresh = await fx.host.session();
    expect(editorsOf(fresh)).toEqual(['subl {path}']);
    await open.expectNone('editor', () => true, 300);
    expect(editorsOf(open)).toEqual(['kate']);
  });

  it('gives a new session an internal error and the last valid command after an invalid edit', async () => {
    fx.host.writeConfig({ port: fx.host.port, repos: [fx.repo], editor: 'subl {path}' });
    expect(editorsOf(await fx.host.session())).toEqual(['subl {path}']);
    fx.host.writeConfig({ port: fx.host.port, repos: [fx.repo], editor: 'code "{path}' });
    const client = await fx.host.open(['wtd', `wtd.token.${fx.host.token()}`]);
    await client.handshake();
    const error = await client.waitFor('error');
    expect(error).toMatchObject({ req: null, host: null, code: 'internal' });
    expect(error.message).toContain('editor');
    expect(editorsOf(client)).toEqual(['subl {path}']);
  });
});

describe('editing the editor command', () => {
  it('sets the command in config.json, answers done, then sends it to every open session', async () => {
    const a = await fx.host.session();
    const b = await fx.host.session();
    const [fromA, fromB] = [a.mark(), b.mark()];
    expect(await a.hubRequest({ t: 'setEditor', command: 'code {path}' })).toEqual({ from: 'hub', m: { t: 'done', req: 1 } });
    for (const [client, from] of [
      [a, fromA],
      [b, fromB],
    ] as const) {
      expect((await client.waitFor('editor', () => true, { from })).command).toBe('code {path}');
    }
    const doneAt = a.messages.findIndex((m, i) => i >= fromA && m.t === 'done');
    const editorAt = a.messages.findIndex((m, i) => i >= fromA && m.t === 'editor');
    expect(doneAt).toBeLessThan(editorAt);
    expect(configFile()).toEqual({ port: fx.host.port, repos: [fx.repo], editor: 'code {path}' });
  });

  it('removes the key on reset, keeping the rest as written, and sends kate to every open session', async () => {
    fx.host.writeConfig({ port: fx.host.port, repos: [fx.repo], presets: [SHELL], editor: 'code {path}' });
    const a = await fx.host.session();
    const b = await fx.host.session();
    const fromB = b.mark();
    expect((await a.hubRequest({ t: 'setEditor', command: null })).m).toEqual({ t: 'done', req: 1 });
    expect((await b.waitFor('editor', () => true, { from: fromB })).command).toBe('kate');
    expect(configFile()).toEqual({ port: fx.host.port, repos: [fx.repo], presets: [SHELL] });
  });

  it('answers done without sending editor or touching the file on a reset without an override', async () => {
    const before = readFileSync(fx.host.configPath, 'utf8');
    const client = await fx.host.session();
    expect((await client.hubRequest({ t: 'setEditor', command: null })).m).toEqual({ t: 'done', req: 1 });
    await client.expectNone('editor', () => true, 300);
    expect(readFileSync(fx.host.configPath, 'utf8')).toBe(before);
  });

  it('answers done without sending editor or touching the file for the command it holds', async () => {
    fx.host.writeConfig({ port: fx.host.port, repos: [fx.repo], editor: 'code {path}' });
    const before = readFileSync(fx.host.configPath, 'utf8');
    const client = await fx.host.session();
    expect((await client.hubRequest({ t: 'setEditor', command: 'code {path}' })).m).toEqual({ t: 'done', req: 1 });
    await client.expectNone('editor', () => true, 300);
    expect(readFileSync(fx.host.configPath, 'utf8')).toBe(before);
  });

  it('creates config.json owner-only to record the command when there was none', async () => {
    rmSync(fx.host.configPath);
    const client = await fx.host.session();
    expect((await client.hubRequest({ t: 'setEditor', command: 'subl {path}' })).m).toEqual({ t: 'done', req: 1 });
    expect(configFile()).toEqual({ editor: 'subl {path}' });
    expect(statSync(fx.host.configPath).mode & 0o777).toBe(0o600);
  });

  it('keeps the command across a hub restart', async () => {
    const client = await fx.host.session();
    expect((await client.hubRequest({ t: 'setEditor', command: 'subl {path}' })).m).toEqual({ t: 'done', req: 1 });
    await restartHub({});
    expect(editorsOf(await fx.host.session())).toEqual(['subl {path}']);
  });

  it.each([
    ['a command', 'kate'],
    ['a reset', null],
  ])('refuses %s for an invalid config.json with internal, leaving it unchanged', async (_name, command) => {
    const client = await fx.host.session();
    writeFileSync(fx.host.configPath, JSON.stringify({ port: fx.host.port, editor: 'subl {path}', theme: 'dark' }));
    const before = readFileSync(fx.host.configPath, 'utf8');
    const reply = await client.hubRequest({ t: 'setEditor', command });
    expect(reply).toMatchObject({ from: 'hub', m: { t: 'error', req: 1, host: null, code: 'internal' } });
    expect(reply.m.t === 'error' ? reply.m.message : '').toContain('theme');
    expect(readFileSync(fx.host.configPath, 'utf8')).toBe(before);
    await client.expectNone('editor', () => true, 300);
  });

  it('sends no editor after a repo or preset edit', async () => {
    const added = makeRepo(join(fx.host.dir, 'added'));
    const client = await fx.host.session();
    await connected(client);
    const from = client.mark();
    expect((await client.hubRequest({ t: 'addRepo', host: 0, repo: added })).m).toEqual({ t: 'done', req: 1 });
    expect((await client.hubRequest({ t: 'removePreset', name: 'codex' })).m).toEqual({ t: 'done', req: 2 });
    await client.waitFor('presets', () => true, { from });
    await client.expectNone('editor', () => true, 300);
  });

  it('rejects a setEditor carrying an invalid command as a bad message, leaving config.json unchanged', async () => {
    const before = readFileSync(fx.host.configPath, 'utf8');
    const client = await fx.host.session();
    client.sendJson({ t: 'setEditor', req: 1, command: 'code "{path}' });
    expect(await client.waitFor('error')).toMatchObject({ code: 'bad-message' });
    expect(readFileSync(fx.host.configPath, 'utf8')).toBe(before);
  });
});

describe('edits while a session awaits the browser’s hello', () => {
  it('sends the session every edit made after its snapshot was read, after the snapshot’s values', async () => {
    fx.host.presets = [SHELL];
    fx.host.writeRepos([fx.repo]);
    const added = makeRepo(join(fx.host.dir, 'added'));
    const HTOP = { name: 'htop', command: 'htop' };
    const opening = await fx.host.open(['wtd', `wtd.token.${fx.host.token()}`]);
    await opening.waitFor('hello');
    await sleep(300); // lets the hub read the opening session's snapshot
    const editing = await fx.host.session();
    await connected(editing);
    expect((await editing.hubRequest({ t: 'setEditor', command: 'code {path}' })).m).toMatchObject({ t: 'done' });
    expect((await editing.hubRequest({ t: 'addPreset', preset: HTOP })).m).toMatchObject({ t: 'done' });
    expect((await editing.hubRequest({ t: 'addRepo', host: 0, repo: added })).m).toMatchObject({ t: 'done' });
    opening.sendHello();
    await opening.waitFor('editor', (m) => m.command === 'code {path}');
    // The snapshot predates the edits, so they reached the session as broadcasts.
    expect(editorsOf(opening)[0]).toBe('kate');
    await opening.waitFor('presets', (m) => m.presets.length === 2);
    await opening.waitHost(0, (h) => h.repos.includes(added));
    expect(editorsOf(opening).at(-1)).toBe('code {path}');
    expect(presetsOf(opening).at(-1)).toEqual([SHELL, HTOP]);
    expect(opening.hosts()[0]?.repos).toEqual([fx.repo, added]);
  });
});
