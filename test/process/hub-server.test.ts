import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeWsData, MAX_FRAME, BROWSER_PROTOCOL_VERSION } from '../../src/protocol/index.js';
import { sleep, type WtdProcess } from '../support/daemon-host.js';
import { UpgradeRefused, type HubClient, type HubMessageOf } from '../support/hub-client.js';
import { HubHost, type RawResponse } from '../support/hub-host.js';
import { REPO_ROOT } from '../support/exec.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

const CSP =
  "default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; object-src 'none'";

const HEX64 = /^[0-9a-f]{64}$/;
const ANY_TEXT: unknown = expect.any(String);
const ANY_WORD: unknown = expect.stringMatching(/^\S+$/);
const ANY_HEX64: unknown = expect.stringMatching(HEX64);
const WEB = join(REPO_ROOT, 'dist', 'web');

let host: HubHost;

beforeEach(async () => {
  host = await HubHost.createHub();
});

afterEach(async () => {
  await host.cleanup();
});

const packageVersion = (): string => {
  const pkg: unknown = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  if (typeof pkg !== 'object' || pkg === null || !('version' in pkg) || typeof pkg.version !== 'string') throw new Error('no version');
  return pkg.version;
};

/** Asserts one line on stderr, without a stack trace. */
const expectOneLine = (stderr: string): void => {
  expect(stderr.trimEnd()).not.toBe('');
  expect(stderr.trimEnd()).not.toContain('\n');
  expect(stderr).not.toMatch(/\n\s+at /);
};

const header = (response: RawResponse, name: string): string[] => response.headers.get(name) ?? [];

/** The preset lists of every `presets` message received so far. */
const presetsOf = (client: HubClient): HubMessageOf<'presets'>['presets'][] =>
  client.messages.flatMap((m) => (m.t === 'presets' ? [m.presets] : []));

const expectSecurityHeaders = (response: RawResponse): void => {
  expect(header(response, 'content-security-policy')).toEqual([CSP]);
  expect(header(response, 'x-content-type-options')).toEqual(['nosniff']);
  expect(header(response, 'referrer-policy')).toEqual(['no-referrer']);
};

/** Resolves the upgrade's outcome: the open client, or the refusal status. */
const outcome = async (opening: Promise<HubClient>): Promise<HubClient | number> => {
  try {
    return await opening;
  } catch (error) {
    if (error instanceof UpgradeRefused) return error.status;
    throw error;
  }
};

const refusal = async (opening: Promise<HubClient>): Promise<number> => {
  const result = await outcome(opening);
  if (typeof result !== 'number') {
    result.close();
    throw new Error('upgrade unexpectedly accepted');
  }
  return result;
};

