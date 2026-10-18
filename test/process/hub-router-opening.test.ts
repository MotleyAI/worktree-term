import { readFileSync } from 'node:fs';
import { connect, createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { decodeRemoteFragment, type RemoteFragment } from '../../src/protocol/index.js';
import { alive, sleep, waitUntil } from '../support/daemon-host.js';
import { loginRun, type FakeRemote, type SshCall } from '../support/fake-ssh.js';
import { HubClient, type HubMessage, type HubMessageOf, type Reply } from '../support/hub-client.js';
import { freePort, rawHttp } from '../support/hub-host.js';
import {
  configFile,
  configure,
  fx,
  INSTALL_TIMEOUT,
  LOGIN_URL,
  PRINT_CODE,
  REMOTE_TIMEOUT,
  restartHub,
  useHubRouterHost,
} from '../support/hub-router.js';
import { remoteHub } from '../support/remote-hub.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });
useHubRouterHost();

const HEX64: unknown = expect.stringMatching(/^[0-9a-f]{64}$/);

/** The SSH runs of `alias` that ran `wtd ui --print-code`. */
const printCodeRuns = (alias = 'box'): SshCall[] => fx.ssh.calls().filter((call) => call.alias === alias && call.command === PRINT_CODE);

/** The forward (`-W`) runs of `alias`. */
const forwardRuns = (alias = 'box'): SshCall[] => fx.ssh.calls().filter((call) => call.alias === alias && call.forward !== null);

/** The live print-code run of `alias`, once one runs. */
const livePrintCode = (alias = 'box'): Promise<number> =>
  waitUntil(() => printCodeRuns(alias).find((call) => alive(call.pid))?.pid ?? false, `wtd ui --print-code on ${alias}`, REMOTE_TIMEOUT);

/** The port and decoded fragment of a `hubOpened` reply. */
const opened = (reply: Reply): { port: number; fragment: RemoteFragment } => {
  if (reply.m.t !== 'hubOpened') throw new Error(`not hubOpened: ${JSON.stringify(reply.m)}`);
  const url = new URL(reply.m.url);
  expect(`${url.protocol}//${url.hostname}${url.pathname}`).toBe('http://127.0.0.1/');
  return { port: Number(url.port), fragment: decodeRemoteFragment(url.hash.slice(1)) };
};

const openHub = (client: HubClient, idx: number, timeout = REMOTE_TIMEOUT): Promise<Reply> =>
  client.hubRequest({ t: 'openHub', host: idx }, timeout);

/** Whether a TCP connection to 127.0.0.1:`port` is refused. */
const refused = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => {
      resolve(true);
    });
  });

/** A raw TCP connection to 127.0.0.1:`port`. */
const tcp = (port: number): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.off('error', reject);
      resolve(socket);
    });
  });

/** Connects to 127.0.0.1:`port` and resolves once the other side closes the connection, failing after 3 s. */
const closedSoon = async (port: number): Promise<void> => {
  const socket = await tcp(port);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('the connection was not closed'));
    }, 3000);
    socket.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.on('error', () => undefined);
  });
};

/** Holds `port` on 127.0.0.1 until the returned function is called. */
const holdPort = async (port: number): Promise<() => void> => {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return () => server.close();
};

/** A session of the remote hub through the tunnel on `port`, with the code `wtd ui --print-code` gave. */
const tunneled = async (
  port: number,
  code: string,
): Promise<{ client: HubClient; hello: HubMessageOf<'hello'>; hosts: HubMessageOf<'hosts'> }> => {
  const origin = `http://127.0.0.1:${String(port)}`;
  const client = await HubClient.open(`ws://127.0.0.1:${String(port)}/ws`, { protocols: ['wtd', `wtd.code.${code}`], origin });
  return { client, ...(await client.handshake()) };
};

/** The hub record of the remote's own hub. */
const remoteRecord = (remote: FakeRemote): { instance: string } => {
  const value: unknown = JSON.parse(readFileSync(join(remote.runDir, 'hub.json'), 'utf8'));
  if (typeof value !== 'object' || value === null || !('instance' in value) || typeof value.instance !== 'string')
    throw new Error('bad record');
  return { instance: value.instance };
};

