import { describe, expect, it } from 'vitest';
import { decodeMessage, encodeMessage, ProtocolError, type Direction } from './index.js';
import { DIRECTIONS, featWorktree, hello, hosts, liveTerminal, MESSAGE_TYPES, raw, REPO, samples, SHA1, utf8, WT } from './test-samples.js';

const decodes = (dir: Direction, value: unknown): boolean => {
  try {
    decodeMessage(dir, raw(value));
    return true;
  } catch (error) {
    expect(error).toBeInstanceOf(ProtocolError);
    return false;
  }
};

const expectRejected = (dir: Direction, data: string | Uint8Array): void => {
  expect(() => decodeMessage(dir, data)).toThrow(ProtocolError);
};

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1);
const paths = (n: number): string[] => range(n).map((i) => `/r/${String(i)}`);

describe('handshake', () => {
  it.each(DIRECTIONS)('hello round-trips in %s', (dir) => {
    expect(decodeMessage(dir, encodeMessage(dir, hello))).toEqual(hello);
  });

  it('decodes a hello from another protocol version', () => {
    expect(decodeMessage('daemonToClient', raw({ ...hello, protocol: 7 }))).toEqual({ ...hello, protocol: 7 });
  });

  it.each([
    ['instance with a space', { ...hello, instance: 'a b' }],
    ['empty instance', { ...hello, instance: '' }],
    ['65-char instance', { ...hello, instance: 'a'.repeat(65) }],
    ['instance with a dot', { ...hello, instance: 'a.b' }],
    ['empty version', { ...hello, version: '' }],
    ['65-char version', { ...hello, version: 'v'.repeat(65) }],
    ['protocol 0', { ...hello, protocol: 0 }],
    ['fractional protocol', { ...hello, protocol: 1.5 }],
    ['string protocol', { ...hello, protocol: '1' }],
    ['extra field', { ...hello, extra: true }],
    ['missing instance', { t: 'hello', protocol: 1, version: '0.1.0' }],
  ])('rejects a hello with %s', (_name, value) => {
    expect(decodes('clientToDaemon', value)).toBe(false);
  });

  it('accepts the longest instance and version', () => {
    expect(decodes('clientToDaemon', { ...hello, instance: 'A-_9'.repeat(16), version: 'v'.repeat(64) })).toBe(true);
  });

  it('accepts shutdown only towards a daemon', () => {
    expect(decodes('clientToDaemon', { t: 'shutdown' })).toBe(true);
    for (const dir of ['daemonToClient', 'browserToHub', 'hubToBrowser'] as const) {
      expect(decodes(dir, { t: 'shutdown' })).toBe(false);
    }
  });
});

describe('strict decoding', () => {
  it.each([
    ['invalid JSON', '{"t":'],
    ['trailing garbage', '{"t":"shutdown"} x'],
    ['an array', '[]'],
    ['a number', '1'],
    ['null', 'null'],
    ['a string', '"shutdown"'],
    ['an object without t', '{}'],
    ['a non-string t', '{"t":1}'],
    ['an unknown t', '{"t":"frobnicate"}'],
    ['a __proto__ key', '{"t":"shutdown","__proto__":{}}'],
  ])('rejects %s', (_name, text) => {
    expectRejected('clientToDaemon', text);
  });

  it('rejects an extra field', () => {
    expectRejected('clientToDaemon', raw({ t: 'attach', req: 1, termId: 1, x: 1 }));
  });

  it('rejects a missing field', () => {
    expectRejected('clientToDaemon', raw({ t: 'attach', req: 1 }));
  });

  it('does not coerce numbers', () => {
    expectRejected('clientToDaemon', raw({ t: 'resize', termId: 1, cols: '80', rows: 24 }));
  });

  it('does not coerce booleans', () => {
    expectRejected('clientToDaemon', raw({ t: 'setChecked', req: 1, worktree: WT, checked: 'true' }));
  });

  it('rejects a repoState decoded as a client-to-daemon message', () => {
    const repoState = samples.daemonToClient.find((m) => m.t === 'repoState');
    expectRejected('clientToDaemon', raw(repoState));
  });

  it.each(DIRECTIONS)('rejects every message of another direction whose type %s does not have', (dir) => {
    for (const other of DIRECTIONS) {
      for (const message of samples[other]) {
        if (!MESSAGE_TYPES[dir].includes(message.t)) {
          expect(decodes(dir, message), `${message.t} from ${other}`).toBe(false);
        }
      }
    }
  });

  it('rejects invalid UTF-8', () => {
    const bytes = utf8('{"t":"shutdown"}');
    const broken = new Uint8Array([...bytes.subarray(0, 8), 0xff, ...bytes.subarray(8)]);
    expectRejected('clientToDaemon', broken);
  });

  it('decodes valid UTF-8 bytes', () => {
    const message = { t: 'watchRepo', req: 1, repo: '/home/ü/репо' } as const;
    expect(decodeMessage('clientToDaemon', utf8(raw(message)))).toEqual(message);
  });

  it('encodes to JSON text of the message', () => {
    const message = { t: 'attach', req: 1, termId: 3 } as const;
    expect(JSON.parse(encodeMessage('clientToDaemon', message))).toEqual(message);
  });

  it('refuses to encode an out-of-bounds value', () => {
    expect(() => encodeMessage('clientToDaemon', { t: 'resize', termId: 1, cols: 0, rows: 24 })).toThrow(ProtocolError);
  });

  it('refuses to encode an extra field', () => {
    const message = { t: 'attach' as const, req: 1, termId: 1, x: 1 };
    expect(() => encodeMessage('clientToDaemon', message)).toThrow(ProtocolError);
  });

  it('refuses to encode a relative path', () => {
    expect(() => encodeMessage('clientToDaemon', { t: 'watchRepo', req: 1, repo: 'repo' })).toThrow(ProtocolError);
  });
});

