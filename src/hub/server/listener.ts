import { timingSafeEqual } from 'node:crypto';
import { createServer, STATUS_CODES, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import {
  decodeMessage,
  decodeWsData,
  encodeCodeResponse,
  encodeMessage,
  MAX_FRAME,
  PROTOCOL_VERSION,
  ProtocolError,
  type MessageOf,
} from '../../protocol/index.js';
import { hubError, type BrowserChannel, type RoutedSession } from '../router/index.js';
import type { CodeStore } from './codes.js';
import { parseCredential, SUBPROTOCOL, type Credential } from './credential.js';
import type { StaticFiles } from './static.js';

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy':
    "default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

type ErrorCode = Extract<MessageOf<'hubToBrowser'>, { t: 'error' }>['code'];

const MAX_BODY = 1024;
const BEARER = /^Bearer ([0-9a-f]{64})$/;
/** Close code for a session that broke the protocol. */
const POLICY_VIOLATION = 1008;
const GOING_AWAY = 1001;
const CLOSE_WAIT_MS = 1000;

/** The port is held by another process. */
export class PortInUseError extends Error {
  override readonly name = 'PortInUseError';

  constructor(readonly port: number) {
    super(`port ${String(port)} is in use`);
  }
}

export interface ListenerOptions {
  port: number;
  version: string;
  instance: string;
  token: string;
  codes: CodeStore;
  files: StaticFiles;
  /** Starts the routing of a new browser session. */
  openSession: (channel: BrowserChannel) => RoutedSession;
  /** An authenticated shutdown request was answered. */
  shutdown: () => void;
}

const sameSecret = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Values of the request header `name`, in arrival order. */
const headerValues = (req: IncomingMessage, name: string): string[] => {
  const values: string[] = [];
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i]?.toLowerCase() === name) values.push(req.rawHeaders[i + 1] ?? '');
  }
  return values;
};

const toBytes = (data: RawData): Uint8Array => {
  if (Array.isArray(data)) return Buffer.concat(data);
  return data instanceof ArrayBuffer ? new Uint8Array(data) : data;
};

/** A session's WebSocket as the router sends to it, counting bytes not yet written out. */
class WsChannel implements BrowserChannel {
  private pending = 0;
  onDrain: () => void = () => undefined;

  constructor(private readonly ws: WebSocket) {}

  send(data: string | Uint8Array): void {
    const size = typeof data === 'string' ? Buffer.byteLength(data) : data.length;
    this.pending += size;
    this.ws.send(data, { binary: typeof data !== 'string' }, () => {
      this.pending -= size;
      this.onDrain();
    });
  }

  unsent(): number {
    return this.pending;
  }
}

