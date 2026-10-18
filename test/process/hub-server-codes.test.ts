import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sleep } from '../support/daemon-host.js';
import { ANY_HEX64, fx, header, refusal, useHubServerHost } from '../support/hub-server.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });
useHubServerHost();

describe('one-time codes', () => {
  beforeEach(async () => {
    await fx.host.startHub();
  });

  it('issues a code response with Cache-Control no-store', async () => {
    const response = await fx.host.api('POST', '/api/code');
    expect(response.status).toBe(200);
    expect(header(response, 'cache-control')).toEqual(['no-store']);
    expect(JSON.parse(response.body)).toEqual({ code: ANY_HEX64 });
  });

  it('issues a different code each time', async () => {
    expect(await fx.host.code()).not.toBe(await fx.host.code());
  });

  it('accepts the hub’s own Origin', async () => {
    expect((await fx.host.api('POST', '/api/code', { origin: fx.host.origin })).status).toBe(200);
  });

  it.each([
    ['a wrong token', () => '0'.repeat(64)],
    ['no token', () => null],
    ['a malformed token', () => 'x'],
  ])('refuses %s with 401', async (_name, token) => {
    expect((await fx.host.api('POST', '/api/code', { token: token() })).status).toBe(401);
  });

  it('refuses a cross-origin request with 403', async () => {
    expect((await fx.host.api('POST', '/api/code', { origin: 'http://evil.example' })).status).toBe(403);
  });

  it('accepts a body of exactly 1 KiB', async () => {
    expect((await fx.host.api('POST', '/api/code', { body: 'x'.repeat(1024) })).status).toBe(200);
  });

  it('refuses a body over 1 KiB', async () => {
    const response = await fx.host.api('POST', '/api/code', { body: 'x'.repeat(1025) });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });
});

describe('WebSocket authentication', () => {
  beforeEach(async () => {
    await fx.host.startHub();
  });

  it('refuses a code issued more than 30 s earlier with 401', async () => {
    const code = await fx.host.code();
    await sleep(31_000);
    expect(await refusal(fx.host.open(['wtd', `wtd.code.${code}`]))).toBe(401);
  }, 90_000);
});
