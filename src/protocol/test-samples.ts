import type { Direction, Layout, MessageOf, Terminal, Worktree } from './index.js';

export type { Layout, Terminal, Worktree };
export type Pane = Layout['tabs'][number]['root'];
export type HostEntry = Extract<MessageOf<'hubToBrowser'>, { t: 'hosts' }>['hosts'][number];

export const REPO = '/home/u/repo';
export const WT = '/home/u/repo.worktrees/feat';
export const SHA1 = 'a'.repeat(40);
export const SHA256 = '0123456789abcdef'.repeat(4);

export const hello = { t: 'hello', protocol: 1, version: '0.1.0', instance: 'a1B2_c3' } as const;

export const mainWorktree: Worktree = {
  path: REPO,
  head: SHA1,
  branch: 'main',
  detached: false,
  locked: false,
  prunable: false,
  bare: false,
  main: true,
};

export const featWorktree: Worktree = {
  path: WT,
  head: SHA256,
  branch: null,
  detached: true,
  locked: true,
  prunable: true,
  bare: false,
  main: false,
};

export const liveTerminal: Terminal = {
  termId: 1,
  worktree: WT,
  preset: 'shell',
  cols: 80,
  rows: 24,
  exit: null,
  unseen: false,
  state: 'working',
};

export const exitedTerminal: Terminal = {
  termId: 2,
  worktree: WT,
  preset: 'claude',
  cols: 120,
  rows: 40,
  exit: { code: 1, signal: 'SIGTERM' },
  unseen: true,
  state: 'input',
};

export const layout: Layout = {
  tabs: [
    { id: 'main', root: { split: 'right', ratio: 0.5, a: { term: 1 }, b: { split: 'down', ratio: 0.25, a: { term: 2 }, b: { term: 3 } } } },
    { id: 'logs', root: { term: 4 } },
  ],
  active: 1,
};

/** One tab at the 8-pane limit, mixing right and down splits. */
export const fullTabLayout: Layout = {
  tabs: [
    {
      id: 'full',
      root: {
        split: 'right',
        ratio: 0.5,
        a: {
          split: 'down',
          ratio: 0.5,
          a: { split: 'right', ratio: 0.5, a: { term: 1 }, b: { term: 2 } },
          b: { split: 'right', ratio: 0.5, a: { term: 3 }, b: { term: 4 } },
        },
        b: {
          split: 'down',
          ratio: 0.5,
          a: { split: 'right', ratio: 0.5, a: { term: 5 }, b: { term: 6 } },
          b: { split: 'down', ratio: 0.5, a: { term: 7 }, b: { term: 8 } },
        },
      },
    },
  ],
  active: 0,
};

export const hosts: HostEntry[] = [
  { idx: 0, name: 'local', remote: false, status: 'connected', daemonVersion: '0.1.0', instance: 'd_1-A', repos: [REPO] },
  { idx: 1, name: 'devbox', remote: true, status: 'outdated', daemonVersion: '0.0.9', instance: null, repos: [] },
  { idx: 2, name: 'gpu', remote: true, status: 'connecting', daemonVersion: null, instance: null, repos: [WT] },
  { idx: 3, name: 'old', remote: true, status: 'reconnecting', daemonVersion: null, instance: null, repos: [] },
  { idx: 65535, name: 'x'.repeat(64), remote: true, status: 'down', daemonVersion: null, instance: null, repos: [] },
];

export const TOKEN = '0123456789abcdef'.repeat(4);

export const clientToDaemonSamples: MessageOf<'clientToDaemon'>[] = [
  hello,
  { t: 'shutdown' },
  { t: 'watchRepo', req: 1, repo: REPO },
  { t: 'unwatchRepo', req: 2, repo: REPO },
  { t: 'discoverRepos', req: 3, roots: ['/home/u/GitHub', '/srv'], depth: 3 },
  { t: 'createTerm', req: 4, worktree: WT, preset: 'claude', command: 'claude --resume', cols: 80, rows: 24 },
  { t: 'createTerm', req: 5, worktree: WT, preset: 'shell', command: null, cols: 1000, rows: 1 },
  { t: 'attach', req: 6, termId: 1 },
  { t: 'detach', req: 7, termId: 1 },
  { t: 'resize', termId: 1, cols: 120, rows: 40 },
  { t: 'closeTerm', req: 8, termId: 4294967295 },
  { t: 'ack', termId: 1, offset: 65536 },
  { t: 'setVisible', termIds: [1, 2] },
  { t: 'setVisible', termIds: [] },
  { t: 'setChecked', req: 9, worktree: WT, checked: true },
  { t: 'setLayout', req: 10, worktree: WT, layout },
];

