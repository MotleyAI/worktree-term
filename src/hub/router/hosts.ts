import { DAEMON_PROTOCOL_VERSION, type HostEntry } from '../../protocol/index.js';

/** The status of one host as one session sees it. */
export interface HostState {
  status: HostEntry['status'];
  /** The cause of the latest failure while reconnecting or down. */
  reason: string | null;
  daemonVersion: string | null;
  instance: string | null;
  /** The Tailscale check login URL while needs-login. */
  login: string | null;
  /** Consecutive failed dials or lost links. */
  failures: number;
}

export type HostEvent =
  | { kind: 'hello'; protocol: number; version: string; instance: string }
  | { kind: 'failed'; reason: string }
  /** The link waits for a Tailscale check to be approved at `url`. */
  | { kind: 'login'; url: string }
  /** The link was replaced by a new one without a failure. */
  | { kind: 'redial' };

const DOWN_AFTER = 3;
const FIRST_RETRY_MS = 250;
const MAX_RETRY_MS = 5000;
const MAX_NAME = 64;
const MAX_REASON = 1024;

export const initialHostState: HostState = {
  status: 'connecting',
  reason: null,
  daemonVersion: null,
  instance: null,
  login: null,
  failures: 0,
};

const failedState = (state: HostState, reason: string): HostState => {
  const failures = state.failures + 1;
  return {
    status: failures >= DOWN_AFTER ? 'down' : 'reconnecting',
    reason: reason.slice(0, MAX_REASON),
    daemonVersion: null,
    instance: null,
    login: null,
    failures,
  };
};

export const hostTransition = (state: HostState, event: HostEvent): HostState => {
  switch (event.kind) {
    case 'hello': {
      const status = event.protocol === DAEMON_PROTOCOL_VERSION ? 'connected' : 'outdated';
      return { status, reason: null, daemonVersion: event.version, instance: event.instance, login: null, failures: 0 };
    }
    case 'login':
      return { ...initialHostState, status: 'needs-login', login: event.url, failures: state.failures };
    case 'redial':
      return { ...initialHostState, failures: state.failures };
    case 'failed':
      return failedState(state, event.reason);
  }
};

/** The key of a host shared by every session configuring it. */
export const hostKey = (host: { name: string; ssh: string | null }): string =>
  host.ssh === null ? 'local' : `remote:${host.name}:${host.ssh}`;

/** Delay before the next dial after `failures` consecutive failures. */
export const retryDelay = (failures: number): number => Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** Math.max(0, failures - 1));

/** The local host's name: the host name cut to 64 characters, `local` when empty. */
export const localHostName = (raw: string): string => raw.slice(0, MAX_NAME) || 'local';