describe('message catalogues', () => {
  it.each(DIRECTIONS)('samples cover exactly the %s catalogue', (dir) => {
    expect(new Set(samples[dir].map((m) => m.t))).toEqual(new Set(MESSAGE_TYPES[dir]));
  });

  it.each(DIRECTIONS)('every %s sample round-trips through text and bytes', (dir) => {
    for (const message of samples[dir]) {
      const text = encodeMessage(dir, message);
      expect(decodeMessage(dir, text)).toEqual(message);
      expect(decodeMessage(dir, utf8(text))).toEqual(message);
    }
  });

  it('rejects a detached reason other than lagging', () => {
    expectRejected('daemonToClient', raw({ t: 'detached', termId: 1, reason: 'closed' }));
  });

  it.each([
    ['hello', hello],
    ['shutdown', { t: 'shutdown' }],
    ['a daemon-to-client message', { t: 'done', req: 1 }],
  ])('rejects a browser host envelope carrying %s', (_name, m) => {
    expectRejected('browserToHub', raw({ t: 'host', host: 0, m }));
  });

  it.each([
    ['hello', hello],
    ['a client-to-daemon message', { t: 'attach', req: 1, termId: 1 }],
  ])('rejects a hub host envelope carrying %s', (_name, m) => {
    expectRejected('hubToBrowser', raw({ t: 'host', host: 0, m }));
  });

  it('rejects a browser discoverRepos carrying roots', () => {
    expectRejected('browserToHub', raw({ t: 'discoverRepos', req: 1, host: 0, roots: ['/a'], depth: 1 }));
  });

  it('rejects an unknown host status', () => {
    expectRejected('hubToBrowser', raw({ t: 'hosts', hosts: [{ ...hosts[0], status: 'up' }] }));
  });
});