export const daemonToClientSamples: MessageOf<'daemonToClient'>[] = [
  hello,
  { t: 'done', req: 1 },
  { t: 'error', req: 2, code: 'unknown-term', message: 'no such terminal' },
  { t: 'error', req: null, code: 'internal', message: '' },
  { t: 'error', req: 5, code: 'not-a-repo', message: 'not a repository' },
  {
    t: 'repoState',
    repo: REPO,
    worktrees: [mainWorktree, featWorktree],
    terminals: [liveTerminal, exitedTerminal],
    checked: [WT],
    layouts: [{ worktree: WT, layout }],
  },
  { t: 'repoState', repo: REPO, worktrees: [], terminals: [], checked: [], layouts: [] },
  { t: 'worktreesChanged', repo: REPO, worktrees: [mainWorktree] },
  { t: 'termCreated', req: 3, term: liveTerminal },
  { t: 'termCreated', req: null, term: exitedTerminal },
  { t: 'termExited', termId: 1, code: 0, signal: null },
  { t: 'termExited', termId: 2, code: 137, signal: 'SIGKILL' },
  { t: 'termClosed', termId: 1 },
  { t: 'detached', termId: 1, reason: 'lagging' },
  { t: 'activity', termId: 1, unseen: true, state: 'idle' },
  { t: 'activity', termId: 2, unseen: false, state: 'input' },
  { t: 'checkedChanged', worktree: WT, checked: false },
  { t: 'layoutChanged', worktree: WT, layout: { tabs: [], active: 0 } },
  { t: 'layoutChanged', worktree: WT, layout: fullTabLayout },
  { t: 'reposDiscovered', req: 4, repos: [REPO, WT] },
];

type DaemonRequest = Exclude<MessageOf<'clientToDaemon'>, { t: 'hello' | 'shutdown' }>;
type DaemonEvent = Exclude<MessageOf<'daemonToClient'>, { t: 'hello' }>;

const isDaemonRequest = (m: MessageOf<'clientToDaemon'>): m is DaemonRequest => m.t !== 'hello' && m.t !== 'shutdown';
const isDaemonEvent = (m: MessageOf<'daemonToClient'>): m is DaemonEvent => m.t !== 'hello';

export const browserToHubSamples: MessageOf<'browserToHub'>[] = [
  hello,
  ...clientToDaemonSamples.filter(isDaemonRequest).map((m): MessageOf<'browserToHub'> => ({ t: 'host', host: 1, m })),
  { t: 'addRepo', req: 1, host: 0, repo: REPO },
  { t: 'removeRepo', req: 2, host: 0, repo: REPO },
  { t: 'discoverRepos', req: 3, host: 65535 },
  { t: 'restartDaemon', req: 4, host: 1 },
  { t: 'reinstallDaemon', req: 5, host: 1 },
];

export const hubToBrowserSamples: MessageOf<'hubToBrowser'>[] = [
  hello,
  { t: 'token', token: TOKEN },
  ...daemonToClientSamples.filter(isDaemonEvent).map((m): MessageOf<'hubToBrowser'> => ({ t: 'host', host: 0, m })),
  { t: 'hosts', hosts },
  { t: 'hosts', hosts: [] },
  {
    t: 'presets',
    presets: [
      { name: 'shell', command: null },
      { name: 'claude', command: 'claude' },
    ],
  },
  { t: 'done', req: 1 },
  { t: 'error', req: 2, host: 1, code: 'unknown-host', message: 'no such host' },
  { t: 'error', req: null, host: null, code: 'version-mismatch', message: 'outdated' },
  { t: 'error', req: 3, host: 0, code: 'host-unavailable', message: 'host 0 is reconnecting' },
  { t: 'reposDiscovered', req: 3, host: 0, repos: [REPO] },
];

export const samples: { readonly [D in Direction]: readonly MessageOf<D>[] } = {
  clientToDaemon: clientToDaemonSamples,
  daemonToClient: daemonToClientSamples,
  browserToHub: browserToHubSamples,
  hubToBrowser: hubToBrowserSamples,
};

export const DIRECTIONS: readonly Direction[] = ['clientToDaemon', 'daemonToClient', 'browserToHub', 'hubToBrowser'];

export const MESSAGE_TYPES: Readonly<Record<Direction, readonly string[]>> = {
  clientToDaemon: [
    'hello',
    'shutdown',
    'watchRepo',
    'unwatchRepo',
    'discoverRepos',
    'createTerm',
    'attach',
    'detach',
    'resize',
    'closeTerm',
    'ack',
    'setVisible',
    'setChecked',
    'setLayout',
  ],
  daemonToClient: [
    'hello',
    'done',
    'error',
    'repoState',
    'worktreesChanged',
    'termCreated',
    'termExited',
    'termClosed',
    'detached',
    'activity',
    'checkedChanged',
    'layoutChanged',
    'reposDiscovered',
  ],
  browserToHub: ['hello', 'host', 'addRepo', 'removeRepo', 'discoverRepos', 'restartDaemon', 'reinstallDaemon'],
  hubToBrowser: ['hello', 'token', 'host', 'hosts', 'presets', 'done', 'error', 'reposDiscovered'],
};

/** Encodes a JSON value as control-message text, bypassing the protocol encoder. */
export const raw = (value: unknown): string => JSON.stringify(value);

export const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
