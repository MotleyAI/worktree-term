import type { MessageOf } from '../../protocol/index.js';
import { homePageUrl, type RemotePage } from '../client/index.js';

type HubMessage = MessageOf<'hubToBrowser'>;

/** Where picking a Hubs menu entry goes: nowhere, another page, or an opening of a host's hub. */
export type HubTarget = { t: 'stay' } | { t: 'navigate'; url: string } | { t: 'open'; host: number; name: string };

export interface HubsEntry {
  label: string;
  /** The page's own hub. */
  marked: boolean;
  target: HubTarget;
}

const THIS_MACHINE = 'This machine';

/** The Hubs menu: on a home page its session's remote hosts, on a remote page its kept hubs; null without a remote host. */
export const hubsMenu = (
  remote: RemotePage | null,
  hosts: readonly { idx: number; name: string; remote: boolean }[],
): HubsEntry[] | null => {
  if (remote !== null) {
    return [
      { label: THIS_MACHINE, marked: false, target: { t: 'navigate', url: homePageUrl(remote.home, null) } },
      ...remote.hubs.map((name) =>
        name === remote.host
          ? { label: name, marked: true, target: { t: 'stay' } as const }
          : { label: name, marked: false, target: { t: 'navigate', url: homePageUrl(remote.home, name) } as const },
      ),
    ];
  }
  const remotes = hosts.filter((h) => h.remote);
  if (remotes.length === 0) return null;
  return [
    { label: THIS_MACHINE, marked: true, target: { t: 'stay' } },
    ...remotes.map((h) => ({ label: h.name, marked: false, target: { t: 'open', host: h.idx, name: h.name } as const })),
  ];
};

/** The status line of the latest hub opening. */
export type HubLine =
  | { kind: 'opening'; name: string }
  | { kind: 'login'; name: string; login: string }
  | { kind: 'outdated'; name: string; message: string }
  | { kind: 'installing'; name: string }
  | { kind: 'failed'; name: string; message: string }
  | { kind: 'unknown'; name: string };

export interface HubState {
  line: HubLine | null;
  /** The request whose replies the line follows. */
  pending: { req: number; host: number; name: string } | null;
}

export type HubAction =
  | { t: 'open'; req: number; host: number; name: string }
  | { t: 'install'; req: number; host: number; name: string }
  | { t: 'reply'; m: HubMessage }
  | { t: 'dismiss' }
  /** The address asked for a hub no remote host carries. */
  | { t: 'unknown'; name: string };

/** What the page does after a step: nothing, navigate the tab, or open the host's hub again. */
export type HubEffect = null | { t: 'navigate'; url: string } | { t: 'reopen'; host: number; name: string };

export const initialHubState: HubState = { line: null, pending: null };

export const hubLineText = (line: HubLine): string => {
  switch (line.kind) {
    case 'opening':
      return `Opening ${line.name}…`;
    case 'login':
      return `${line.name} needs Tailscale login`;
    case 'outdated':
    case 'failed':
      return `${line.name}: ${line.message}`;
    case 'installing':
      return `Installing on ${line.name}…`;
    case 'unknown':
      return `no host named ${line.name}`;
  }
};

const replyStep = (state: HubState, m: HubMessage): { state: HubState; effect: HubEffect } => {
  const { pending } = state;
  const unchanged = { state, effect: null };
  if (pending === null || !('req' in m) || m.req !== pending.req) return unchanged;
  const { name } = pending;
  switch (m.t) {
    case 'hubLogin':
      return { state: { ...state, line: { kind: 'login', name, login: m.login } }, effect: null };
    case 'hubOpened':
      return { state: { ...state, pending: null }, effect: { t: 'navigate', url: m.url } };
    case 'done':
      if (state.line?.kind !== 'installing') return unchanged;
      return { state: { ...state, pending: null }, effect: { t: 'reopen', host: pending.host, name } };
    case 'error': {
      const outdated = m.code === 'hub-outdated' && state.line?.kind !== 'installing';
      const line: HubLine = outdated ? { kind: 'outdated', name, message: m.message } : { kind: 'failed', name, message: m.message };
      return { state: { line, pending: null }, effect: null };
    }
    case 'reposDiscovered':
      return unchanged;
  }
};

/** The status line after `action`, for the latest opening only, and what the page then does. */
export const hubStep = (state: HubState, action: HubAction): { state: HubState; effect: HubEffect } => {
  switch (action.t) {
    case 'open':
      return {
        state: { line: { kind: 'opening', name: action.name }, pending: { req: action.req, host: action.host, name: action.name } },
        effect: null,
      };
    case 'install':
      return {
        state: { line: { kind: 'installing', name: action.name }, pending: { req: action.req, host: action.host, name: action.name } },
        effect: null,
      };
    case 'reply':
      return replyStep(state, action.m);
    case 'dismiss':
      return { state: { ...state, line: null }, effect: null };
    case 'unknown':
      return { state: { line: { kind: 'unknown', name: action.name }, pending: null }, effect: null };
  }
};