/** TCP sockets in LISTEN state owned by `pid`, as `address:port`. */
const listeningSockets = (pid: number): string[] => {
  const inodes = new Set<string>();
  for (const fd of readdirSync(`/proc/${String(pid)}/fd`)) {
    try {
      const match = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${String(pid)}/fd/${fd}`));
      if (match?.[1] !== undefined) inodes.add(match[1]);
    } catch {
      // The descriptor closed while we looked.
    }
  }
  const found: string[] = [];
  for (const table of ['tcp', 'tcp6']) {
    for (const line of readFileSync(`/proc/net/${table}`, 'utf8').split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      const [, local, , state] = fields;
      if (local === undefined || state !== '0A' || !inodes.has(fields[9] ?? '')) continue;
      const [address = '', port = ''] = local.split(':');
      const ip =
        table === 'tcp' ? Array.from({ length: 4 }, (_, i) => parseInt(address.slice(6 - 2 * i, 8 - 2 * i), 16)).join('.') : `[${address}]`;
      found.push(`${ip}:${String(parseInt(port, 16))}`);
    }
  }
  return found;
};

/** Leaves the state directory owner-only, as the hub would create it. */
const prepareStateDir = (): void => {
  mkdirSync(host.stateDir, { recursive: true, mode: 0o700 });
  chmodSync(host.stateDir, 0o700);
};

const waitExit = async (process_: WtdProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> => {
  const exit = await Promise.race([process_.exited, sleep(10_000).then(() => null)]);
  if (exit === null) throw new Error('process did not exit');
  return exit;
};

describe('loopback listener and hub record', () => {
  it('listens on exactly one TCP socket, 127.0.0.1 at the configured port', async () => {
    const hub = await host.startHub();
    expect(listeningSockets(hub.pid)).toEqual([`127.0.0.1:${String(host.port)}`]);
  });

  it('writes its record while running and removes it on SIGTERM', async () => {
    const hub = await host.startHub();
    const record = host.record();
    expect(record).toEqual({ pid: hub.pid, port: host.port, instance: ANY_WORD });
    expect(statSync(host.recordPath).mode & 0o777).toBe(0o600);
    hub.kill('SIGTERM');
    expect(await waitExit(hub)).toEqual({ code: 0, signal: null });
    expect(existsSync(host.recordPath)).toBe(false);
  });

  it('leaves a record naming another instance on exit', async () => {
    const hub = await host.startHub();
    const other = { pid: hub.pid, port: host.port, instance: 'another_hub' };
    writeFileSync(host.recordPath, JSON.stringify(other));
    hub.kill('SIGTERM');
    await waitExit(hub);
    expect(host.record()).toEqual(other);
  });
});

describe('persistent token', () => {
  it('is 64 lowercase hex digits in an owner-only file', async () => {
    await host.startHub();
    expect(host.token()).toMatch(HEX64);
    expect(statSync(host.tokenPath).mode & 0o777).toBe(0o600);
  });

  it('persists across restarts', async () => {
    const first = await host.startHub();
    const token = host.token();
    first.kill('SIGTERM');
    await waitExit(first);
    await host.startHub();
    expect(host.token()).toBe(token);
    expect((await host.api('GET', '/api/identity', { token })).status).toBe(200);
  });

  it('refuses to start when the token path is a symbolic link, naming it', async () => {
    prepareStateDir();
    const target = join(host.dir, 'elsewhere');
    writeFileSync(target, 'a'.repeat(64), { mode: 0o600 });
    symlinkSync(target, host.tokenPath);
    const hub = host.wtd(['hub']);
    expect(await waitExit(hub)).toEqual({ code: 1, signal: null });
    expectOneLine(hub.stderr);
    expect(hub.stderr).toContain(host.tokenPath);
    expect(readFileSync(target, 'utf8')).toBe('a'.repeat(64));
  });

  it('refuses to start when the token path is a directory, naming it', async () => {
    prepareStateDir();
    mkdirSync(host.tokenPath);
    const hub = host.wtd(['hub']);
    expect(await waitExit(hub)).toEqual({ code: 1, signal: null });
    expectOneLine(hub.stderr);
    expect(hub.stderr).toContain(host.tokenPath);
  });

  it('keeps a valid token with a loose mode and tightens it to 0600', async () => {
    prepareStateDir();
    const token = '0123456789abcdef'.repeat(4);
    writeFileSync(host.tokenPath, token, { mode: 0o644 });
    chmodSync(host.tokenPath, 0o644);
    await host.startHub();
    expect(host.token()).toBe(token);
    expect(statSync(host.tokenPath).mode & 0o777).toBe(0o600);
  });

  it.each([
    ['text', 'not a token'],
    ['63 digits', 'a'.repeat(63)],
    ['uppercase digits', 'A'.repeat(64)],
    ['empty', ''],
  ])('replaces a malformed token (%s) with a new valid one', async (_name, content) => {
    prepareStateDir();
    writeFileSync(host.tokenPath, content, { mode: 0o600 });
    await host.startHub();
    expect(host.token()).toMatch(HEX64);
    expect(statSync(host.tokenPath).mode & 0o777).toBe(0o600);
    expect((await host.api('GET', '/api/identity')).status).toBe(200);
  });
});

describe('request checks and headers', () => {
  beforeEach(async () => {
    await host.startHub();
  });

  it.each([
    ['localhost', () => `localhost:${String(host.port)}`],
    ['a foreign name', () => 'evil.example'],
    ['127.0.0.1 without the port', () => '127.0.0.1'],
    ['another port', () => `127.0.0.1:${String(host.port + 1)}`],
  ])('refuses a request whose Host is %s with 403', async (_name, value) => {
    expect((await host.http('GET', '/', { host: value() })).status).toBe(403);
    expect((await host.api('GET', '/api/identity')).status).toBe(200);
    const identity = await host.http('GET', '/api/identity', { host: value(), headers: [['Authorization', `Bearer ${host.token()}`]] });
    expect(identity.status).toBe(403);
  });

  it('refuses a request without Host with 403', async () => {
    expect((await host.http('GET', '/', { host: null })).status).toBe(403);
  });

  it('refuses a request with two Host headers with 403', async () => {
    const own = `127.0.0.1:${String(host.port)}`;
    expect((await host.http('GET', '/', { headers: [['Host', own]] })).status).toBe(403);
    expect((await host.http('GET', '/', { headers: [['Host', 'evil.example']] })).status).toBe(403);
  });

  it('refuses an upgrade with a foreign Host with 403', async () => {
    expect((await host.upgrade(['wtd', `wtd.token.${host.token()}`], { host: 'evil.example' })).status).toBe(403);
  });

  it('sends the security headers with index.html', async () => {
    const response = await host.http('GET', '/');
    expect(response.status).toBe(200);
    expectSecurityHeaders(response);
  });

  it('sends the security headers with every other response', async () => {
    const asset = readdirSync(join(WEB, 'assets'))[0];
    if (asset === undefined) throw new Error('no web asset');
    for (const response of [
      await host.http('GET', `/assets/${asset}`),
      await host.http('GET', '/nonexistent'),
      await host.api('GET', '/api/identity'),
      await host.api('GET', '/api/identity', { token: null }),
      await host.http('GET', '/', { host: 'evil.example' }),
    ]) {
      expectSecurityHeaders(response);
    }
  });
});

describe('static bundle', () => {
  beforeEach(async () => {
    await host.startHub();
  });

  it('serves index.html at / uncached', async () => {
    const response = await host.http('GET', '/');
    expect(response.status).toBe(200);
    expect(header(response, 'cache-control')).toEqual(['no-cache']);
    expect(header(response, 'content-type')[0]).toMatch(/^text\/html/);
    expect(response.body).toBe(readFileSync(join(WEB, 'index.html'), 'utf8'));
  });

  it('serves every other bundle file as immutable', async () => {
    const assets = readdirSync(join(WEB, 'assets'));
    expect(assets.length).toBeGreaterThan(0);
    for (const asset of assets) {
      const response = await host.http('GET', `/assets/${asset}`);
      expect(response.status).toBe(200);
      expect(header(response, 'cache-control')).toEqual(['public, max-age=31536000, immutable']);
      if (asset.endsWith('.js')) {
        expect(header(response, 'content-type')[0]).toMatch(/javascript/);
        expect(response.body).toBe(readFileSync(join(WEB, 'assets', asset), 'utf8'));
      }
    }
  });

  it.each(['/nonexistent', '/index.htm', '/assets/', '/assets/nonexistent.js', '/api', '/ws/x'])('answers %s with 404', async (path) => {
    expect((await host.http('GET', path)).status).toBe(404);
  });

  it.each(['/../package.json', '/%2e%2e/package.json', '/assets/../index.html', '/%2fetc%2fpasswd', '/..%2fpackage.json'])(
    'refuses traversal %s with 404',
    async (path) => {
      expect((await host.http('GET', path)).status).toBe(404);
    },
  );
});

describe('one-time codes', () => {
  beforeEach(async () => {
    await host.startHub();
  });

  it('issues a code response with Cache-Control no-store', async () => {
    const response = await host.api('POST', '/api/code');
    expect(response.status).toBe(200);
    expect(header(response, 'cache-control')).toEqual(['no-store']);
    expect(JSON.parse(response.body)).toEqual({ code: ANY_HEX64 });
  });

  it('issues a different code each time', async () => {
    expect(await host.code()).not.toBe(await host.code());
  });

  it('accepts the hub’s own Origin', async () => {
    expect((await host.api('POST', '/api/code', { origin: host.origin })).status).toBe(200);
  });

  it.each([
    ['a wrong token', () => '0'.repeat(64)],
    ['no token', () => null],
    ['a malformed token', () => 'x'],
  ])('refuses %s with 401', async (_name, token) => {
    expect((await host.api('POST', '/api/code', { token: token() })).status).toBe(401);
  });

  it('refuses a cross-origin request with 403', async () => {
    expect((await host.api('POST', '/api/code', { origin: 'http://evil.example' })).status).toBe(403);
  });

  it('accepts a body of exactly 1 KiB', async () => {
    expect((await host.api('POST', '/api/code', { body: 'x'.repeat(1024) })).status).toBe(200);
  });

  it('refuses a body over 1 KiB', async () => {
    const response = await host.api('POST', '/api/code', { body: 'x'.repeat(1025) });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });
});

describe('identity and shutdown', () => {
  let hub: WtdProcess;

  beforeEach(async () => {
    hub = await host.startHub();
  });

  it('reports the package version and the record’s instance', async () => {
    expect(await host.identity()).toEqual({ version: packageVersion(), instance: host.record()?.instance });
  });

  it('refuses identity without the token with 401 and from another origin with 403', async () => {
    expect((await host.api('GET', '/api/identity', { token: null })).status).toBe(401);
    expect((await host.api('GET', '/api/identity', { token: '1'.repeat(64) })).status).toBe(401);
    expect((await host.api('GET', '/api/identity', { origin: 'http://evil.example' })).status).toBe(403);
  });

  it('refuses shutdown without the token with 401 and keeps running', async () => {
    expect((await host.api('POST', '/api/shutdown', { token: null })).status).toBe(401);
    expect((await host.api('POST', '/api/shutdown', { token: '1'.repeat(64) })).status).toBe(401);
    await sleep(300);
    expect(await host.serving()).toBe(true);
  });

  it('refuses shutdown from another origin with 403 and keeps running', async () => {
    expect((await host.api('POST', '/api/shutdown', { origin: 'http://evil.example' })).status).toBe(403);
    await sleep(300);
    expect(await host.serving()).toBe(true);
  });

  it('answers an authenticated shutdown and then exits 0, removing its record', async () => {
    const response = await host.api('POST', '/api/shutdown');
    expect(response.status).toBeGreaterThanOrEqual(200);
    expect(response.status).toBeLessThan(300);
    expect(await waitExit(hub)).toEqual({ code: 0, signal: null });
    expect(existsSync(host.recordPath)).toBe(false);
  });
});

describe('WebSocket authentication', () => {
  let hub: WtdProcess;
  let token: string;

  beforeEach(async () => {
    hub = await host.startHub();
    token = host.token();
  });

  it('accepts the token and selects the subprotocol wtd', async () => {
    const client = await host.open(['wtd', `wtd.token.${token}`]);
    expect(client.protocol).toBe('wtd');
    client.close();
    const raw = await host.upgrade(['wtd', `wtd.token.${token}`]);
    expect(raw.status).toBe(101);
    expect(header(raw, 'sec-websocket-protocol')).toEqual(['wtd']);
  });

  it('accepts the credential before wtd', async () => {
    expect((await host.upgrade([`wtd.token.${token}`, 'wtd'])).status).toBe(101);
  });

  it.each([
    ['no Origin', null],
    ['a foreign Origin', 'http://evil.example'],
    ['localhost as Origin', 'http://localhost'],
    ['another port as Origin', 'http://127.0.0.1:1'],
  ])('refuses an upgrade with %s with 403', async (_name, origin) => {
    expect(await refusal(host.open(['wtd', `wtd.token.${token}`], origin))).toBe(403);
  });

  it('refuses an upgrade with two Origin headers with 403', async () => {
    const response = await host.http('GET', '/ws', {
      headers: [
        ['Upgrade', 'websocket'],
        ['Connection', 'Upgrade'],
        ['Sec-WebSocket-Version', '13'],
        ['Sec-WebSocket-Key', 'dGhlIHNhbXBsZSBub25jZQ=='],
        ['Sec-WebSocket-Protocol', `wtd, wtd.token.${token}`],
        ['Origin', host.origin],
        ['Origin', host.origin],
      ],
      headersOnly: true,
    });
    expect(response.status).toBe(403);
  });

  it.each([
    ['a wrong token', () => ['wtd', `wtd.token.${'0'.repeat(64)}`]],
    ['a credential with another prefix', () => ['wtd', `xwtd.token.${token}`]],
    ['a credential with a suffix', () => ['wtd', `wtd.token.${token}x`]],
    ['an uppercase token', () => ['wtd', `wtd.token.${token.toUpperCase()}`]],
    ['an uppercase prefix', () => ['wtd', `WTD.token.${token}`]],
    ['a short token', () => ['wtd', `wtd.token.${token.slice(1)}`]],
    ['two credentials', () => ['wtd', `wtd.token.${token}`, `wtd.code.${'a'.repeat(64)}`]],
    ['the token twice', () => ['wtd', `wtd.token.${token}`, `wtd.token.${token}`]],
    ['no credential', () => ['wtd']],
    ['a credential without wtd', () => [`wtd.token.${token}`]],
  ])('refuses %s and starts no session', async (_name, protocols) => {
    // Raw upgrade: the ws client itself refuses to offer a duplicated subprotocol.
    expect((await host.upgrade(protocols())).status).toBe(401);
    await sleep(500);
    expect(host.daemonPids()).toEqual([]);
  });

  it('refuses an upgrade without Sec-WebSocket-Protocol with 401', async () => {
    expect((await host.upgrade(null)).status).toBe(401);
  });

  it('accepts upgrades only at /ws', async () => {
    for (const path of ['/', '/ws/', '/wsx', '/api/code']) {
      const response = await host.http('GET', path, {
        headers: [
          ['Upgrade', 'websocket'],
          ['Connection', 'Upgrade'],
          ['Sec-WebSocket-Version', '13'],
          ['Sec-WebSocket-Key', 'dGhlIHNhbXBsZSBub25jZQ=='],
          ['Sec-WebSocket-Protocol', `wtd, wtd.token.${token}`],
          ['Origin', host.origin],
        ],
        headersOnly: true,
      });
      expect(response.status, path).not.toBe(101);
    }
  });

  it('accepts a code once', async () => {
    const code = await host.code();
    const client = await host.open(['wtd', `wtd.code.${code}`]);
    expect(client.protocol).toBe('wtd');
    expect(await refusal(host.open(['wtd', `wtd.code.${code}`]))).toBe(401);
  });

  it('keeps a code presented by an upgrade the WebSocket handshake rejects', async () => {
    const code = await host.code();
    const response = await host.http('GET', '/ws', {
      headers: [
        ['Upgrade', 'websocket'],
        ['Connection', 'Upgrade'],
        ['Sec-WebSocket-Version', '12'],
        ['Sec-WebSocket-Key', 'dGhlIHNhbXBsZSBub25jZQ=='],
        ['Sec-WebSocket-Protocol', `wtd, wtd.code.${code}`],
        ['Origin', host.origin],
      ],
      headersOnly: true,
    });
    expect(response.status).toBe(400);
    const client = await host.open(['wtd', `wtd.code.${code}`]);
    expect(client.protocol).toBe('wtd');
  });

  it('accepts exactly one of two concurrent upgrades presenting the same code', async () => {
    const code = await host.code();
    const results = await Promise.all([outcome(host.open(['wtd', `wtd.code.${code}`])), outcome(host.open(['wtd', `wtd.code.${code}`]))]);
    expect(results.filter((r) => typeof r !== 'number')).toHaveLength(1);
    expect(results.filter((r) => typeof r === 'number')).toEqual([401]);
  });

  it('refuses an unknown code with 401', async () => {
    expect(await refusal(host.open(['wtd', `wtd.code.${'b'.repeat(64)}`]))).toBe(401);
  });

  it('refuses a code issued more than 30 s earlier with 401', async () => {
    const code = await host.code();
    await sleep(31_000);
    expect(await refusal(host.open(['wtd', `wtd.code.${code}`]))).toBe(401);
  }, 90_000);

  it('keeps at most 16 codes outstanding, dropping the oldest', async () => {
    const codes: string[] = [];
    for (let i = 0; i < 17; i++) codes.push(await host.code());
    expect(await refusal(host.open(['wtd', `wtd.code.${codes[0] ?? ''}`]))).toBe(401);
    const newest = await host.open(['wtd', `wtd.code.${codes[16] ?? ''}`]);
    expect(newest.protocol).toBe('wtd');
    const second = await host.open(['wtd', `wtd.code.${codes[1] ?? ''}`]);
    expect(second.protocol).toBe('wtd');
  });

  it('never records the token or codes it was offered', async () => {
    const used = await host.code();
    const client = await host.open(['wtd', `wtd.code.${used}`]);
    await client.handshake();
    const unused = await host.code();
    await outcome(host.open(['wtd', `wtd.token.${'0'.repeat(64)}`]));
    await outcome(host.open(['wtd', `wtd.code.${used}`]));
    await outcome(host.open(['wtd', `wtd.token.${token}`], 'http://evil.example'));
    await outcome(host.open(['wtd', `wtd.token.${token}`, `wtd.code.${unused}`]));
    hub.kill('SIGTERM');
    await waitExit(hub);
    const logs = [hub.stdout, hub.stderr, existsSync(host.hubLogPath) ? readFileSync(host.hubLogPath, 'utf8') : ''].join('\n');
    for (const secret of [token, used, unused]) expect(logs).not.toContain(secret);
  });

  it('closes a session sending a message of MAX_FRAME + 1 bytes', async () => {
    const client = await host.session();
    client.sendBinary(new Uint8Array(MAX_FRAME + 1));
    await client.waitClosed(10_000);
    expect(client.closeCode).toBe(1009);
  });

  it('accepts a message of MAX_FRAME bytes, then rejects it as malformed', async () => {
    const client = await host.session();
    client.sendBinary(new Uint8Array(MAX_FRAME));
    expect(await client.waitFor('error', () => true, { timeout: 10_000 })).toMatchObject({ code: 'bad-message' });
    expect(client.closeCode).not.toBe(1009);
  });
});

describe('session handshake', () => {
  let token: string;

  beforeEach(async () => {
    await host.startHub();
    token = host.token();
  });

  it('sends hello with the protocol, package version and instance', async () => {
    const client = await host.open(['wtd', `wtd.token.${token}`]);
    expect(await client.waitFor('hello')).toEqual({
      t: 'hello',
      protocol: BROWSER_PROTOCOL_VERSION,
      version: packageVersion(),
      instance: host.record()?.instance,
    });
  });

  it('sends the token right after hello to a code session', async () => {
    const client = await host.open(['wtd', `wtd.code.${await host.code()}`]);
    await client.waitFor('token');
    expect(client.messages.slice(0, 2).map((m) => m.t)).toEqual(['hello', 'token']);
    expect(client.messages[1]).toEqual({ t: 'token', token });
  });

  it('sends no token to a token session', async () => {
    const client = await host.open(['wtd', `wtd.token.${token}`]);
    await client.waitFor('hello');
    await client.expectNone('token', () => true, 300);
    const from = client.mark();
    client.sendHello();
    await client.waitFor('hosts', () => true, { from });
    expect(client.messages.some((m) => m.t === 'token')).toBe(false);
  });

  it('sends hosts after the browser’s hello', async () => {
    const client = await host.open(['wtd', `wtd.token.${token}`]);
    await client.waitFor('hello');
    await client.expectNone('hosts', () => true, 300);
    const { hosts } = await client.handshake();
    expect(hosts.hosts.map((h) => h.idx)).toEqual([0]);
  });

  it('sends presets and then hosts after the browser’s hello', async () => {
    const client = await host.open(['wtd', `wtd.token.${token}`]);
    await client.waitFor('hello');
    await client.expectNone('presets', () => true, 300);
    const from = client.mark();
    client.sendHello();
    await client.waitFor('hosts', () => true, { from });
    expect(client.messages.slice(from, from + 2).map((m) => m.t)).toEqual(['presets', 'hosts']);
  });

  it('sends the default presets and no repos without a configuration file', async () => {
    rmSync(host.configPath);
    const client = await host.session();
    expect(presetsOf(client)).toEqual([
      [
        { name: 'shell', command: null },
        { name: 'claude', command: 'claude' },
        { name: 'codex', command: 'codex' },
      ],
    ]);
    expect(client.hosts()[0]?.repos).toEqual([]);
    expect(existsSync(host.configPath)).toBe(false);
  });

  it('sends the shell, claude and codex presets when the configuration has no presets', async () => {
    host.writeConfig({ port: host.port });
    const client = await host.session();
    expect(presetsOf(client)).toEqual([
      [
        { name: 'shell', command: null },
        { name: 'claude', command: 'claude' },
        { name: 'codex', command: 'codex' },
      ],
    ]);
  });

  it('sends exactly the configured presets in their order', async () => {
    host.writeConfig({
      port: host.port,
      presets: [
        { name: 'claude', command: 'claude' },
        { name: 'shell', command: null },
      ],
    });
    const client = await host.session();
    expect(presetsOf(client)).toEqual([
      [
        { name: 'claude', command: 'claude' },
        { name: 'shell', command: null },
      ],
    ]);
  });

  it('answers a message before hello with bad-message and closes the session', async () => {
    const client = await host.open(['wtd', `wtd.token.${token}`]);
    await client.waitFor('hello');
    client.sendHost(0, { t: 'setVisible', termIds: [] });
    expect(await client.waitFor('error')).toEqual({ t: 'error', req: null, host: null, code: 'bad-message', message: ANY_TEXT });
    await client.waitClosed();
  });

  it('answers a hello of another protocol with version-mismatch and closes the session', async () => {
    const client = await host.open(['wtd', `wtd.token.${token}`]);
    await client.waitFor('hello');
    client.sendHello(BROWSER_PROTOCOL_VERSION + 1);
    expect(await client.waitFor('error')).toEqual({
      t: 'error',
      req: null,
      host: null,
      code: 'version-mismatch',
      message: ANY_TEXT,
    });
    await client.waitClosed();
  });
});

describe('malformed browser traffic', () => {
  let a: HubClient;
  let b: HubClient;

  beforeEach(async () => {
    await host.startHub();
    a = await host.session();
    b = await host.session();
  });

  /** Asserts `a` got bad-message and closed while `b` still answers. */
  const expectOnlyAClosed = async (): Promise<void> => {
    expect(await a.waitFor('error')).toMatchObject({ req: null, host: null, code: 'bad-message' });
    await a.waitClosed();
    const reply = await b.hubRequest({ t: 'reinstallDaemon', host: 0 });
    expect(reply.m).toMatchObject({ t: 'error', code: 'internal' });
    expect(b.isClosed).toBe(false);
  };

  it('closes only the session that sent invalid JSON', async () => {
    a.sendText('{"t":');
    await expectOnlyAClosed();
  });

  it('closes a session sending an unknown message', async () => {
    a.sendJson({ t: 'frobnicate' });
    await expectOnlyAClosed();
  });

  it('closes a session sending a second hello', async () => {
    a.sendHello();
    await expectOnlyAClosed();
  });

  it.each(['output', 'snapshot'] as const)('closes a session sending a %s frame', async (kind) => {
    a.sendBinary(encodeWsData(0, { kind, termId: 1, offset: 0, data: new TextEncoder().encode('x') }));
    await expectOnlyAClosed();
  });

  it('closes a session sending a binary message shorter than its header', async () => {
    a.sendBinary(new Uint8Array([3]));
    await expectOnlyAClosed();
  });
});
