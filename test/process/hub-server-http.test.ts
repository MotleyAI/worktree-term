import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sleep, type WtdProcess } from '../support/daemon-host.js';
import type { RawResponse } from '../support/hub-host.js';
import { ANY_WORD, fx, header, HEX64, packageVersion, useHubServerHost, waitExit, WEB } from '../support/hub-server.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });
useHubServerHost();

const CSP =
  "default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; object-src 'none'";

/** Asserts one line on stderr, without a stack trace. */
const expectOneLine = (stderr: string): void => {
  expect(stderr.trimEnd()).not.toBe('');
  expect(stderr.trimEnd()).not.toContain('\n');
  expect(stderr).not.toMatch(/\n\s+at /);
};

const expectSecurityHeaders = (response: RawResponse): void => {
  expect(header(response, 'content-security-policy')).toEqual([CSP]);
  expect(header(response, 'x-content-type-options')).toEqual(['nosniff']);
  expect(header(response, 'referrer-policy')).toEqual(['no-referrer']);
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
  mkdirSync(fx.host.stateDir, { recursive: true, mode: 0o700 });
  chmodSync(fx.host.stateDir, 0o700);
};

describe('loopback listener and hub record', () => {
  it('listens on exactly one TCP socket, 127.0.0.1 at the configured port', async () => {
    const hub = await fx.host.startHub();
    expect(listeningSockets(hub.pid)).toEqual([`127.0.0.1:${String(fx.host.port)}`]);
  });

  it('writes its record while running and removes it on SIGTERM', async () => {
    const hub = await fx.host.startHub();
    const record = fx.host.record();
    expect(record).toEqual({ pid: hub.pid, port: fx.host.port, instance: ANY_WORD });
    expect(statSync(fx.host.recordPath).mode & 0o777).toBe(0o600);
    hub.kill('SIGTERM');
    expect(await waitExit(hub)).toEqual({ code: 0, signal: null });
    expect(existsSync(fx.host.recordPath)).toBe(false);
  });

  it('leaves a record naming another instance on exit', async () => {
    const hub = await fx.host.startHub();
    const other = { pid: hub.pid, port: fx.host.port, instance: 'another_hub' };
    writeFileSync(fx.host.recordPath, JSON.stringify(other));
    hub.kill('SIGTERM');
    await waitExit(hub);
    expect(fx.host.record()).toEqual(other);
  });
});

describe('persistent token', () => {
  it('is 64 lowercase hex digits in an owner-only file', async () => {
    await fx.host.startHub();
    expect(fx.host.token()).toMatch(HEX64);
    expect(statSync(fx.host.tokenPath).mode & 0o777).toBe(0o600);
  });

  it('persists across restarts', async () => {
    const first = await fx.host.startHub();
    const token = fx.host.token();
    first.kill('SIGTERM');
    await waitExit(first);
    await fx.host.startHub();
    expect(fx.host.token()).toBe(token);
    expect((await fx.host.api('GET', '/api/identity', { token })).status).toBe(200);
  });

  it('refuses to start when the token path is a symbolic link, naming it', async () => {
    prepareStateDir();
    const target = join(fx.host.dir, 'elsewhere');
    writeFileSync(target, 'a'.repeat(64), { mode: 0o600 });
    symlinkSync(target, fx.host.tokenPath);
    const hub = fx.host.wtd(['hub']);
    expect(await waitExit(hub)).toEqual({ code: 1, signal: null });
    expectOneLine(hub.stderr);
    expect(hub.stderr).toContain(fx.host.tokenPath);
    expect(readFileSync(target, 'utf8')).toBe('a'.repeat(64));
  });

  it('refuses to start when the token path is a directory, naming it', async () => {
    prepareStateDir();
    mkdirSync(fx.host.tokenPath);
    const hub = fx.host.wtd(['hub']);
    expect(await waitExit(hub)).toEqual({ code: 1, signal: null });
    expectOneLine(hub.stderr);
    expect(hub.stderr).toContain(fx.host.tokenPath);
  });

  it('keeps a valid token with a loose mode and tightens it to 0600', async () => {
    prepareStateDir();
    const token = '0123456789abcdef'.repeat(4);
    writeFileSync(fx.host.tokenPath, token, { mode: 0o644 });
    chmodSync(fx.host.tokenPath, 0o644);
    await fx.host.startHub();
    expect(fx.host.token()).toBe(token);
    expect(statSync(fx.host.tokenPath).mode & 0o777).toBe(0o600);
  });

  it.each([
    ['text', 'not a token'],
    ['63 digits', 'a'.repeat(63)],
    ['uppercase digits', 'A'.repeat(64)],
    ['empty', ''],
  ])('replaces a malformed token (%s) with a new valid one', async (_name, content) => {
    prepareStateDir();
    writeFileSync(fx.host.tokenPath, content, { mode: 0o600 });
    await fx.host.startHub();
    expect(fx.host.token()).toMatch(HEX64);
    expect(statSync(fx.host.tokenPath).mode & 0o777).toBe(0o600);
    expect((await fx.host.api('GET', '/api/identity')).status).toBe(200);
  });
});

