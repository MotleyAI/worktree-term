import { describe, expect, it } from 'vitest';
import type { HostEntry } from '../../protocol/index.js';
import { cloneStep, initialCloneState, type CloneAction, type CloneEffect, type CloneState } from './clones.js';

const APP = 'github.com/acme/app';
const OTHER = 'github.com/acme/other';

/** Applies `actions` in order from the initial state, collecting each step's effects. */
const run = (...actions: CloneAction[]): { state: CloneState; effects: CloneEffect[][] } => {
  let state = initialCloneState;
  const effects: CloneEffect[][] = [];
  for (const action of actions) {
    const step = cloneStep(state, action);
    state = step.state;
    effects.push(step.effects);
  }
  return { state, effects };
};

const host = (idx: number, status: HostEntry['status'], repos: readonly string[] = [], name = `h${String(idx)}`) => ({
  idx,
  name,
  status,
  repos,
});
const hosts = (...entries: ReturnType<typeof host>[]): CloneAction => ({ t: 'hosts', hosts: entries });
const origin = (idx: number, repo: string, value: string | null): CloneAction => ({ t: 'origin', host: idx, repo, origin: value });
const discovered = (idx: number, ...repos: { path: string; origin: string | null }[]): CloneAction => ({
  t: 'discovered',
  host: idx,
  name: `h${String(idx)}`,
  repos,
});

/** This machine listing `/r/app` and remote host `box`, both connected. */
const CONNECTED = hosts(host(0, 'connected', ['/r/app']), host(1, 'connected'));