describe('request correlation', () => {
  const requests: readonly (readonly [Direction, Record<string, unknown>])[] = [
    ['clientToDaemon', { t: 'watchRepo', req: 1, repo: REPO }],
    ['clientToDaemon', { t: 'unwatchRepo', req: 1, repo: REPO }],
    ['clientToDaemon', { t: 'discoverRepos', req: 1, roots: [REPO], depth: 1 }],
    ['clientToDaemon', { t: 'createTerm', req: 1, worktree: WT, preset: 'shell', command: null, cols: 80, rows: 24 }],
    ['clientToDaemon', { t: 'attach', req: 1, termId: 1 }],
    ['clientToDaemon', { t: 'detach', req: 1, termId: 1 }],
    ['clientToDaemon', { t: 'closeTerm', req: 1, termId: 1 }],
    ['clientToDaemon', { t: 'setChecked', req: 1, worktree: WT, checked: true }],
    ['clientToDaemon', { t: 'setLayout', req: 1, worktree: WT, layout: { tabs: [], active: 0 } }],
    ['browserToHub', { t: 'addRepo', req: 1, host: 0, repo: REPO }],
    ['browserToHub', { t: 'removeRepo', req: 1, host: 0, repo: REPO }],
    ['browserToHub', { t: 'discoverRepos', req: 1, host: 0 }],
    ['browserToHub', { t: 'restartDaemon', req: 1, host: 0 }],
    ['browserToHub', { t: 'reinstallDaemon', req: 1, host: 0 }],
  ];

  const fireAndForget: readonly (readonly [Direction, Record<string, unknown>])[] = [
    ['clientToDaemon', { t: 'resize', termId: 1, cols: 80, rows: 24 }],
    ['clientToDaemon', { t: 'ack', termId: 1, offset: 0 }],
    ['clientToDaemon', { t: 'setVisible', termIds: [1] }],
    ['clientToDaemon', { t: 'shutdown' }],
    ['clientToDaemon', hello],
    ['daemonToClient', hello],
  ];

  it.each(requests)('%s %o requires req', (dir, message) => {
    expect(decodes(dir, message)).toBe(true);
    const withoutReq = Object.fromEntries(Object.entries(message).filter(([key]) => key !== 'req'));
    expect(decodes(dir, withoutReq)).toBe(false);
  });

  it.each(requests)('%s %o bounds req to 1..2^32-1', (dir, message) => {
    expect(decodes(dir, { ...message, req: 4294967295 })).toBe(true);
    expect(decodes(dir, { ...message, req: 0 })).toBe(false);
    expect(decodes(dir, { ...message, req: 4294967296 })).toBe(false);
    expect(decodes(dir, { ...message, req: 1.5 })).toBe(false);
  });

  it.each(fireAndForget)('%s %o rejects req', (dir, message) => {
    expect(decodes(dir, message)).toBe(true);
    expect(decodes(dir, { ...message, req: 1 })).toBe(false);
  });

  it('rejects a closeTerm without req', () => {
    expectRejected('clientToDaemon', raw({ t: 'closeTerm', termId: 1 }));
  });

  it('rejects an ack carrying req', () => {
    expectRejected('clientToDaemon', raw({ t: 'ack', req: 1, termId: 1, offset: 0 }));
  });

  it('accepts uncorrelated errors from a daemon and from the hub', () => {
    expect(decodes('daemonToClient', { t: 'error', req: null, code: 'internal', message: 'x' })).toBe(true);
    expect(decodes('hubToBrowser', { t: 'error', req: null, host: null, code: 'internal', message: 'x' })).toBe(true);
  });

  it('accepts a broadcast termCreated with a null req', () => {
    const message = { t: 'termCreated', req: null, term: liveTerminal } as const;
    expect(decodeMessage('daemonToClient', raw(message))).toEqual(message);
    expect(decodes('hubToBrowser', { t: 'host', host: 0, m: message })).toBe(true);
  });

  it('requires req on a termCreated, even if null', () => {
    expect(decodes('daemonToClient', { t: 'termCreated', term: liveTerminal })).toBe(false);
  });

  it('requires req on an error, even if null', () => {
    expect(decodes('daemonToClient', { t: 'error', code: 'internal', message: 'x' })).toBe(false);
  });
});

