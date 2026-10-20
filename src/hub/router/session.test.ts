import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeMessage, DAEMON_PROTOCOL_VERSION, type HostEntry, type MessageOf } from '../../protocol/index.js';
import { parseConfig } from '../config/index.js';
import type { DaemonEndpoint, Link, LinkEvents } from '../links/index.js';
import { HostCoordinator } from './coordinator.js';
import { HostGoneError, Session, type BrowserChannel, type HubOpenOutcome, type SessionContext, type SessionHost } from './session.js';

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

const start = (overrides: Partial<SessionContext> = {}, hosts: readonly SessionHost[] = [box]): Started => {
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
    coordinator: () => new HostCoordinator({ restart: unused, reinstall: unused, install: unused }),
    listsRepo: unused,
    editRepos: unused,
    reposEdited: unused,
    editPresets: unused,
    presetsEdited: unused,
    openHub: unused,
    installHub: unused,
    ...overrides,
  };
  const session = new Session(
    channel,
    context,
    { config: parseConfig(null, '/home/u'), problem: null },
    hosts.map((h) => ({ ...h })),
  );
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

type OpenEvents = Parameters<SessionContext['openHub']>[1];

/** An `openHub` recording each opening's host, events and cancellation. */
const openings = (): {
  openHub: SessionContext['openHub'];
  opened: { name: string; events: OpenEvents; cancelled: boolean }[];
} => {
  const opened: { name: string; events: OpenEvents; cancelled: boolean }[] = [];
  return {
    opened,
    openHub: (name, events) => {
      const opening = { name, events, cancelled: false };
      opened.push(opening);
      return {
        cancel: () => {
          opening.cancelled = true;
        },
      };
    },
  };
};

const local: SessionHost = { idx: 0, name: 'laptop', ssh: null, repos: [], roots: [] };
const URL_OF_BOX = `http://127.0.0.1:7418/#code=${'a'.repeat(64)}&host=box&home=7417&hubs=box`;

describe('Session hub openings', () => {
  it('opens the remote host by name, sending its login link and then hubOpened', () => {
    const { openHub, opened } = openings();
    const { session, sent } = start({ openHub }, [local, { ...box, idx: 1 }]);
    session.receive({ t: 'openHub', req: 4, host: 1 });
    expect(opened.map((o) => o.name)).toEqual(['box']);
    opened[0]?.events.login(LOGIN_URL);
    opened[0]?.events.done({ kind: 'opened', url: URL_OF_BOX });
    expect(sent.slice(-2)).toEqual([
      { t: 'hubLogin', req: 4, login: LOGIN_URL },
      { t: 'hubOpened', req: 4, url: URL_OF_BOX },
    ]);
    session.close();
  });

  it.each<[string, HubOpenOutcome]>([
    ['hub-outdated', { kind: 'error', code: 'hub-outdated', message: 'wtd on box is missing or too old to serve its hub' }],
    ['hub-failed', { kind: 'error', code: 'hub-failed', message: 'ssh: Could not resolve hostname box' }],
  ])('answers a %s opening with the host index', (_code, outcome) => {
    const { openHub, opened } = openings();
    const { session, sent } = start({ openHub }, [local, { ...box, idx: 1 }]);
    session.receive({ t: 'openHub', req: 4, host: 1 });
    opened[0]?.events.done(outcome);
    expect(sent.at(-1)).toEqual(
      outcome.kind === 'error' ? { t: 'error', req: 4, host: 1, code: outcome.code, message: outcome.message } : null,
    );
    session.close();
  });

  it.each([
    ['the local host', 0],
    ['an index beyond the hosts', 7],
  ])('answers unknown-host for %s without opening anything', (_name, idx) => {
    const { openHub, opened } = openings();
    const { session, sent } = start({ openHub }, [local, { ...box, idx: 1 }]);
    session.receive({ t: 'openHub', req: 4, host: idx });
    expect(opened).toEqual([]);
    expect(sent.at(-1)).toMatchObject({ t: 'error', req: 4, host: idx, code: 'unknown-host' });
    session.close();
  });

  it('cancels the opening in progress when a newer one arrives', () => {
    const { openHub, opened } = openings();
    const { session } = start({ openHub }, [local, { ...box, idx: 1 }, { ...box, idx: 2, name: 'gpu', ssh: 'gpu' }]);
    session.receive({ t: 'openHub', req: 4, host: 1 });
    session.receive({ t: 'openHub', req: 5, host: 2 });
    expect(opened.map((o) => [o.name, o.cancelled])).toEqual([
      ['box', true],
      ['gpu', false],
    ]);
    session.close();
  });

  it('cancels the opening in progress when the session closes', () => {
    const { openHub, opened } = openings();
    const { session } = start({ openHub }, [local, { ...box, idx: 1 }]);
    session.receive({ t: 'openHub', req: 4, host: 1 });
    session.close();
    expect(opened[0]?.cancelled).toBe(true);
  });

  it('answers installHub with done, or unknown-host once the host is gone', async () => {
    const installHub = vi
      .fn<SessionContext['installHub']>()
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new HostGoneError('host box is no longer configured'));
    const { session, sent } = start({ installHub }, [local, { ...box, idx: 1 }]);
    session.receive({ t: 'installHub', req: 4, host: 1 });
    await vi.waitFor(() => {
      expect(sent.at(-1)).toEqual({ t: 'done', req: 4 });
    });
    session.receive({ t: 'installHub', req: 5, host: 1 });
    await vi.waitFor(() => {
      expect(sent.at(-1)).toMatchObject({ t: 'error', req: 5, host: 1, code: 'unknown-host' });
    });
    expect(installHub.mock.calls).toEqual([['box'], ['box']]);
    session.close();
  });
});
