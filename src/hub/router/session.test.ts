import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeMessage, DAEMON_PROTOCOL_VERSION, type HostEntry, type MessageOf } from '../../protocol/index.js';
import { parseConfig } from '../config/index.js';
import type { DaemonEndpoint, Link, LinkEvents } from '../links/index.js';
import { HostCoordinator } from './coordinator.js';
import { Session, type BrowserChannel, type SessionContext, type SessionHost } from './session.js';

const LOGIN_URL = 'https://login.tailscale.com/a/abc123';

/** A link the test drives through the events it was opened with. */
class FakeLink implements Link {
  closed = false;

  constructor(readonly events: LinkEvents) {}

  send(): void {
    // Nothing reads what the session sends.
  }

  pause(): void {
    // Nothing to read.
  }

  resume(): void {
    // Nothing to read.
  }

  close(): void {
    this.closed = true;
  }
}

class FakeEndpoint implements DaemonEndpoint {
  readonly links: FakeLink[] = [];

  open(events: LinkEvents): Link {
    const link = new FakeLink(events);
    this.links.push(link);
    return link;
  }
}

/** The `login` callback the session gave `link`; fails the test when there is none. */
const loginOf = (link: FakeLink | undefined): ((url: string) => void) => {
  const login = link?.events.login;
  if (login === undefined) throw new Error('the session gave its link no login callback');
  return login;
};

const unused = (): never => {
  throw new Error('not used by this test');
};

const box: SessionHost = { idx: 0, name: 'box', ssh: 'box', repos: [], roots: [] };

interface Started {
  session: Session;
  endpoint: FakeEndpoint;
  sent: MessageOf<'hubToBrowser'>[];
  host: () => HostEntry | undefined;
}

const start = (): Started => {
  const sent: MessageOf<'hubToBrowser'>[] = [];
  const channel: BrowserChannel = {
    send: (data) => {
      if (typeof data === 'string') sent.push(decodeMessage('hubToBrowser', data));
    },
    unsent: () => 0,
  };
  const endpoint = new FakeEndpoint();
  const context: SessionContext = {
    hello: { t: 'hello', protocol: DAEMON_PROTOCOL_VERSION, version: '0.1.0', instance: 'hub_1' },
    endpoint: () => endpoint,
    coordinator: () => new HostCoordinator({ restart: unused, reinstall: unused }),
    listsRepo: unused,
    editRepos: unused,
    reposEdited: unused,
    editPresets: unused,
    presetsEdited: unused,
  };
  const session = new Session(channel, context, { config: parseConfig(null, '/home/u'), problem: null }, [{ ...box }]);
  session.start();
  const host = (): HostEntry | undefined => sent.findLast((m) => m.t === 'hosts')?.hosts[0];
  return { session, endpoint, sent, host };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('Session Tailscale login', () => {
  it('shows the host as needs-login with the URL its link reports', () => {
    const { session, endpoint, host } = start();
    loginOf(endpoint.links[0])(LOGIN_URL);
    expect(host()).toMatchObject({ status: 'needs-login', login: LOGIN_URL, reason: null, instance: null });
    session.close();
  });

  it('ignores a login reported by a link it replaced after a retry', () => {
    vi.useFakeTimers();
    const { session, endpoint, sent, host } = start();
    const first = endpoint.links[0];
    loginOf(first)(LOGIN_URL);
    first?.events.ended(new Error('Tailscale SSH check timed out'));
    expect(host()).toMatchObject({ status: 'reconnecting', login: null });
    vi.advanceTimersByTime(1000);
    expect(endpoint.links).toHaveLength(2);
    const before = sent.length;
    loginOf(first)('https://login.tailscale.com/a/stale');
    expect(sent.slice(before).filter((m) => m.t === 'hosts')).toEqual([]);
    expect(host()).toMatchObject({ status: 'reconnecting', login: null });
    session.close();
  });

  it('ignores a login reported after the session closed', () => {
    const { session, endpoint, sent } = start();
    const login = loginOf(endpoint.links[0]);
    session.close();
    const before = sent.length;
    login(LOGIN_URL);
    expect(sent.slice(before)).toEqual([]);
    expect(endpoint.links).toHaveLength(1);
  });

  it('answers a request to a needs-login host with host-unavailable', () => {
    const { session, endpoint, sent, host } = start();
    loginOf(endpoint.links[0])(LOGIN_URL);
    expect(host()?.status).toBe('needs-login');
    session.receive({ t: 'host', host: 0, m: { t: 'watchRepo', req: 7, repo: '/srv/app' } });
    expect(sent.at(-1)).toMatchObject({ t: 'error', req: 7, host: 0, code: 'host-unavailable' });
    session.close();
  });
});