describe('value limits', () => {
  const watch = (repo: unknown): unknown => ({ t: 'watchRepo', req: 1, repo });
  const attach = (termId: unknown): unknown => ({ t: 'attach', req: 1, termId });
  const ack = (offset: unknown): unknown => ({ t: 'ack', termId: 1, offset });
  const resize = (cols: unknown, rows: unknown): unknown => ({ t: 'resize', termId: 1, cols, rows });
  const addRepo = (host: unknown): unknown => ({ t: 'addRepo', req: 1, host, repo: REPO });
  const discover = (roots: unknown, depth: unknown): unknown => ({ t: 'discoverRepos', req: 1, roots, depth });
  const worktrees = (wts: unknown): unknown => ({ t: 'worktreesChanged', repo: REPO, worktrees: wts });
  const withHead = (head: unknown): unknown => worktrees([{ ...featWorktree, head }]);
  const withBranch = (branch: unknown): unknown => worktrees([{ ...featWorktree, branch }]);
  const create = (preset: unknown, command: unknown): Record<string, unknown> => ({
    t: 'createTerm',
    req: 1,
    worktree: WT,
    preset,
    command,
    cols: 80,
    rows: 24,
  });
  const exited = (signal: unknown): unknown => ({ t: 'termExited', termId: 1, code: 0, signal });
  const daemonError = (code: unknown, message: unknown): unknown => ({ t: 'error', req: 1, code, message });
  const hostName = (name: unknown): unknown => ({ t: 'hosts', hosts: [{ ...hosts[0], name }] });
  const repoState = (fields: Record<string, unknown>): unknown => ({
    t: 'repoState',
    repo: REPO,
    worktrees: [],
    terminals: [],
    checked: [],
    layouts: [],
    ...fields,
  });
  const terminals = (n: number): unknown[] => range(n).map((termId) => ({ ...liveTerminal, termId }));
  const hostEntries = (n: number): unknown[] => range(n).map((idx) => ({ ...hosts[0], idx }));
  const presets = (n: number): unknown[] => range(n).map((i) => ({ name: `p${String(i)}`, command: null }));
  const layouts = (n: number): unknown[] => paths(n).map((worktree) => ({ worktree, layout: { tabs: [], active: 0 } }));

  const ERROR_CODES = [
    'bad-message',
    'unknown-host',
    'unknown-term',
    'unknown-worktree',
    'not-watched',
    'busy',
    'spawn-failed',
    'version-mismatch',
    'not-a-repo',
    'internal',
  ];

  const cases: readonly (readonly [string, Direction, unknown, boolean])[] = [
    ['root path', 'clientToDaemon', watch('/'), true],
    ['relative path', 'clientToDaemon', watch('repo/a'), false],
    ['empty path', 'clientToDaemon', watch(''), false],
    ['4096-char path', 'clientToDaemon', watch('/' + 'a'.repeat(4095)), true],
    ['4097-char path', 'clientToDaemon', watch('/' + 'a'.repeat(4096)), false],
    ['path with NUL', 'clientToDaemon', watch('/a\u0000b'), false],
    ['relative createTerm worktree', 'clientToDaemon', { ...create('shell', null), worktree: 'w' }, false],
    ['termId 0', 'clientToDaemon', attach(0), false],
    ['termId 1', 'clientToDaemon', attach(1), true],
    ['termId 2^32-1', 'clientToDaemon', attach(4294967295), true],
    ['termId 2^32', 'clientToDaemon', attach(4294967296), false],
    ['negative termId', 'clientToDaemon', attach(-1), false],
    ['fractional termId', 'clientToDaemon', attach(1.5), false],
    ['offset 0', 'clientToDaemon', ack(0), true],
    ['offset 2^53-1', 'clientToDaemon', ack(Number.MAX_SAFE_INTEGER), true],
    ['offset 2^53', 'clientToDaemon', ack(2 ** 53), false],
    ['negative offset', 'clientToDaemon', ack(-1), false],
    ['fractional offset', 'clientToDaemon', ack(0.5), false],
    ['cols and rows 1', 'clientToDaemon', resize(1, 1), true],
    ['cols and rows 1000', 'clientToDaemon', resize(1000, 1000), true],
    ['cols 0', 'clientToDaemon', resize(0, 24), false],
    ['cols 1001', 'clientToDaemon', resize(1001, 24), false],
    ['rows 0', 'clientToDaemon', resize(80, 0), false],
    ['rows 1001', 'clientToDaemon', resize(80, 1001), false],
    ['host 0', 'browserToHub', addRepo(0), true],
    ['host 65535', 'browserToHub', addRepo(65535), true],
    ['host 65536', 'browserToHub', addRepo(65536), false],
    ['host -1', 'browserToHub', addRepo(-1), false],
    ['envelope host 65536', 'browserToHub', { t: 'host', host: 65536, m: { t: 'detach', req: 1, termId: 1 } }, false],
    ['host entry idx 65536', 'hubToBrowser', { t: 'hosts', hosts: [{ ...hosts[0], idx: 65536 }] }, false],
    ['depth 1', 'clientToDaemon', discover(['/a'], 1), true],
    ['depth 6', 'clientToDaemon', discover(['/a'], 6), true],
    ['depth 0', 'clientToDaemon', discover(['/a'], 0), false],
    ['depth 7', 'clientToDaemon', discover(['/a'], 7), false],
    ['null head', 'daemonToClient', withHead(null), true],
    ['40-hex head', 'daemonToClient', withHead(SHA1), true],
    ['64-hex head', 'daemonToClient', withHead('f'.repeat(64)), true],
    ['uppercase head', 'daemonToClient', withHead('A'.repeat(40)), false],
    ['39-hex head', 'daemonToClient', withHead('a'.repeat(39)), false],
    ['41-hex head', 'daemonToClient', withHead('a'.repeat(41)), false],
    ['non-hex head', 'daemonToClient', withHead('g'.repeat(40)), false],
    ['empty host name', 'hubToBrowser', hostName(''), false],
    ['64-char host name', 'hubToBrowser', hostName('h'.repeat(64)), true],
    ['65-char host name', 'hubToBrowser', hostName('h'.repeat(65)), false],
    ['empty preset name', 'clientToDaemon', create('', null), false],
    ['64-char preset name', 'clientToDaemon', create('p'.repeat(64), null), true],
    ['65-char preset name', 'clientToDaemon', create('p'.repeat(65), null), false],
    ['4096-char command', 'clientToDaemon', create('p', 'c'.repeat(4096)), true],
    ['4097-char command', 'clientToDaemon', create('p', 'c'.repeat(4097)), false],
    ['4096-char branch', 'daemonToClient', withBranch('b'.repeat(4096)), true],
    ['4097-char branch', 'daemonToClient', withBranch('b'.repeat(4097)), false],
    ['32-char signal', 'daemonToClient', exited('S'.repeat(32)), true],
    ['33-char signal', 'daemonToClient', exited('S'.repeat(33)), false],
    ['1024-char error message', 'daemonToClient', daemonError('internal', 'm'.repeat(1024)), true],
    ['1025-char error message', 'daemonToClient', daemonError('internal', 'm'.repeat(1025)), false],
    ['unknown error code', 'daemonToClient', daemonError('oops', 'x'), false],
    ...ERROR_CODES.map((code) => [`error code ${code}`, 'daemonToClient', daemonError(code, 'x'), true] as const),
    ['1024 worktrees', 'daemonToClient', worktrees(paths(1024).map((path) => ({ ...featWorktree, path }))), true],
    ['1025 worktrees', 'daemonToClient', worktrees(paths(1025).map((path) => ({ ...featWorktree, path }))), false],
    ['1024 terminals', 'daemonToClient', repoState({ terminals: terminals(1024) }), true],
    ['1025 terminals', 'daemonToClient', repoState({ terminals: terminals(1025) }), false],
    ['1024 checked paths', 'daemonToClient', repoState({ checked: paths(1024) }), true],
    ['1025 checked paths', 'daemonToClient', repoState({ checked: paths(1025) }), false],
    ['1024 layout entries', 'daemonToClient', repoState({ layouts: layouts(1024) }), true],
    ['1025 layout entries', 'daemonToClient', repoState({ layouts: layouts(1025) }), false],
    ['0 discovery roots', 'clientToDaemon', discover([], 1), false],
    ['32 discovery roots', 'clientToDaemon', discover(paths(32), 1), true],
    ['33 discovery roots', 'clientToDaemon', discover(paths(33), 1), false],
    ['4096 discovered repos', 'daemonToClient', { t: 'reposDiscovered', req: 1, repos: paths(4096) }, true],
    ['4097 discovered repos', 'daemonToClient', { t: 'reposDiscovered', req: 1, repos: paths(4097) }, false],
    ['4097 discovered repos via hub', 'hubToBrowser', { t: 'reposDiscovered', req: 1, host: 0, repos: paths(4097) }, false],
    ['4096 visible terminals', 'clientToDaemon', { t: 'setVisible', termIds: range(4096) }, true],
    ['4097 visible terminals', 'clientToDaemon', { t: 'setVisible', termIds: range(4097) }, false],
    ['64 hosts', 'hubToBrowser', { t: 'hosts', hosts: hostEntries(64) }, true],
    ['65 hosts', 'hubToBrowser', { t: 'hosts', hosts: hostEntries(65) }, false],
    ['256 repos per host', 'hubToBrowser', { t: 'hosts', hosts: [{ ...hosts[0], repos: paths(256) }] }, true],
    ['257 repos per host', 'hubToBrowser', { t: 'hosts', hosts: [{ ...hosts[0], repos: paths(257) }] }, false],
    ['64 presets', 'hubToBrowser', { t: 'presets', presets: presets(64) }, true],
    ['65 presets', 'hubToBrowser', { t: 'presets', presets: presets(65) }, false],
  ];

  it.each(cases)('%s in %s', (_name, dir, value, ok) => {
    expect(decodes(dir, value)).toBe(ok);
  });

  it('rejects a relative watchRepo path', () => {
    expectRejected('clientToDaemon', raw({ t: 'watchRepo', req: 1, repo: 'repo/a' }));
  });

  it('rejects 1025 worktrees', () => {
    const wts = paths(1025).map((path) => ({ ...featWorktree, path }));
    expectRejected('daemonToClient', raw({ t: 'worktreesChanged', repo: REPO, worktrees: wts }));
  });

  it('accepts the not-a-repo error code', () => {
    expect(decodes('daemonToClient', { t: 'error', req: 1, code: 'not-a-repo', message: 'x' })).toBe(true);
  });

  it('rejects an unknown error code', () => {
    expectRejected('daemonToClient', raw({ t: 'error', req: 1, code: 'oops', message: 'x' }));
  });
});