/** The configured `port` of host `name` in config.json, if any. */
const configuredPort = (name: string): number | undefined => {
  const config = z.object({ hosts: z.array(z.object({ name: z.string(), port: z.number().optional() })) }).parse(configFile());
  return config.hosts.find((h) => h.name === name)?.port;
};

/** Hub-level replies and notices for `req` received so far. */
const answersTo = (client: HubClient, req: number): HubMessage[] =>
  client.messages.filter((m) => (m.t === 'error' || m.t === 'hubLogin' || m.t === 'hubOpened' || m.t === 'done') && m.req === req);

/** A planted `wtd` printing a print-code line for `port`. */
const printsPort = (port: number): string => `echo '{"port":${String(port)},"code":"${'0'.repeat(64)}"}'`;

interface HeldHttp {
  port: number;
  /** Connections accepted so far. */
  accepted: () => number;
  /** Answers every held and later connection with `status`, e.g. `200 OK`. */
  answer: (status: string) => void;
  close: () => void;
}

/** An HTTP server on a free port that holds each connection until `answer` is called. */
const heldHttp = async (): Promise<HeldHttp> => {
  const sockets: Socket[] = [];
  let status: string | null = null;
  let count = 0;
  const reply = (socket: Socket, line: string): void => {
    socket.end(`HTTP/1.1 ${line}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
  };
  const server = createServer((socket) => {
    count++;
    socket.on('error', () => undefined);
    if (status === null) sockets.push(socket);
    else reply(socket, status);
  });
  const port = await freePort();
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    port,
    accepted: () => count,
    answer: (line) => {
      status = line;
      for (const socket of sockets.splice(0)) reply(socket, line);
    },
    close: () => {
      for (const socket of sockets.splice(0)) socket.destroy();
      server.close();
    },
  };
};

describe('opening a remote hub', () => {
  it(
    'assigns the first port above the hub’s, runs wtd ui --print-code there and forwards that port to the remote hub',
    async () => {
      const { remote, repo: remoteRepo, port: remotePort } = await remoteHub(fx.host, fx.ssh, 'box', [fx.host.port + 1]);
      fx.ssh.failHost('gpu', 'ssh: Could not resolve hostname gpu');
      configure([
        { name: 'box', ssh: 'box' },
        { name: 'gpu', ssh: 'gpu' },
      ]);
      const client = await fx.host.session();
      const reply = await openHub(client, 1);
      const { port, fragment } = opened(reply);
      expect(reply.m).toMatchObject({ t: 'hubOpened', req: 1 });
      expect(port).toBe(fx.host.port + 1);
      expect(fragment).toEqual({ code: HEX64, host: 'box', home: fx.host.port, hubs: ['box', 'gpu'] });
      expect(configFile()).toEqual({
        port: fx.host.port,
        repos: [fx.repo],
        hosts: [
          { name: 'box', ssh: 'box', port: fx.host.port + 1 },
          { name: 'gpu', ssh: 'gpu' },
        ],
      });

      const [run] = printCodeRuns();
      expect(run?.args.slice(0, 12)).toEqual([
        '-o',
        'BatchMode=yes',
        '-o',
        'ConnectTimeout=10',
        '-o',
        'ControlMaster=auto',
        '-o',
        'ControlPersist=10m',
        '-o',
        `ControlPath=${fx.host.runDir}/ssh-%C`,
        '-o',
        'ServerAliveInterval=15',
      ]);

      const page = await rawHttp(port, 'GET', '/');
      expect(page.status).toBe(200);
      const { client: remoteClient, hello, hosts } = await tunneled(port, fragment.code);
      expect(hello.instance).toBe(remoteRecord(remote).instance);
      expect(hello.instance).not.toBe((await fx.host.identity()).instance);
      expect(hosts.hosts[0]?.repos).toEqual([remoteRepo]);
      expect(forwardRuns().map((call) => call.forward)).toContain(`127.0.0.1:${String(remotePort)}`);
      expect(forwardRuns()[0]?.args.slice(0, 12)).toEqual(run?.args.slice(0, 12));
      remoteClient.close();
    },
    INSTALL_TIMEOUT,
  );

  it(
    'forwards a hand-written port, leaving config.json unchanged',
    async () => {
      const port = await freePort();
      await remoteHub(fx.host, fx.ssh, 'box', [port]);
      configure([{ name: 'box', ssh: 'box', port }]);
      const before = readFileSync(fx.host.configPath, 'utf8');
      const client = await fx.host.session();
      expect(opened(await openHub(client, 1)).port).toBe(port);
      expect(readFileSync(fx.host.configPath, 'utf8')).toBe(before);
      expect((await rawHttp(port, 'GET', '/')).status).toBe(200);
    },
    INSTALL_TIMEOUT,
  );

  it(
    'sends the login link of the print-code run once and then opens, with no time limit after the link',
    async () => {
      await remoteHub(fx.host, fx.ssh, 'box', [fx.host.port + 1]);
      configure([{ name: 'box', ssh: 'box' }]);
      await restartHub({ WTD_HUB_OPEN_MS: '1000' });
      fx.ssh.loginHost('box');
      const client = await fx.host.session();
      const pending = openHub(client, 1, REMOTE_TIMEOUT);
      const login = await client.waitFor('hubLogin', (m) => m.req === 1, { timeout: REMOTE_TIMEOUT });
      expect(login.login).toEqual(LOGIN_URL);
      const run = loginRun(login.login);
      expect(printCodeRuns().map((call) => call.pid)).toContain(run);
      await sleep(2500);
      expect(alive(run)).toBe(true);
      fx.ssh.skipLogin('box');
      fx.ssh.approveLogin(login.login);
      opened(await pending);
      expect(answersTo(client, 1).map((m) => m.t)).toEqual(['hubLogin', 'hubOpened']);
    },
    INSTALL_TIMEOUT,
  );

  it.each([
    ['exits 2, too old to know --print-code', 'echo "wtd: unknown option --print-code" >&2; exit 2'],
    ['exits 0 without a print-code line', 'echo "wtd 0.0.1"'],
    ['has no wtd, so the shell exits 127', null],
  ])('answers hub-outdated with the host’s index when wtd on the host %s, binding no listener', async (_name, script) => {
    const remote = fx.ssh.addHost('box');
    if (script !== null) remote.plantWtd(script);
    configure([{ name: 'box', ssh: 'box' }]);
    const client = await fx.host.session();
    const reply = await openHub(client, 1);
    expect(reply.m).toMatchObject({ t: 'error', req: 1, host: 1, code: 'hub-outdated' });
    expect(reply.m.t === 'error' ? reply.m.message : '').toMatch(/missing or too old/);
    expect(await refused(configuredPort('box') ?? fx.host.port + 1)).toBe(true);
    expect(forwardRuns()).toEqual([]);
  });

  it('answers hub-failed with SSH’s last line when the host cannot be reached', async () => {
    const line = 'ssh: Could not resolve hostname box: Name or service not known';
    fx.ssh.failHost('box', line);
    configure([{ name: 'box', ssh: 'box' }]);
    const client = await fx.host.session();
    expect((await openHub(client, 1)).m).toEqual({ t: 'error', req: 1, host: 1, code: 'hub-failed', message: line });
  });

  it('kills a print-code run that stays silent past the budget and answers hub-failed', async () => {
    fx.ssh.addHost('box').plantWtd('exec sleep 600');
    configure([{ name: 'box', ssh: 'box' }]);
    await restartHub({ WTD_HUB_OPEN_MS: '1000' });
    const client = await fx.host.session();
    const pending = openHub(client, 1);
    const run = await livePrintCode();
    const reply = await pending;
    expect(reply.m).toMatchObject({ t: 'error', req: 1, host: 1, code: 'hub-failed' });
    expect(reply.m.t === 'error' ? reply.m.message : '').toMatch(/did not answer within/);
    await waitUntil(() => !alive(run), 'the silent print-code run to be killed', 5000);
  });

  it('kills a silent print-code run that ignores SIGTERM', async () => {
    fx.ssh.addHost('box');
    fx.ssh.hangHost('box');
    configure([{ name: 'box', ssh: 'box' }]);
    await restartHub({ WTD_HUB_OPEN_MS: '1000' });
    const client = await fx.host.session();
    const pending = openHub(client, 1);
    const run = await livePrintCode();
    expect((await pending).m).toMatchObject({ t: 'error', host: 1, code: 'hub-failed' });
    await waitUntil(() => !alive(run), 'the hung print-code run to be killed', 5000);
  });

  it('kills a print-code run writing over 4096 bytes and answers hub-failed', async () => {
    fx.ssh.addHost('box').plantWtd(String.raw`head -c 5000 /dev/zero | tr '\000' x; exec sleep 600`);
    configure([{ name: 'box', ssh: 'box' }]);
    const client = await fx.host.session();
    // The run is killed as soon as its output passes the limit, too soon to be seen alive reliably.
    const reply = await openHub(client, 1);
    expect(reply.m).toMatchObject({ t: 'error', req: 1, host: 1, code: 'hub-failed' });
    const [run] = printCodeRuns();
    expect(run).toBeDefined();
    await waitUntil(() => !alive(run?.pid ?? 0), 'the print-code run to be killed', 5000);
  });

  it('answers hub-failed once the probe through the forward outlasts WTD_HUB_PROBE_MS', async () => {
    const silent = createServer(() => undefined);
    const remotePort = await freePort();
    await new Promise<void>((resolve) => silent.listen(remotePort, '127.0.0.1', resolve));
    try {
      fx.ssh.addHost('box').plantWtd(`echo '{"port":${String(remotePort)},"code":"${'0'.repeat(64)}"}'`);
      configure([{ name: 'box', ssh: 'box' }]);
      await restartHub({ WTD_HUB_PROBE_MS: '1000' });
      const client = await fx.host.session();
      const start = Date.now();
      expect((await openHub(client, 1)).m).toMatchObject({ t: 'error', req: 1, host: 1, code: 'hub-failed' });
      expect(Date.now() - start).toBeLessThan(8000);
    } finally {
      silent.close();
    }
  });

  it(
    'answers hub-failed naming the port when another process holds it',
    async () => {
      const port = await freePort();
      await remoteHub(fx.host, fx.ssh, 'box', [port]);
      configure([{ name: 'box', ssh: 'box', port }]);
      const release = await holdPort(port);
      try {
        const client = await fx.host.session();
        const reply = await openHub(client, 1);
        expect(reply.m).toMatchObject({ t: 'error', req: 1, host: 1, code: 'hub-failed' });
        expect(reply.m.t === 'error' ? reply.m.message : '').toContain(String(port));
      } finally {
        release();
      }
    },
    INSTALL_TIMEOUT,
  );

  it(
    'answers hub-failed with the forward’s refusal when the host forbids forwarding',
    async () => {
      await remoteHub(fx.host, fx.ssh, 'box', [fx.host.port + 1]);
      fx.ssh.refuseForwards('box');
      configure([{ name: 'box', ssh: 'box' }]);
      const client = await fx.host.session();
      expect((await openHub(client, 1)).m).toEqual({
        t: 'error',
        req: 1,
        host: 1,
        code: 'hub-failed',
        message: 'channel 0: open failed: administratively prohibited',
      });
    },
    INSTALL_TIMEOUT,
  );

  it.each([
    ['the local host', 0],
    ['an index beyond the hosts', 5],
  ])('answers unknown-host for %s, running nothing', async (_name, idx) => {
    fx.ssh.addHost('box');
    configure([{ name: 'box', ssh: 'box' }]);
    const client = await fx.host.session();
    expect((await openHub(client, idx)).m).toMatchObject({ t: 'error', req: 1, host: idx, code: 'unknown-host' });
    expect(printCodeRuns()).toEqual([]);
  });

  it('answers unknown-host for a host removed from config.json since the session started', async () => {
    fx.ssh.addHost('box');
    configure([{ name: 'box', ssh: 'box' }]);
    const client = await fx.host.session();
    configure([]);
    expect((await openHub(client, 1)).m).toMatchObject({ t: 'error', req: 1, host: 1, code: 'unknown-host' });
    expect(printCodeRuns()).toEqual([]);
  });

  it(
    'ends an opening when the session sends a newer one, which alone is answered',
    async () => {
      fx.ssh.addHost('slow').plantWtd('exec sleep 600');
      await remoteHub(fx.host, fx.ssh, 'box', [fx.host.port + 1, fx.host.port + 2]);
      configure([
        { name: 'slow', ssh: 'slow' },
        { name: 'box', ssh: 'box' },
      ]);
      const client = await fx.host.session();
      client.sendJson({ t: 'openHub', req: 50, host: 1 });
      const slow = await livePrintCode('slow');
      opened(await openHub(client, 2));
      await waitUntil(() => !alive(slow), 'the superseded print-code run to be killed', 5000);
      await sleep(1000);
      expect(answersTo(client, 50)).toEqual([]);
      const slowPort = configuredPort('slow');
      if (slowPort !== undefined) expect(await refused(slowPort)).toBe(true);
    },
    INSTALL_TIMEOUT,
  );

  it('kills the opening SSH process of a session that closes', async () => {
    fx.ssh.addHost('box').plantWtd('exec sleep 600');
    configure([{ name: 'box', ssh: 'box' }]);
    const client = await fx.host.session();
    client.sendJson({ t: 'openHub', req: 1, host: 1 });
    const run = await livePrintCode();
    client.close();
    await waitUntil(() => !alive(run), 'the opening’s SSH process to be killed', 5000);
    expect(alive(run)).toBe(false);
  });

  it('runs print-code over the alias config.json names now, not the one the session started with', async () => {
    fx.ssh.addHost('box').plantWtd('exit 2');
    configure([{ name: 'box', ssh: 'old' }]);
    const client = await fx.host.session();
    configure([{ name: 'box', ssh: 'box' }]);
    expect((await openHub(client, 1)).m).toMatchObject({ t: 'error', req: 1, host: 1, code: 'hub-outdated' });
    expect(printCodeRuns('box')).toHaveLength(1);
    expect(printCodeRuns('old')).toEqual([]);
  });

  it('resolves the host by its snapshot name after config.json reordered the hosts', async () => {
    fx.ssh.addHost('a').plantWtd('exit 2');
    fx.ssh.addHost('b').plantWtd('exit 2');
    configure([
      { name: 'a', ssh: 'a' },
      { name: 'b', ssh: 'b' },
    ]);
    const client = await fx.host.session();
    configure([
      { name: 'b', ssh: 'b' },
      { name: 'a', ssh: 'a' },
    ]);
    expect((await openHub(client, 1)).m).toMatchObject({ t: 'error', req: 1, host: 1, code: 'hub-outdated' });
    expect(printCodeRuns('a')).toHaveLength(1);
    expect(printCodeRuns('b')).toEqual([]);
  });

  it('answers hub-failed without hubOpened when the probe through the forward is not answered 200', async () => {
    const server = await heldHttp();
    server.answer('404 Not Found');
    try {
      fx.ssh.addHost('box').plantWtd(printsPort(server.port));
      configure([{ name: 'box', ssh: 'box' }]);
      const client = await fx.host.session();
      expect((await openHub(client, 1)).m).toMatchObject({ t: 'error', req: 1, host: 1, code: 'hub-failed' });
      expect(server.accepted()).toBeGreaterThan(0);
      expect(answersTo(client, 1).map((m) => m.t)).toEqual(['error']);
    } finally {
      server.close();
    }
  });

  it('ends an opening superseded during its probe: the probe’s 200 opens nothing and only the newer request is answered', async () => {
    const server = await heldHttp();
    try {
      fx.ssh.addHost('box').plantWtd(printsPort(server.port));
      fx.ssh.failHost('gpu', 'ssh: Could not resolve hostname gpu');
      configure([
        { name: 'box', ssh: 'box' },
        { name: 'gpu', ssh: 'gpu' },
      ]);
      await restartHub({ WTD_HUB_PROBE_MS: '20000' });
      const client = await fx.host.session();
      client.sendJson({ t: 'openHub', req: 50, host: 1 });
      await waitUntil(() => server.accepted() > 0, 'the probe to reach the remote', REMOTE_TIMEOUT);
      const forwards = fx.ssh.forwardPids('box');
      expect((await openHub(client, 2)).m).toMatchObject({ t: 'error', host: 2, code: 'hub-failed' });
      server.answer('200 OK');
      await waitUntil(() => forwards.every((pid) => !alive(pid)), 'the probe’s forward to end', 5000);
      await sleep(1000);
      expect(answersTo(client, 50)).toEqual([]);
    } finally {
      server.close();
    }
  });

  it('ends the probe of a session that closes, opening nothing once the remote answers', async () => {
    const server = await heldHttp();
    try {
      fx.ssh.addHost('box').plantWtd(printsPort(server.port));
      configure([{ name: 'box', ssh: 'box' }]);
      await restartHub({ WTD_HUB_PROBE_MS: '20000' });
      const client = await fx.host.session();
      client.sendJson({ t: 'openHub', req: 1, host: 1 });
      await waitUntil(() => server.accepted() > 0, 'the probe to reach the remote', REMOTE_TIMEOUT);
      const forwards = fx.ssh.forwardPids('box');
      client.close();
      await sleep(300);
      server.answer('200 OK');
      await waitUntil(() => forwards.every((pid) => !alive(pid)), 'the probe’s forward to end', 5000);
      expect(await fx.host.serving()).toBe(true);
    } finally {
      server.close();
    }
  });
});

describe('hub tunnels', () => {
  it(
    'serves two sessions opening the same host through one listener, each with its own code',
    async () => {
      await remoteHub(fx.host, fx.ssh, 'box', [fx.host.port + 1]);
      configure([{ name: 'box', ssh: 'box' }]);
      const a = await fx.host.session();
      const b = await fx.host.session();
      const [first, second] = await Promise.all([openHub(a, 1), openHub(b, 1)]).then((replies) => replies.map(opened));
      expect(printCodeRuns()).toHaveLength(2);
      expect(first?.port).toBe(fx.host.port + 1);
      expect(second?.port).toBe(first?.port);
      expect(second?.fragment.code).not.toBe(first?.fragment.code);
      for (const tunnel of [first, second]) {
        const { client } = await tunneled(tunnel?.port ?? 0, tunnel?.fragment.code ?? '');
        client.close();
      }
    },
    INSTALL_TIMEOUT,
  );

  it(
    'ends the forward of a connection when the page closes it',
    async () => {
      await remoteHub(fx.host, fx.ssh, 'box', [fx.host.port + 1]);
      configure([{ name: 'box', ssh: 'box' }]);
      const client = await fx.host.session();
      const { port, fragment } = opened(await openHub(client, 1));
      await waitUntil(() => fx.ssh.forwardPids('box').length === 0, 'the probe’s forward to end', 5000);
      const { client: page } = await tunneled(port, fragment.code);
      const pids = await waitUntil(() => fx.ssh.forwardPids('box').length > 0 && fx.ssh.forwardPids('box'), 'the page’s forward');
      page.close();
      await waitUntil(() => pids.every((pid) => !alive(pid)), 'the page’s forwards to end', 5000);
    },
    INSTALL_TIMEOUT,
  );

  it(
    'closes a connection to a host removed from config.json without starting SSH',
    async () => {
      await remoteHub(fx.host, fx.ssh, 'box', [fx.host.port + 1]);
      configure([{ name: 'box', ssh: 'box' }]);
      const client = await fx.host.session();
      const { port } = opened(await openHub(client, 1));
      configure([]);
      await fx.host.session();
      const before = forwardRuns().length;
      await closedSoon(port);
      await sleep(300);
      expect(forwardRuns()).toHaveLength(before);
    },
    INSTALL_TIMEOUT,
  );

  it(
    'rebinds a host whose port changed, closing its old listener',
    async () => {
      const [oldPort, newPort] = [await freePort(), await freePort()];
      await remoteHub(fx.host, fx.ssh, 'box', [oldPort, newPort]);
      configure([{ name: 'box', ssh: 'box', port: oldPort }]);
      const client = await fx.host.session();
      expect(opened(await openHub(client, 1)).port).toBe(oldPort);
      configure([{ name: 'box', ssh: 'box', port: newPort }]);
      const { port, fragment } = opened(await openHub(client, 1));
      expect(port).toBe(newPort);
      const { client: page } = await tunneled(newPort, fragment.code);
      page.close();
      await waitUntil(() => refused(oldPort), 'the old listener to close', 5000);
    },
    INSTALL_TIMEOUT,
  );

  it(
    'repoints its listener when the remote hub now serves another port',
    async () => {
      const { remote, repo: remoteRepo } = await remoteHub(fx.host, fx.ssh, 'box', [fx.host.port + 1]);
      configure([{ name: 'box', ssh: 'box' }]);
      const client = await fx.host.session();
      const first = opened(await openHub(client, 1));
      for (const pid of remote.hubPids()) process.kill(pid, 'SIGKILL');
      await waitUntil(() => remote.hubPids().length === 0, 'the remote hub to exit');
      let remotePort = await freePort();
      while (remotePort === first.port) remotePort = await freePort(); // NOSONAR(S9382) — retries until a port other than the tunnel's is free
      remote.writeHubConfig({ port: remotePort, repos: [remoteRepo] });
      const second = opened(await openHub(client, 1));
      expect(second.port).toBe(first.port);
      const { client: page, hello } = await tunneled(second.port, second.fragment.code);
      expect(hello.instance).toBe(remoteRecord(remote).instance);
      expect(forwardRuns().map((call) => call.forward)).toContain(`127.0.0.1:${String(remotePort)}`);
      page.close();
    },
    INSTALL_TIMEOUT,
  );

  it(
    'ends the open forwards of a listener retired by a port change',
    async () => {
      const [oldPort, newPort] = [await freePort(), await freePort()];
      await remoteHub(fx.host, fx.ssh, 'box', [oldPort, newPort]);
      configure([{ name: 'box', ssh: 'box', port: oldPort }]);
      const client = await fx.host.session();
      const { fragment } = opened(await openHub(client, 1));
      await waitUntil(() => fx.ssh.forwardPids('box').length === 0, 'the probe’s forward to end', 5000);
      const { client: page } = await tunneled(oldPort, fragment.code);
      const pids = await waitUntil(() => fx.ssh.forwardPids('box').length > 0 && fx.ssh.forwardPids('box'), 'the page’s forward');
      configure([{ name: 'box', ssh: 'box', port: newPort }]);
      expect(opened(await openHub(client, 1)).port).toBe(newPort);
      await waitUntil(() => pids.every((pid) => !alive(pid)), 'the retired listener’s forwards to end', 5000);
      expect(await refused(oldPort)).toBe(true);
      page.close();
    },
    INSTALL_TIMEOUT,
  );

  it(
    'closes a connection without starting SSH once the host’s alias was remapped',
    async () => {
      const port = await freePort();
      await remoteHub(fx.host, fx.ssh, 'box', [port]);
      configure([{ name: 'box', ssh: 'box', port }]);
      const client = await fx.host.session();
      opened(await openHub(client, 1));
      configure([{ name: 'box', ssh: 'elsewhere', port }]);
      await fx.host.session();
      const before = fx.ssh.calls().filter((call) => call.forward !== null).length;
      await closedSoon(port);
      await sleep(300);
      expect(fx.ssh.calls().filter((call) => call.forward !== null)).toHaveLength(before);
    },
    INSTALL_TIMEOUT,
  );

  it(
    'closes its listeners and ends every forward on SIGTERM, exiting 0',
    async () => {
      await remoteHub(fx.host, fx.ssh, 'box', [fx.host.port + 1]);
      configure([{ name: 'box', ssh: 'box' }]);
      const client = await fx.host.session();
      const { port, fragment } = opened(await openHub(client, 1));
      const { client: page } = await tunneled(port, fragment.code);
      const pids = await waitUntil(() => fx.ssh.forwardPids('box').length > 0 && fx.ssh.forwardPids('box'), 'the page’s forward');
      fx.hub.kill('SIGTERM');
      expect(await fx.hub.exited).toEqual({ code: 0, signal: null });
      expect(await refused(port)).toBe(true);
      await waitUntil(() => pids.every((pid) => !alive(pid)), 'the forwards to end', 5000);
      page.close();
    },
    INSTALL_TIMEOUT,
  );
});
