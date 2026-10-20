import { describe, expect, it } from 'vitest';
import type { MessageOf } from '../../protocol/index.js';
import { hubLineText, hubsMenu, hubStep, initialHubState, type HubAction, type HubEffect, type HubState } from './hubs.js';

type HubMessage = MessageOf<'hubToBrowser'>;

const CODE = '0123456789abcdef'.repeat(4);
const LOGIN = 'https://login.tailscale.com/a/abc123';
const BOX_URL = `http://127.0.0.1:7418/#code=${CODE}&host=box&home=7417&hubs=box,gpu`;

const local = { idx: 0, name: 'laptop', remote: false };
const box = { idx: 1, name: 'box', remote: true };
const gpu = { idx: 2, name: 'gpu', remote: true };

/** Applies `actions` in order from the initial state, collecting every effect. */
const run = (...actions: HubAction[]): { state: HubState; effects: HubEffect[] } => {
  let state = initialHubState;
  const effects: HubEffect[] = [];
  for (const action of actions) {
    const step = hubStep(state, action);
    state = step.state;
    effects.push(step.effect);
  }
  return { state, effects };
};

const reply = (m: HubMessage): HubAction => ({ t: 'reply', m });
const openBox = (req = 1): HubAction => ({ t: 'open', req, host: 1, name: 'box' });
const failed = (req: number, code: Extract<HubMessage, { t: 'error' }>['code'], message: string): HubAction =>
  reply({ t: 'error', req, host: 1, code, message });

describe('hubsMenu', () => {
  it('lists This machine, marked, then each remote host on a home page', () => {
    expect(hubsMenu(null, [local, box, gpu])).toEqual([
      { label: 'This machine', marked: true, target: { t: 'stay' } },
      { label: 'box', marked: false, target: { t: 'open', host: 1, name: 'box' } },
      { label: 'gpu', marked: false, target: { t: 'open', host: 2, name: 'gpu' } },
    ]);
  });

  it('shows no menu without remote hosts', () => {
    expect(hubsMenu(null, [local])).toBeNull();
    expect(hubsMenu(null, [])).toBeNull();
  });

  it('routes a remote page back through its home hub, marking its own host', () => {
    expect(hubsMenu({ host: 'box', home: 7417, hubs: ['box', 'gpu'] }, [local])).toEqual([
      { label: 'This machine', marked: false, target: { t: 'navigate', url: 'http://127.0.0.1:7417/' } },
      { label: 'box', marked: true, target: { t: 'stay' } },
      { label: 'gpu', marked: false, target: { t: 'navigate', url: 'http://127.0.0.1:7417/#hub=gpu' } },
    ]);
  });

  it('lists a remote page’s kept hubs, not its session’s hosts', () => {
    const entries = hubsMenu({ host: 'gpu', home: 9000, hubs: ['gpu'] }, [local, box]);
    expect(entries?.map((e) => e.label)).toEqual(['This machine', 'gpu']);
    expect(entries?.[0]?.target).toEqual({ t: 'navigate', url: 'http://127.0.0.1:9000/' });
  });
});

describe('hubLineText', () => {
  it.each([
    [{ kind: 'opening', name: 'box' }, 'Opening box…'],
    [{ kind: 'login', name: 'box', login: LOGIN }, 'box needs Tailscale login'],
    [{ kind: 'outdated', name: 'box', message: 'wtd is too old' }, 'box: wtd is too old'],
    [{ kind: 'installing', name: 'box' }, 'Installing on box…'],
    [{ kind: 'failed', name: 'box', message: 'ssh: Could not resolve hostname box' }, 'box: ssh: Could not resolve hostname box'],
    [{ kind: 'unknown', name: 'nope' }, 'no host named nope'],
  ] as const)('shows %j as %j', (line, text) => {
    expect(hubLineText(line)).toBe(text);
  });
});

