import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FLOW_HIGH, FrameKind, DAEMON_PROTOCOL_VERSION, type Terminal } from '../../src/protocol/index.js';
import { alive, DaemonHost, residentBytes, sleep, waitUntil } from '../support/daemon-host.js';
import { FakeDaemon, SocketProxy } from '../support/fake-daemon.js';
import { ANY_TEXT, connected, fx, MiB, started, useHubRouterHost, watching } from '../support/hub-router.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });
useHubRouterHost();

describe('routing', () => {
  it('relays daemon messages and data byte-identically inside their envelopes', async () => {
    const backend = DaemonHost.create();
    try {
      await backend.start();
      const proxy = await SocketProxy.listen(fx.host.socket, backend.socket);
      const client = await fx.host.session();
      await connected(client);
      await client.watch(0, fx.repo);
      const term = await started(client, null);
      client.sendInput(0, term.termId, 'echo round-$((40+2))-trip\r');
      await client.waitOutput(0, term.termId, 'round-42-trip');
      await sleep(500);
      const daemonTexts = proxy.controlTexts().filter((text) => !text.includes('"t":"hello"'));
      expect(daemonTexts.some((text) => text.includes('"t":"repoState"'))).toBe(true);
      expect(daemonTexts.some((text) => text.includes('"t":"termCreated"'))).toBe(true);
      for (const text of daemonTexts)
        expect(
          client.texts.some((envelope) => envelope.includes(text)),
          text,
        ).toBe(true);
      const daemonData = proxy.fromDaemon.filter((f) => f.kind !== FrameKind.control);
      expect(daemonData.some((f) => f.kind === FrameKind.snapshot)).toBe(true);
      expect(client.data.map((d) => Buffer.from(d.raw.subarray(0, 3)))).toEqual(daemonData.map((f) => Buffer.from([f.kind, 0, 0])));
      expect(client.data.map((d) => Buffer.from(d.raw.subarray(3)))).toEqual(daemonData.map((f) => Buffer.from(f.payload)));
      await proxy.close();
    } finally {
      await backend.cleanup();
    }
  });

  it('forwards requests without rewriting their ids, and acks only those the browser sends', async () => {
    const backend = DaemonHost.create();
    try {
      await backend.start();
      const proxy = await SocketProxy.listen(fx.host.socket, backend.socket);
      const client = await fx.host.session();
      await connected(client);
      client.autoAck = false;
      await client.watch(0, fx.repo);
      const term = await started(client, 'seq 1 50000; echo SEQ-DONE; exec sleep 60');
      await client.waitOutput(0, term.termId, 'SEQ-DONE', 10_000);
      await sleep(500);
      const sent = (): unknown[] => proxy.controlTextsToDaemon().map((text): unknown => JSON.parse(text));
      expect(sent()).toContainEqual({ t: 'watchRepo', req: 1, repo: fx.repo });
      expect(sent().filter((m) => typeof m === 'object' && m !== null && 't' in m && m.t === 'ack')).toEqual([]);
      const position = client.view(0, term.termId).position;
      client.sendHost(0, { t: 'ack', termId: term.termId, offset: position });
      await waitUntil(
        () => sent().some((m) => JSON.stringify(m) === JSON.stringify({ t: 'ack', termId: term.termId, offset: position })),
        'the ack',
      );
      await proxy.close();
    } finally {
      await backend.cleanup();
    }
  });

  it('answers a request to a reconnecting host with host-unavailable and drops its fire-and-forget messages', async () => {
    await FakeDaemon.listen(fx.host.socket, { protocol: DAEMON_PROTOCOL_VERSION, accept: 'close' });
    const client = await fx.host.session();
    await client.waitHost(0, (h) => h.status === 'reconnecting' || h.status === 'down');
    const reply = await client.request(0, { t: 'watchRepo', repo: fx.repo });
    expect(reply).toEqual({ from: 'hub', m: { t: 'error', req: 1, host: 0, code: 'host-unavailable', message: ANY_TEXT } });
    const from = client.mark();
    client.sendHost(0, { t: 'ack', termId: 1, offset: 0 });
    client.sendHost(0, { t: 'resize', termId: 1, cols: 80, rows: 24 });
    client.sendHost(0, { t: 'setVisible', termIds: [1] });
    client.sendInput(0, 1, 'x');
    await sleep(500);
    expect(client.messages.slice(from).filter((m) => m.t === 'error')).toEqual([]);
    expect(client.isClosed).toBe(false);
  });

  it('answers a request to an outdated host with version-mismatch', async () => {
    await FakeDaemon.listen(fx.host.socket, { protocol: 99 });
    const client = await fx.host.session();
    await client.waitHost(0, (h) => h.status === 'outdated');
    const reply = await client.request(0, { t: 'watchRepo', repo: fx.repo });
    expect(reply).toMatchObject({ from: 'hub', m: { t: 'error', req: 1, host: 0, code: 'version-mismatch' } });
  });

  it('answers a message for an unknown host with unknown-host', async () => {
    const client = await fx.host.session();
    await connected(client);
    const reply = await client.request(5, { t: 'watchRepo', repo: fx.repo });
    expect(reply).toMatchObject({ from: 'hub', m: { t: 'error', req: 1, code: 'unknown-host' } });
    const from = client.mark();
    client.sendHost(5, { t: 'setVisible', termIds: [] });
    expect(await client.waitFor('error', () => true, { from })).toMatchObject({ req: null, code: 'unknown-host' });
    expect(client.isClosed).toBe(false);
  });

  it('keeps sessions with the same request ids apart', async () => {
    const a = await fx.host.session();
    const b = await fx.host.session();
    await connected(a);
    await connected(b);
    await a.watch(0, fx.repo);
    await b.watch(0, fx.repo);
    const term = await b.create(0, fx.wt, { command: 'exec sleep 60' });
    await a.waitEvent(0, 'termCreated', (m) => m.term.termId === term.termId);
    expect(a.daemonEvents(0, 'done').map((m) => m.req)).toEqual([1]);
    expect(b.daemonEvents(0, 'done').map((m) => m.req)).toEqual([1]);
    expect(a.daemonEvents(0, 'termCreated').map((m) => m.req)).toEqual([null]);
    expect(b.daemonEvents(0, 'termCreated').map((m) => m.req)).toEqual([2]);
  });

  it('relays a snapshot near the frame limit intact', async () => {
    const client = await watching();
    const awk = `awk 'BEGIN { for (l = 0; l < 5100; l++) { s = ""; for (c = 0; c < 500; c++) s = s "\\033[31ma\\033[32mb"; print s } }'; echo BIG-DONE`;
    const term = await client.create(0, fx.wt, { command: awk, cols: 1000, rows: 50 });
    await client.waitEvent(0, 'termExited', (m) => m.termId === term.termId, { timeout: 90_000 });
    const view = await client.attach(0, term.termId, 60_000);
    const snapshot = view.attachments[0]?.snapshot;
    if (snapshot === undefined) throw new Error('no snapshot');
    expect(snapshot.length).toBeGreaterThan(8 * MiB);
    const direct = await fx.host.client();
    await direct.watch(fx.repo);
    const reference = (await direct.attach(term.termId, 60_000)).attachments[0]?.snapshot;
    expect(Buffer.from(snapshot).equals(Buffer.from(reference ?? new Uint8Array()))).toBe(true);
    expect(await view.screen.text()).toContain('BIG-DONE');
  }, 180_000);
});

