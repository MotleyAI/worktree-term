import { describe, expect, it } from 'vitest';
import { groupRemoval, hostPath, repoGroups, type GroupHost } from './groups.js';
import { worktreeTitle } from './marks.js';

const APP = 'github.com/acme/app';
const API = 'github.com/acme/api';

const repo = (path: string, origin: string | null = null) => ({ path, origin });

const laptop = (repos: GroupHost['repos'], clones: GroupHost['clones'] = []): GroupHost => ({
  idx: 0,
  name: 'laptop',
  remote: false,
  repos,
  clones,
});
const box = (repos: GroupHost['repos'], clones: GroupHost['clones'] = []): GroupHost => ({
  idx: 1,
  name: 'box',
  remote: true,
  repos,
  clones,
});
const gpu = (repos: GroupHost['repos'], clones: GroupHost['clones'] = []): GroupHost => ({
  idx: 2,
  name: 'gpu',
  remote: true,
  repos,
  clones,
});

describe('repoGroups', () => {
  it('puts this machine’s and a remote host’s repos of one origin in one tab labelled like the first', () => {
    expect(repoGroups([laptop([repo('/r/app', APP)]), box([repo('/srv/app', APP)])])).toEqual([
      {
        key: `origin:${APP}`,
        label: 'app',
        host: 0,
        repo: '/r/app',
        title: '/r/app\nbox:/srv/app',
        members: [
          { host: 0, repo: '/r/app', listed: true, name: '/r/app' },
          { host: 1, repo: '/srv/app', listed: true, name: 'box:/srv/app' },
        ],
      },
    ]);
  });

  it('keeps a remote-only repo’s tab, gathering other hosts’ repos of its origin', () => {
    const groups = repoGroups([laptop([]), box([repo('/srv/api', API)]), gpu([repo('/data/api', API)])]);
    expect(groups.map((g) => [g.key, g.label, g.host, g.repo])).toEqual([[`origin:${API}`, 'box:api', 1, '/srv/api']]);
    expect(groups[0]?.members.map((m) => [m.host, m.repo])).toEqual([
      [1, '/srv/api'],
      [2, '/data/api'],
    ]);
  });

  it('keeps origin-less repos apart, each keyed by its host’s name and path', () => {
    const groups = repoGroups([laptop([repo('/r/a')]), box([repo('/srv/a')])]);
    expect(groups.map((g) => [g.key, g.label])).toEqual([
      ['laptop:/r/a', 'a'],
      ['box:/srv/a', 'box:a'],
    ]);
  });

  it('gives a repo whose origin is not yet known a tab of its own, keyed and labelled by its host', () => {
    const groups = repoGroups([laptop([repo('/r/app', APP)]), box([repo('/srv/app')])]);
    expect(groups.map((g) => [g.key, g.label, g.host, g.repo])).toEqual([
      [`origin:${APP}`, 'app', 0, '/r/app'],
      ['box:/srv/app', 'box:app', 1, '/srv/app'],
    ]);
  });

  it('merges a down host’s repo into its origin’s tab once its origin is known', () => {
    const before = repoGroups([laptop([repo('/r/app', APP)]), box([repo('/srv/app')])]);
    expect(before.map((g) => g.label)).toEqual(['app', 'box:app']);
    const after = repoGroups([laptop([repo('/r/app', APP)]), box([repo('/srv/app', APP)])]);
    expect(after.map((g) => g.label)).toEqual(['app']);
    expect(after[0]?.members.map((m) => m.name)).toEqual(['/r/app', 'box:/srv/app']);
  });

  it('puts two listed local clones of one origin in one tab labelled like the first', () => {
    const groups = repoGroups([laptop([repo('/r/app', APP), repo('/r/app-2', APP)])]);
    expect(groups.map((g) => [g.label, g.repo])).toEqual([['app', '/r/app']]);
    expect(groups[0]?.members.map((m) => m.repo)).toEqual(['/r/app', '/r/app-2']);
  });

  it('disambiguates duplicate directory names among a host’s repos', () => {
    const groups = repoGroups([laptop([repo('/a/x/app', APP), repo('/b/y/app', API)])]);
    expect(groups.map((g) => g.label)).toEqual(['x/app', 'y/app']);
  });

  it('adds as many leading segments as uniqueness needs', () => {
    const groups = repoGroups([laptop([repo('/a/x/app', APP), repo('/b/x/app', API)])]);
    expect(groups.map((g) => g.label)).toEqual(['a/x/app', 'b/x/app']);
  });

  it('makes labels unique within each host only, prefixing a remote host’s with its name', () => {
    const groups = repoGroups([laptop([repo('/c/app', 'github.com/acme/c')]), box([repo('/a/app', APP), repo('/b/app', API)])]);
    expect(groups.map((g) => g.label)).toEqual(['app', 'box:a/app', 'box:b/app']);
  });

  it('orders tabs by each group’s first listed member in hub order', () => {
    const groups = repoGroups([
      laptop([repo('/r/lib', 'github.com/acme/lib'), repo('/r/app', APP)]),
      box([repo('/srv/tool', 'github.com/acme/tool'), repo('/srv/app', APP)]),
    ]);
    expect(groups.map((g) => g.label)).toEqual(['lib', 'app', 'box:tool']);
  });

  it('adds a discovered clone to its origin’s tab without labelling or keying the tab by it', () => {
    const groups = repoGroups([laptop([], [{ path: '/r/app', origin: APP }]), box([repo('/srv/app', APP)])]);
    expect(groups.map((g) => [g.key, g.label, g.host, g.repo])).toEqual([[`origin:${APP}`, 'box:app', 1, '/srv/app']]);
    expect(groups[0]?.members).toEqual([
      { host: 0, repo: '/r/app', listed: false, name: '/r/app' },
      { host: 1, repo: '/srv/app', listed: true, name: 'box:/srv/app' },
    ]);
  });

  it('never makes a tab of a discovered clone whose origin no listed repo has', () => {
    const groups = repoGroups([laptop([repo('/r/app', APP)]), box([], [{ path: '/srv/other', origin: 'github.com/acme/other' }])]);
    expect(groups.map((g) => g.label)).toEqual(['app']);
    expect(groups[0]?.members.map((m) => m.name)).toEqual(['/r/app']);
  });

  it('lists members this machine first, then each remote host in hub order, a host’s repos in path order', () => {
    const groups = repoGroups([
      laptop([repo('/r/b', APP)], [{ path: '/r/a', origin: APP }]),
      box([], [{ path: '/srv/app', origin: APP }]),
      gpu([repo('/g/app', APP)]),
    ]);
    expect(groups.map((g) => [g.label, g.repo])).toEqual([['b', '/r/b']]);
    expect(groups[0]?.members.map((m) => m.name)).toEqual(['/r/a', '/r/b', 'box:/srv/app', 'gpu:/g/app']);
  });

  it('hovers with the path of every member, prefixed with a remote host’s name', () => {
    const groups = repoGroups([laptop([repo('/r/app', APP)]), box([], [{ path: '/srv/app', origin: APP }]), gpu([repo('/g/app', APP)])]);
    expect(groups[0]?.title).toBe('/r/app\nbox:/srv/app\ngpu:/g/app');
  });

  it('lists no tabs for hosts without repos', () => {
    expect(repoGroups([laptop([]), box([])])).toEqual([]);
  });
});