describe('cloneStep', () => {
  it('starts with nothing watched', () => {
    expect(initialCloneState.watched).toEqual([]);
  });

  it('discovers every connected host once when the session starts, this machine included', () => {
    const { effects } = run(hosts(host(0, 'connected'), host(1, 'connected'), host(2, 'down'), host(3, 'connecting')));
    expect(effects).toEqual([
      [
        { t: 'discover', host: 0 },
        { t: 'discover', host: 1 },
      ],
    ]);
  });

  it('discovers a host connecting later exactly once, after its first connection', () => {
    const { effects } = run(
      hosts(host(0, 'connected'), host(1, 'down')),
      hosts(host(0, 'connected'), host(1, 'connected')),
      hosts(host(0, 'connected'), host(1, 'reconnecting')),
      hosts(host(0, 'connected'), host(1, 'connected')),
      hosts(host(0, 'reconnecting'), host(1, 'connected')),
      hosts(host(0, 'connected'), host(1, 'connected')),
    );
    expect(effects).toEqual([[{ t: 'discover', host: 0 }], [{ t: 'discover', host: 1 }], [], [], [], []]);
  });

  it('discovers a host whose discovery failed again when it next becomes connected, not before', () => {
    const { effects } = run(
      hosts(host(0, 'connected'), host(1, 'connected')),
      { t: 'failed', host: 1, name: 'h1' },
      hosts(host(0, 'connected'), host(1, 'connected')),
      hosts(host(0, 'connected'), host(1, 'reconnecting')),
      hosts(host(0, 'connected'), host(1, 'connected')),
      hosts(host(0, 'connected'), host(1, 'reconnecting')),
      hosts(host(0, 'connected'), host(1, 'connected')),
    );
    expect(effects).toEqual([
      [
        { t: 'discover', host: 0 },
        { t: 'discover', host: 1 },
      ],
      [],
      [],
      [],
      [{ t: 'discover', host: 1 }],
      [],
      [],
    ]);
  });

  it('forgets what it knew of an index once it names another host, discovering that host afresh', () => {
    const { state, effects } = run(
      CONNECTED,
      origin(0, '/r/app', APP),
      discovered(1, { path: '/srv/app', origin: APP }),
      hosts(host(0, 'connected', ['/r/app']), host(1, 'connected', [], 'vm')),
    );
    expect(effects[3]).toEqual([{ t: 'discover', host: 1 }]);
    expect(state.watched).toEqual([]);
    expect(state.found.has(1)).toBe(false);
  });

  it('ignores a discovery reply or failure of the host an index named before', () => {
    const { state } = run(
      CONNECTED,
      origin(0, '/r/app', APP),
      hosts(host(0, 'connected', ['/r/app']), host(1, 'connected', [], 'vm')),
      discovered(1, { path: '/srv/app', origin: APP }),
      { t: 'failed', host: 1, name: 'h1' },
    );
    expect(state.found.has(1)).toBe(false);
    expect(state.watched).toEqual([]);
    expect(state.discovering).toContain(1);
  });

  it('watches a remote clone with a listed repo’s origin, and no other discovered repo', () => {
    const { state, effects } = run(
      CONNECTED,
      origin(0, '/r/app', APP),
      discovered(1, { path: '/home/me/src/app', origin: APP }, { path: '/home/me/src/other', origin: OTHER }),
    );
    expect(effects.at(-1)).toEqual([{ t: 'watch', host: 1, path: '/home/me/src/app' }]);
    expect(state.watched).toEqual([{ host: 1, path: '/home/me/src/app', origin: APP }]);
  });

  it('watches a local clone, never the listed repo discovery finds too', () => {
    const { effects } = run(
      CONNECTED,
      origin(0, '/r/app', APP),
      discovered(0, { path: '/r/app', origin: APP }, { path: '/r/app-2', origin: APP }),
    );
    expect(effects.at(-1)).toEqual([{ t: 'watch', host: 0, path: '/r/app-2' }]);
  });

  it('watches a clone once the matching origin arrives after the discovery reply', () => {
    const { state, effects } = run(CONNECTED, discovered(1, { path: '/home/me/src/app', origin: APP }), origin(0, '/r/app', APP));
    expect(effects.slice(1)).toEqual([[], [{ t: 'watch', host: 1, path: '/home/me/src/app' }]]);
    expect(state.watched).toEqual([{ host: 1, path: '/home/me/src/app', origin: APP }]);
  });

  it('never matches null origins', () => {
    const { state, effects } = run(
      CONNECTED,
      origin(0, '/r/app', null),
      discovered(1, { path: '/srv/app', origin: null }),
      origin(0, '/r/app', null),
    );
    expect(effects.slice(1)).toEqual([[], [], []]);
    expect(state.watched).toEqual([]);
  });

  it('watches each (host, path) once, however many listed repos share its origin', () => {
    const { effects } = run(
      hosts(host(0, 'connected', ['/r/app', '/r/app-2']), host(1, 'connected')),
      discovered(1, { path: '/srv/app', origin: APP }),
      origin(0, '/r/app', APP),
      origin(0, '/r/app-2', APP),
      origin(0, '/r/app', APP),
    );
    expect(effects.slice(1)).toEqual([[], [{ t: 'watch', host: 1, path: '/srv/app' }], [], []]);
  });

  it('watches the same path on two hosts as two clones', () => {
    const { state } = run(
      hosts(host(0, 'connected', ['/r/app']), host(1, 'connected'), host(2, 'connected')),
      origin(0, '/r/app', APP),
      discovered(1, { path: '/srv/app', origin: APP }),
      discovered(2, { path: '/srv/app', origin: APP }),
    );
    expect(state.watched).toEqual([
      { host: 1, path: '/srv/app', origin: APP },
      { host: 2, path: '/srv/app', origin: APP },
    ]);
  });

  it('matches only the origins of repos their host lists', () => {
    const { state, effects } = run(
      hosts(host(0, 'connected', ['/r/app']), host(1, 'connected'), host(2, 'connected')),
      origin(1, '/srv/app', APP),
      discovered(2, { path: '/data/app', origin: APP }),
    );
    expect(effects.slice(1)).toEqual([[], []]);
    expect(state.watched).toEqual([]);
  });

  it('matches a listed repo of any host, a remote one included', () => {
    const { effects } = run(
      hosts(host(0, 'connected'), host(1, 'connected', ['/srv/api'])),
      origin(1, '/srv/api', 'github.com/acme/api'),
      discovered(0, { path: '/r/api', origin: 'github.com/acme/api' }),
    );
    expect(effects.at(-1)).toEqual([{ t: 'watch', host: 0, path: '/r/api' }]);
  });
});