/** The hub's HTTP and WebSocket listener on 127.0.0.1. */
export class Listener {
  private readonly sockets = new Set<WebSocket>();
  /** Requests are refused with 503 until the hub is ready. */
  private ready = false;
  private readonly wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME,
    perMessageDeflate: false,
    handleProtocols: () => SUBPROTOCOL,
  });

  private constructor(
    private readonly server: Server,
    private readonly options: ListenerOptions,
  ) {
    server.on('request', (req: IncomingMessage, res: ServerResponse) => {
      this.request(req, res);
    });
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      this.upgrade(req, socket, head);
    });
  }

  /** Listens on 127.0.0.1:`options.port`; rejects with PortInUseError when it is taken. */
  static async listen(options: ListenerOptions): Promise<Listener> {
    const server = createServer({ requireHostHeader: false });
    const listener = new Listener(server, options);
    await new Promise<void>((resolve, reject) => {
      server.once('error', (error) => {
        reject('code' in error && error.code === 'EADDRINUSE' ? new PortInUseError(options.port) : error);
      });
      server.listen(options.port, '127.0.0.1', resolve);
    });
    return listener;
  }

  /** Starts answering requests. */
  open(): void {
    this.ready = true;
  }

  /** Closes every session with 1001 and stops listening. */
  async close(): Promise<void> {
    const closing = [...this.sockets].map(
      (ws) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            ws.terminate();
          }, CLOSE_WAIT_MS);
          ws.once('close', () => {
            clearTimeout(timer);
            resolve();
          });
          ws.close(GOING_AWAY, 'hub shutting down');
        }),
    );
    await Promise.all(closing);
    await new Promise<void>((resolve) => {
      this.server.close(() => {
        resolve();
      });
      this.server.closeAllConnections();
    });
  }

  private get origin(): string {
    return `http://127.0.0.1:${String(this.options.port)}`;
  }

  private hostAllowed(req: IncomingMessage): boolean {
    const hosts = headerValues(req, 'host');
    return hosts.length === 1 && hosts[0] === `127.0.0.1:${String(this.options.port)}`;
  }

  /** Whether the request carries no Origin or exactly the hub's own. */
  private originAllowed(req: IncomingMessage, required: boolean): boolean {
    const origins = headerValues(req, 'origin');
    if (origins.length === 0) return !required;
    return origins.length === 1 && origins[0] === this.origin;
  }

  private authorized(req: IncomingMessage): boolean {
    const values = headerValues(req, 'authorization');
    const match = values.length === 1 ? BEARER.exec(values[0] ?? '') : null;
    return match?.[1] !== undefined && sameSecret(match[1], this.options.token);
  }

  /** Answers with `body`, or for an error status with its status text as plain text. */
  private reply(res: ServerResponse, status: number, body?: string, headers: Record<string, string> = {}): void {
    const text = body ?? `${String(status)} ${STATUS_CODES[status] ?? ''}\n`;
    const type = body === undefined ? { 'Content-Type': 'text/plain; charset=utf-8' } : {};
    res.writeHead(status, { ...SECURITY_HEADERS, ...type, 'Content-Length': String(Buffer.byteLength(text)), ...headers });
    res.end(text);
  }

  private request(req: IncomingMessage, res: ServerResponse): void {
    if (!this.hostAllowed(req)) {
      this.reply(res, 403);
      return;
    }
    if (!this.ready) {
      this.reply(res, 503);
      return;
    }
    const path = (req.url ?? '').split('?')[0] ?? '';
    if (path.startsWith('/api/')) {
      this.api(req, res, path);
      return;
    }
    const file = req.method === 'GET' || req.method === 'HEAD' ? this.options.files.lookup(path) : null;
    if (file === null) {
      this.reply(res, 404);
      return;
    }
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': file.contentType,
      'Cache-Control': file.cacheControl,
      'Content-Length': String(file.body.length),
    });
    res.end(req.method === 'HEAD' ? undefined : file.body);
  }

  private api(req: IncomingMessage, res: ServerResponse, path: string): void {
    const route = `${req.method ?? ''} ${path}`;
    if (route !== 'POST /api/code' && route !== 'GET /api/identity' && route !== 'POST /api/shutdown') {
      this.reply(res, 404);
      return;
    }
    if (!this.originAllowed(req, false)) {
      this.reply(res, 403);
      return;
    }
    if (!this.authorized(req)) {
      this.reply(res, 401);
      return;
    }
    const noStore = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
    switch (route) {
      case 'POST /api/code':
        this.readSmallBody(req, res, () => {
          this.reply(res, 200, encodeCodeResponse({ code: this.options.codes.issue() }), noStore);
        });
        return;
      case 'GET /api/identity':
        this.reply(res, 200, JSON.stringify({ version: this.options.version, instance: this.options.instance }), noStore);
        return;
      case 'POST /api/shutdown':
        res.once('finish', () => {
          this.options.shutdown();
        });
        this.reply(res, 200, '{}', noStore);
    }
  }

  /** Reads and discards a body of at most 1 KiB, then calls `next`; a larger body gets 413. */
  private readSmallBody(req: IncomingMessage, res: ServerResponse, next: () => void): void {
    let size = 0;
    let refused = false;
    const refuse = (): void => {
      refused = true;
      res.once('finish', () => req.destroy());
      this.reply(res, 413, undefined, { Connection: 'close' });
    };
    if (Number(req.headers['content-length'] ?? '0') > MAX_BODY) {
      refuse();
      return;
    }
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY && !refused) refuse();
    });
    req.on('end', () => {
      if (!refused) next();
    });
  }

  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on('error', () => socket.destroy());
    const credential = parseCredential(headerValues(req, 'sec-websocket-protocol').join(', ') || undefined);
    const status = this.upgradeRefusal(req, credential);
    if (status !== null || credential === null) {
      const headers = Object.entries(SECURITY_HEADERS)
        .map(([name, value]) => `${name}: ${value}\r\n`)
        .join('');
      const code = status ?? 401;
      socket.end(`HTTP/1.1 ${String(code)} ${STATUS_CODES[code] ?? ''}\r\n${headers}Connection: close\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      // Only an accepted upgrade uses up a code; ws completes it synchronously, so no other upgrade interleaves.
      if (credential.kind === 'code' && !this.options.codes.consume(credential.secret)) {
        ws.close(POLICY_VIOLATION, 'code already used');
        return;
      }
      this.session(ws, credential.kind);
    });
  }

  /** The status an upgrade is refused with, or null to accept it. */
  private upgradeRefusal(req: IncomingMessage, credential: Credential | null): number | null {
    if (!this.hostAllowed(req)) return 403;
    if (!this.ready) return 503;
    if ((req.url ?? '') !== '/ws') return 404;
    if (!this.originAllowed(req, true)) return 403;
    return credential === null || !this.accepts(credential) ? 401 : null;
  }

  private accepts(credential: Credential): boolean {
    return credential.kind === 'token' ? sameSecret(credential.secret, this.options.token) : this.options.codes.valid(credential.secret);
  }

  private session(ws: WebSocket, kind: Credential['kind']): void {
    this.sockets.add(ws);
    const channel = new WsChannel(ws);
    const routed = this.options.openSession(channel);
    channel.onDrain = () => {
      routed.drained();
    };
    const send = (message: MessageOf<'hubToBrowser'>): void => {
      channel.send(encodeMessage('hubToBrowser', message));
    };
    let greeted = false;
    let ended = false;
    const end = (code: ErrorCode, message: string): void => {
      if (ended) return;
      ended = true;
      send(hubError(null, null, code, message));
      ws.close(POLICY_VIOLATION, code);
    };
    send({ t: 'hello', protocol: PROTOCOL_VERSION, version: this.options.version, instance: this.options.instance });
    if (kind === 'code') send({ t: 'token', token: this.options.token });
    /** Routes one browser message; returns the failure that ends the session, if any. */
    const handle = (bytes: Uint8Array, isBinary: boolean): { code: ErrorCode; message: string } | null => {
      if (isBinary) {
        const { host, frame } = decodeWsData(bytes);
        if (!greeted || frame.kind !== 'input') return { code: 'bad-message', message: 'unexpected data message' };
        routed.input(host, frame);
        return null;
      }
      const message = decodeMessage('browserToHub', bytes);
      if (greeted === (message.t === 'hello')) return { code: 'bad-message', message: greeted ? 'second hello' : 'expected hello' };
      if (message.t !== 'hello') {
        routed.receive(message);
        return null;
      }
      if (message.protocol !== PROTOCOL_VERSION) {
        return { code: 'version-mismatch', message: `the hub speaks protocol ${String(PROTOCOL_VERSION)}` };
      }
      greeted = true;
      routed.hello();
      return null;
    };
    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (ended) return;
      let failure;
      try {
        failure = handle(toBytes(data), isBinary);
      } catch (error) {
        if (!(error instanceof ProtocolError)) throw error;
        failure = { code: 'bad-message' as const, message: error.message };
      }
      if (failure !== null) end(failure.code, failure.message);
    });
    ws.on('error', () => undefined);
    ws.once('close', () => {
      this.sockets.delete(ws);
      routed.close();
    });
  }
}