describe('hubStep', () => {
  it('starts with no line and nothing pending', () => {
    expect(initialHubState).toEqual({ line: null, pending: null });
  });

  it('shows Opening while the opening waits', () => {
    const { state, effects } = run(openBox());
    expect(state.line).toEqual({ kind: 'opening', name: 'box' });
    expect(state.pending).toEqual({ req: 1, host: 1, name: 'box' });
    expect(effects).toEqual([null]);
  });

  it('shows the login link of the pending opening', () => {
    const { state } = run(openBox(), reply({ t: 'hubLogin', req: 1, login: LOGIN }));
    expect(state.line).toEqual({ kind: 'login', name: 'box', login: LOGIN });
  });

  it('navigates to the URL of the pending opening', () => {
    const { effects } = run(openBox(), reply({ t: 'hubLogin', req: 1, login: LOGIN }), reply({ t: 'hubOpened', req: 1, url: BOX_URL }));
    expect(effects).toEqual([null, null, { t: 'navigate', url: BOX_URL }]);
  });

  it('ignores replies to an earlier pick', () => {
    const { state, effects } = run(
      openBox(1),
      { t: 'open', req: 2, host: 2, name: 'gpu' },
      reply({ t: 'hubOpened', req: 1, url: BOX_URL }),
      reply({ t: 'hubLogin', req: 1, login: LOGIN }),
      failed(1, 'hub-failed', 'late'),
    );
    expect(state.line).toEqual({ kind: 'opening', name: 'gpu' });
    expect(effects).toEqual([null, null, null, null, null]);
  });

  it('offers a reinstall for an outdated host', () => {
    const { state } = run(openBox(), failed(1, 'hub-outdated', 'wtd on the host is missing or too old to serve its hub'));
    expect(state.line).toEqual({ kind: 'outdated', name: 'box', message: 'wtd on the host is missing or too old to serve its hub' });
  });

  it('shows Installing, then reopens the hub once the install is done', () => {
    const { state, effects } = run(openBox(1), failed(1, 'hub-outdated', 'too old'), { t: 'install', req: 2, host: 1, name: 'box' });
    expect(state.line).toEqual({ kind: 'installing', name: 'box' });
    expect(effects.at(-1)).toBeNull();
    expect(hubStep(state, reply({ t: 'done', req: 2 })).effect).toEqual({ t: 'reopen', host: 1, name: 'box' });
  });

  it('shows a failed install with its reason', () => {
    const { state, effects } = run(
      openBox(1),
      failed(1, 'hub-outdated', 'too old'),
      { t: 'install', req: 2, host: 1, name: 'box' },
      failed(2, 'internal', 'install: no Node'),
    );
    expect(state.line).toEqual({ kind: 'failed', name: 'box', message: 'install: no Node' });
    expect(effects.at(-1)).toBeNull();
  });

  it('ignores a done for an opening', () => {
    const { state, effects } = run(openBox(), reply({ t: 'done', req: 1 }));
    expect(state.line).toEqual({ kind: 'opening', name: 'box' });
    expect(effects).toEqual([null, null]);
  });

  it.each([
    ['hub-failed', 'ssh: Could not resolve hostname box'],
    ['unknown-host', 'no such host'],
  ] as const)('shows a %s error with its reason until dismissed', (code, message) => {
    const { state } = run(openBox(), failed(1, code, message));
    expect(state.line).toEqual({ kind: 'failed', name: 'box', message });
    expect(state.pending).toBeNull();
    expect(hubStep(state, { t: 'dismiss' }).state.line).toBeNull();
  });

  it('shows an unknown hub name', () => {
    const { state, effects } = run({ t: 'unknown', name: 'nope' });
    expect(state.line).toEqual({ kind: 'unknown', name: 'nope' });
    expect(effects).toEqual([null]);
  });

  it('drops a pending opening when an unknown name follows it', () => {
    const { state, effects } = run(openBox(), { t: 'unknown', name: 'nope' }, reply({ t: 'hubOpened', req: 1, url: BOX_URL }));
    expect(state.line).toEqual({ kind: 'unknown', name: 'nope' });
    expect(effects.at(-1)).toBeNull();
  });
});
