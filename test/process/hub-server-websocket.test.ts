import { existsSync, readFileSync, rmSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeWsData, MAX_FRAME, BROWSER_PROTOCOL_VERSION } from '../../src/protocol/index.js';
import { sleep, type WtdProcess } from '../support/daemon-host.js';
import type { HubClient, HubMessageOf } from '../support/hub-client.js';
import { ANY_TEXT, header, host, outcome, packageVersion, refusal, useHubServerHost, waitExit } from '../support/hub-server.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });
useHubServerHost();

/** The preset lists of every `presets` message received so far. */
const presetsOf = (client: HubClient): HubMessageOf<'presets'>['presets'][] =>
  client.messages.flatMap((m) => (m.t === 'presets' ? [m.presets] : []));

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