describe('request checks and headers', () => {
  beforeEach(async () => {
    await fx.host.startHub();
  });

  it.each([
    ['localhost', () => `localhost:${String(fx.host.port)}`],
    ['a foreign name', () => 'evil.example'],
    ['127.0.0.1 without the port', () => '127.0.0.1'],
    ['another port', () => `127.0.0.1:${String(fx.host.port + 1)}`],
  ])('refuses a request whose Host is %s with 403', async (_name, value) => {
    expect((await fx.host.http('GET', '/', { host: value() })).status).toBe(403);
    expect((await fx.host.api('GET', '/api/identity')).status).toBe(200);
    const identity = await fx.host.http('GET', '/api/identity', {
      host: value(),
      headers: [['Authorization', `Bearer ${fx.host.token()}`]],
    });
    expect(identity.status).toBe(403);
  });

  it('refuses a request without Host with 403', async () => {
    expect((await fx.host.http('GET', '/', { host: null })).status).toBe(403);
  });

  it('refuses a request with two Host headers with 403', async () => {
    const own = `127.0.0.1:${String(fx.host.port)}`;
    expect((await fx.host.http('GET', '/', { headers: [['Host', own]] })).status).toBe(403);
    expect((await fx.host.http('GET', '/', { headers: [['Host', 'evil.example']] })).status).toBe(403);
  });

  it('refuses an upgrade with a foreign Host with 403', async () => {
    expect((await fx.host.upgrade(['wtd', `wtd.token.${fx.host.token()}`], { host: 'evil.example' })).status).toBe(403);
  });

  it('sends the security headers with index.html', async () => {
    const response = await fx.host.http('GET', '/');
    expect(response.status).toBe(200);
    expectSecurityHeaders(response);
  });

  it('sends the security headers with every other response', async () => {
    const asset = readdirSync(join(WEB, 'assets'))[0];
    if (asset === undefined) throw new Error('no web asset');
    for (const response of [
      await fx.host.http('GET', `/assets/${asset}`),
      await fx.host.http('GET', '/nonexistent'),
      await fx.host.api('GET', '/api/identity'),
      await fx.host.api('GET', '/api/identity', { token: null }),
      await fx.host.http('GET', '/', { host: 'evil.example' }),
    ]) {
      expectSecurityHeaders(response);
    }
  });
});

describe('static bundle', () => {
  beforeEach(async () => {
    await fx.host.startHub();
  });

  it('serves index.html at / uncached', async () => {
    const response = await fx.host.http('GET', '/');
    expect(response.status).toBe(200);
    expect(header(response, 'cache-control')).toEqual(['no-cache']);
    expect(header(response, 'content-type')[0]).toMatch(/^text\/html/);
    expect(response.body).toBe(readFileSync(join(WEB, 'index.html'), 'utf8'));
  });

  it('serves every other bundle file as immutable', async () => {
    const assets = readdirSync(join(WEB, 'assets'));
    expect(assets.length).toBeGreaterThan(0);
    for (const asset of assets) {
      const response = await fx.host.http('GET', `/assets/${asset}`);
      expect(response.status).toBe(200);
      expect(header(response, 'cache-control')).toEqual(['public, max-age=31536000, immutable']);
      if (asset.endsWith('.js')) {
        expect(header(response, 'content-type')[0]).toMatch(/javascript/);
        expect(response.body).toBe(readFileSync(join(WEB, 'assets', asset), 'utf8'));
      }
    }
  });

  it.each(['/nonexistent', '/index.htm', '/assets/', '/assets/nonexistent.js', '/api', '/ws/x'])('answers %s with 404', async (path) => {
    expect((await fx.host.http('GET', path)).status).toBe(404);
  });

  it.each(['/../package.json', '/%2e%2e/package.json', '/assets/../index.html', '/%2fetc%2fpasswd', '/..%2fpackage.json'])(
    'refuses traversal %s with 404',
    async (path) => {
      expect((await fx.host.http('GET', path)).status).toBe(404);
    },
  );
});

describe('identity and shutdown', () => {
  let hub: WtdProcess;

  beforeEach(async () => {
    hub = await fx.host.startHub();
  });

  it('reports the package version and the record’s instance', async () => {
    expect(await fx.host.identity()).toEqual({ version: packageVersion(), instance: fx.host.record()?.instance });
  });

  it('refuses identity without the token with 401 and from another origin with 403', async () => {
    expect((await fx.host.api('GET', '/api/identity', { token: null })).status).toBe(401);
    expect((await fx.host.api('GET', '/api/identity', { token: '1'.repeat(64) })).status).toBe(401);
    expect((await fx.host.api('GET', '/api/identity', { origin: 'http://evil.example' })).status).toBe(403);
  });

  it('refuses shutdown without the token with 401 and keeps running', async () => {
    expect((await fx.host.api('POST', '/api/shutdown', { token: null })).status).toBe(401);
    expect((await fx.host.api('POST', '/api/shutdown', { token: '1'.repeat(64) })).status).toBe(401);
    await sleep(300);
    expect(await fx.host.serving()).toBe(true);
  });

  it('refuses shutdown from another origin with 403 and keeps running', async () => {
    expect((await fx.host.api('POST', '/api/shutdown', { origin: 'http://evil.example' })).status).toBe(403);
    await sleep(300);
    expect(await fx.host.serving()).toBe(true);
  });

  it('answers an authenticated shutdown and then exits 0, removing its record', async () => {
    const response = await fx.host.api('POST', '/api/shutdown');
    expect(response.status).toBeGreaterThanOrEqual(200);
    expect(response.status).toBeLessThan(300);
    expect(await waitExit(hub)).toEqual({ code: 0, signal: null });
    expect(existsSync(fx.host.recordPath)).toBe(false);
  });
});
