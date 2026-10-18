import { request } from 'node:http';
import { createServer, type Server, type Socket } from 'node:net';
import { PortInUseError } from './listener.js';

/** What a tunnel listener forwards: its host, the SSH alias, its local port and the remote hub's port. */
export interface TunnelTarget {
  host: string;
  alias: string;
  port: number;
  remotePort: number;
}

/** One relayed connection. */
export interface TunnelForward {
  /** Resolves when it ended: null when the local side ended first, else the cause. */
  ended: Promise<string | null>;
  close: () => void;
}

export interface TunnelOptions {
  /** Relays `socket` to `remotePort` on `alias`. */
  forward: (alias: string, remotePort: number, socket: Socket) => TunnelForward;
  /** Whether the configuration the hub last read still maps `target`'s host to its alias and port. */
  current: (target: Omit<TunnelTarget, 'remotePort'>) => boolean;
}

const PROBE_GRACE_MS = 1000;

/** A loopback listener forwarding each connection to one remote hub. */
class Tunnel {
  private readonly forwards = new Set<TunnelForward>();
  /** The cause the latest forward ended with since the last reset, if it failed. */
  private lastFailure: string | null = null;

  constructor(
    readonly server: Server,
    public target: TunnelTarget,
    private readonly options: TunnelOptions,
  ) {
    server.on('connection', (socket: Socket) => {
      this.accept(socket);
    });
  }

  failure(): string | null {
    return this.lastFailure;
  }

  resetFailure(): void {
    this.lastFailure = null;
  }

  /** Whether its forwards are all ended. */
  get idle(): boolean {
    return this.forwards.size === 0;
  }

  private accept(socket: Socket): void {
    const { host, alias, port, remotePort } = this.target;
    if (!this.options.current({ host, alias, port })) {
      socket.destroy();
      return;
    }
    const forward = this.options.forward(alias, remotePort, socket);
    this.forwards.add(forward);
    void forward.ended.then((cause) => {
      this.forwards.delete(forward);
      if (cause !== null) this.lastFailure = cause;
    });
  }

  async close(): Promise<void> {
    const closed = new Promise<void>((resolve) => {
      this.server.close(() => {
        resolve();
      });
    });
    for (const forward of this.forwards) forward.close();
    await closed;
  }
}

const listen = (port: number): Promise<Server> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', (error) => {
      reject('code' in error && error.code === 'EADDRINUSE' ? new PortInUseError(port) : error);
    });
    server.listen(port, '127.0.0.1', () => {
      resolve(server);
    });
  });

/** The hub's tunnel listeners, at most one per port, changed one at a time. */
export class TunnelListeners {
  private readonly tunnels = new Map<number, Tunnel>();
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(private readonly options: TunnelOptions) {}

  /**
   * Makes a listener on `target.port` forward to `target`: binds one, repoints the existing one, and
   * closes the host's listener on any other port. Rejects with PortInUseError when another process holds the port.
   */
  ensure(target: TunnelTarget): Promise<void> {
    return this.serialised(async () => {
      if (this.closed) throw new Error('the hub is shutting down');
      for (const [port, tunnel] of this.tunnels) {
        if (port !== target.port && tunnel.target.host === target.host) {
          this.tunnels.delete(port);
          await tunnel.close();
        }
      }
      const existing = this.tunnels.get(target.port);
      if (existing !== undefined) {
        existing.target = target;
        return;
      }
      this.tunnels.set(target.port, new Tunnel(await listen(target.port), target, this.options));
    });
  }

  /**
   * Fetches `GET /` through the listener on `port`; resolves null on status 200 within `timeoutMs`,
   * else the failure: the forward's cause when it gave one. Aborting `signal` ends the request.
   */
  async probe(port: number, timeoutMs: number, signal: AbortSignal): Promise<string | null> {
    const tunnel = this.tunnels.get(port);
    if (tunnel === undefined) return `no tunnel listens on port ${String(port)}`;
    tunnel.resetFailure();
    const failure = await new Promise<string | null>((resolve) => {
      const req = request(
        { host: '127.0.0.1', port, path: '/', method: 'GET', headers: { Host: `127.0.0.1:${String(port)}` }, agent: false, signal },
        (res) => {
          res.resume();
          req.destroy();
          resolve(res.statusCode === 200 ? null : `the hub through port ${String(port)} answered ${String(res.statusCode)}`);
        },
      );
      req.setTimeout(timeoutMs, () => {
        req.destroy();
        resolve(`the hub through port ${String(port)} did not answer within ${String(timeoutMs / 1000)} s`);
      });
      req.on('error', (error) => {
        resolve(`the hub through port ${String(port)} did not answer: ${error.message}`);
      });
      req.end();
    });
    if (failure === null) return null;
    const deadline = Date.now() + PROBE_GRACE_MS;
    while (tunnel.failure() === null && !tunnel.idle && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20)); // NOSONAR(S9382) — waits for the probe's forward to report
    }
    return tunnel.failure() ?? failure;
  }

  /** Closes every listener and ends every forward; later `ensure` calls fail. */
  close(): Promise<void> {
    return this.serialised(async () => {
      this.closed = true;
      const tunnels = [...this.tunnels.values()];
      this.tunnels.clear();
      await Promise.all(tunnels.map((tunnel) => tunnel.close()));
    });
  }

  private serialised(run: () => Promise<void>): Promise<void> {
    const next = this.queue.then(run);
    this.queue = next.catch(() => undefined);
    return next;
  }
}
