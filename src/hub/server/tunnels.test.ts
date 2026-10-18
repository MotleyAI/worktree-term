import { connect, createServer } from 'node:net';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { TunnelListeners, type TunnelTarget } from './tunnels.js';

let tunnels: TunnelListeners;

beforeEach(() => {
  tunnels = new TunnelListeners({
    forward: () => ({ ended: Promise.resolve(null), close: () => undefined }),
    current: () => true,
  });
});

afterEach(async () => {
  await tunnels.close();
});

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address === null || typeof address === 'string') reject(new Error('no port'));
        else resolve(address.port);
      });
    });
  });

/** Whether something accepts connections on `port`. */
const listening = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      resolve(false);
    });
  });

const target = (port: number, host = 'box'): TunnelTarget => ({ host, alias: host, port, remotePort: 7417 });

it('binds a listener on the target port', async () => {
  const port = await freePort();
  await tunnels.ensure(target(port), new AbortController().signal);
  expect(await listening(port)).toBe(true);
});

it('changes nothing for an aborted signal: no listener bound, the host’s other one kept', async () => {
  const [kept, port] = [await freePort(), await freePort()];
  await tunnels.ensure(target(kept), new AbortController().signal);
  await tunnels.ensure(target(port), AbortSignal.abort());
  expect(await listening(port)).toBe(false);
  expect(await listening(kept)).toBe(true);
});

it('binds nothing for an ensure aborted while it waits behind another', async () => {
  const [first, second] = [await freePort(), await freePort()];
  const controller = new AbortController();
  const waiting = Promise.all([
    tunnels.ensure(target(first, 'a'), new AbortController().signal),
    tunnels.ensure(target(second, 'b'), controller.signal),
  ]);
  controller.abort();
  await waiting;
  expect(await listening(first)).toBe(true);
  expect(await listening(second)).toBe(false);
});