describe('back-pressure', () => {
  it('lets a browser that never acks receive at most FLOW_HIGH plus one chunk of a flood', async () => {
    const client = await watching();
    const term = await started(client, 'read go; seq 1 1500000; echo FLOOD-DONE');
    client.autoAck = false;
    const before = client.view(0, term.termId).bytes().length;
    const from = client.data.length;
    client.sendInput(0, term.termId, 'go\r');
    await client.waitEvent(0, 'detached', (m) => m.termId === term.termId, { timeout: 20_000 });
    const frames = client.data.slice(from).filter((d) => d.kind === 'output' && d.termId === term.termId);
    const largest = Math.max(0, ...frames.map((d) => d.data.length));
    expect(largest).toBeGreaterThan(0);
    expect(client.view(0, term.termId).bytes().length - before).toBeLessThanOrEqual(FLOW_HIGH + largest);
  });

  it('stays bounded for a session that stops reading, which can still send, while others keep receiving', async () => {
    const reader = await watching();
    const ticker = await started(reader, 'while true; do echo tick-$RANDOM; sleep 0.1; done');
    const stalled = await watching();
    const shell = await started(stalled, null);
    const floods: Terminal[] = [];
    for (let i = 0; i < 20; i++)
      floods.push(await stalled.create(0, fx.wt, { command: 'yes flood-line-with-some-padding-to-fill-frames' }));
    await sleep(1000);
    const baseline = residentBytes(fx.hub.pid);
    for (const flood of floods) await stalled.attach(0, flood.termId, 10_000);
    stalled.pauseReading();
    const marker = join(fx.host.dir, 'typed-while-stalled');
    let peak = baseline;
    const tickerBefore = reader.view(0, ticker.termId).bytes().length;
    for (let i = 0; i < 10; i++) {
      await sleep(500);
      peak = Math.max(peak, residentBytes(fx.hub.pid));
      if (i === 2) stalled.sendInput(0, shell.termId, `touch ${marker}\r`);
    }
    expect(peak - baseline).toBeLessThan(64 * MiB);
    expect(reader.view(0, ticker.termId).bytes().length).toBeGreaterThan(tickerBefore);
    await waitUntil(() => existsSync(marker), 'input from the stalled session');
    expect(alive(fx.hub.pid)).toBe(true);
  });
});
