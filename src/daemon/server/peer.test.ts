import { mkdtempSync, rmSync } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { END_GRACE_MS, Peer } from './peer.js';

const MiB = 1024 * 1024;

let dir: string;
let server: Server;
let client: Socket;
let peer: Peer;
let closed: Promise<number>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wtd-peer-'));
  const path = join(dir, 'p.sock');
  const accepted = new Promise<Socket>((resolve) => {
    server = createServer(resolve);
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  client = connect(path);
  const socket = await accepted;
  closed = new Promise((resolve) => {
    peer = new Peer(1, socket, {
      received: () => undefined,
      closed: () => {
        resolve(Date.now());
      },
    });
  });
});

afterEach(async () => {
  client.destroy();
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

it('closes after flushing to a reading client', async () => {
  client.resume();
  peer.sendData({ kind: 'output', termId: 1, offset: 0, data: Buffer.alloc(MiB) });
  const startedAt = Date.now();
  peer.end();
  expect((await closed) - startedAt).toBeLessThan(END_GRACE_MS);
});

it('cuts off a client that does not read what is queued', async () => {
  client.pause();
  for (let i = 0; i < 8; i++) peer.sendData({ kind: 'output', termId: 1, offset: i * MiB, data: Buffer.alloc(MiB) });
  const startedAt = Date.now();
  peer.end();
  expect((await closed) - startedAt).toBeGreaterThanOrEqual(END_GRACE_MS - 50);
});