describe('hostPath', () => {
  it('shows a path of this machine as it is', () => {
    expect(hostPath({ name: 'laptop', remote: false }, '/r/app')).toBe('/r/app');
  });

  it('prefixes a remote host’s path with its name', () => {
    expect(hostPath({ name: 'box', remote: true }, '/srv/app-fix')).toBe('box:/srv/app-fix');
  });

  it('starts a remote worktree’s hover text', () => {
    expect(worktreeTitle(hostPath({ name: 'box', remote: true }, '/srv/app-fix'), [])).toBe('box:/srv/app-fix\nno terminals');
  });
});

describe('groupRemoval', () => {
  it('names and removes every listed member of the group, not its discovered clones', () => {
    const [group] = repoGroups([
      laptop([repo('/r/app', APP)]),
      box([repo('/srv/app', APP)]),
      gpu([], [{ path: '/data/app', origin: APP }]),
    ]);
    if (group === undefined) throw new Error('no group');
    expect(groupRemoval(group)).toEqual({
      names: ['/r/app', 'box:/srv/app'],
      members: [
        { host: 0, repo: '/r/app' },
        { host: 1, repo: '/srv/app' },
      ],
    });
  });

  it('removes a group of one listed repo', () => {
    const [group] = repoGroups([box([repo('/srv/a')])]);
    if (group === undefined) throw new Error('no group');
    expect(groupRemoval(group)).toEqual({ names: ['box:/srv/a'], members: [{ host: 1, repo: '/srv/a' }] });
  });
});
