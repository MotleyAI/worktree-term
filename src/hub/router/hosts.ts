import { PROTOCOL_VERSION, type HostEntry } from '../../protocol/index.js';

/** The status of one host as one session sees it. */
export interface HostState {
  status: HostEntry['status'];
  daemonVersion: string | null;
  instance: string | null;
  /** Consecutive failed dials or lost links. */
  failures: number;
}

export type HostEvent = { kind: 'hello'; protocol: number; version: string; instance: string } | { kind: 'failed' };

const DOWN_AFTER = 3;
const FIRST_RETRY_MS = 250;
const MAX_RETRY_MS = 5000;
const MAX_NAME = 64;

export const initialHostState: HostState = { status: 'connecting', daemonVersion: null, instance: null, failures: 0 };

export const hostTransition = (state: HostState, event: HostEvent): HostState => {
  if (event.kind === 'hello') {
    return event.protocol === PROTOCOL_VERSION
      ? { status: 'connected', daemonVersion: event.version, instance: event.instance, failures: 0 }
      : { status: 'outdated', daemonVersion: event.version, instance: null, failures: 0 };
  }
  const failures = state.failures + 1;
  return { status: failures >= DOWN_AFTER ? 'down' : 'reconnecting', daemonVersion: null, instance: null, failures };
};

/** Delay before the next dial after `failures` consecutive failures. */
export const retryDelay = (failures: number): number => Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** Math.max(0, failures - 1));

/** The local host's name: the host name cut to 64 characters, `local` when empty. */
export const localHostName = (raw: string): string => raw.slice(0, MAX_NAME) || 'local';
