import WebSocket, { type RawData } from 'ws';
import {
  ACK_EVERY,
  decodeMessage,
  decodeWsData,
  encodeMessage,
  encodeWsData,
  PROTOCOL_VERSION,
  type MessageOf,
  type Terminal,
} from '../../src/protocol/index.js';
import { TermView, type RequestBody } from './daemon-client.js';

export type HubMessage = MessageOf<'hubToBrowser'>;
export type BrowserMessage = MessageOf<'browserToHub'>;
export type HubMessageOf<T extends HubMessage['t']> = Extract<HubMessage, { t: T }>;
export type HostEntry = HubMessageOf<'hosts'>['hosts'][number];
export type DaemonEvent = HubMessageOf<'host'>['m'];
export type DaemonEventOf<T extends DaemonEvent['t']> = Extract<DaemonEvent, { t: T }>;
type HubRequest = Extract<BrowserMessage, { req: number }>;
type Unnumbered<T> = T extends unknown ? Omit<T, 'req'> : never;
export type HubRequestBody = Unnumbered<HubRequest>;

/** A received binary WebSocket message, decoded, with its raw bytes. */
export interface ReceivedData {
  host: number;
  kind: 'output' | 'snapshot';
  termId: number;
  offset: number;
  data: Uint8Array;
  raw: Uint8Array;
}

/** A reply correlated to a request: a daemon reply inside an envelope, or a hub-level reply. */
export type Reply =
  | { from: 'daemon'; host: number; m: DaemonEventOf<'done' | 'error' | 'termCreated' | 'reposDiscovered'> }
  | { from: 'hub'; m: HubMessageOf<'done' | 'error' | 'reposDiscovered'> };

/** Thrown when the hub answers an upgrade with an HTTP response instead of switching protocols. */
export class UpgradeRefused extends Error {
  override readonly name = 'UpgradeRefused';

  constructor(readonly status: number) {
    super(`upgrade refused with status ${String(status)}`);
  }
}

export interface OpenOptions {
  /** Offered subprotocols, e.g. `['wtd', 'wtd.token.<token>']`. */
  protocols: readonly string[];
  /** `Origin` header; null sends none. */
  origin: string | null;
  headers?: Record<string, string>;
}

const DEFAULT_TIMEOUT = 5000;

const encoder = new TextEncoder();
const bytesOf = (data: string | Uint8Array): Uint8Array => (typeof data === 'string' ? encoder.encode(data) : data);

const toBytes = (data: RawData): Uint8Array => {
  if (Array.isArray(data)) return Buffer.concat(data);
  return data instanceof ArrayBuffer ? new Uint8Array(data) : data;
};

const viewKey = (host: number, termId: number): string => `${String(host)}:${String(termId)}`;

/** A browser-side protocol client of the hub, recording everything it receives. */
export class HubClient {
  readonly messages: HubMessage[] = [];
  /** The JSON text of each received control message, index-aligned with `messages`. */
  readonly texts: string[] = [];
  readonly data: ReceivedData[] = [];
  readonly views = new Map<string, TermView>();
  /** Ack output as ACK_EVERY bytes accumulate. */
  autoAck = true;
  decodeError: Error | null = null;
  isClosed = false;
  closeCode: number | null = null;
  readonly closed: Promise<void>;

  private readonly listeners = new Set<() => void>();
  private readonly sizes = new Map<string, { cols: number; rows: number }>();
  private nextReq = 1;

  private constructor(readonly socket: WebSocket) {
    socket.binaryType = 'nodebuffer';
    socket.on('message', (data, isBinary) => {
      this.receive(toBytes(data), isBinary);
    });
    this.closed = new Promise((resolve) => {
      socket.once('close', (code) => {
        this.isClosed = true;
        this.closeCode = code;
        this.notify();
        resolve();
      });
    });
    socket.on('error', () => undefined);
  }

  /** Opens a WebSocket to `url`; rejects with UpgradeRefused when the hub refuses the upgrade. */
  static open(url: string, { protocols, origin, headers = {} }: OpenOptions): Promise<HubClient> {
    const socket = new WebSocket(url, [...protocols], {
      headers: origin === null ? headers : { ...headers, Origin: origin },
      perMessageDeflate: false,
    });
    return new Promise((resolve, reject) => {
      socket.once('unexpected-response', (_req, res) => {
        res.resume();
        socket.terminate();
        reject(new UpgradeRefused(res.statusCode ?? 0));
      });
      socket.once('error', reject);
      socket.once('open', () => {
        socket.off('error', reject);
        resolve(new HubClient(socket));
      });
    });
  }

  /** The subprotocol the hub selected. */
  get protocol(): string {
    return this.socket.protocol;
  }

  /** Waits for the hub's hello, sends ours, and waits for the first `hosts`. */
  async handshake(protocol = PROTOCOL_VERSION): Promise<{ hello: HubMessageOf<'hello'>; hosts: HubMessageOf<'hosts'> }> {
    const hello = await this.waitFor('hello');
    const from = this.mark();
    this.sendHello(protocol);
    const hosts = await this.waitFor('hosts', () => true, { from });
    return { hello, hosts };
  }

  sendHello(protocol = PROTOCOL_VERSION): void {
    this.send({ t: 'hello', protocol, version: '0.0.0-test', instance: 'test_browser' });
  }

  send(message: BrowserMessage): void {
    this.socket.send(encodeMessage('browserToHub', message));
  }

  /** Sends arbitrary JSON as a text message, bypassing the encoder. */
  sendJson(value: unknown): void {
    this.socket.send(JSON.stringify(value));
  }

  sendText(text: string): void {
    this.socket.send(text);
  }

  sendBinary(bytes: Uint8Array): void {
    this.socket.send(bytes, { binary: true });
  }

  sendHost(host: number, m: Extract<BrowserMessage, { t: 'host' }>['m']): void {
    this.send({ t: 'host', host, m });
  }

  sendInput(host: number, termId: number, data: string | Uint8Array): void {
    this.sendBinary(encodeWsData(host, { kind: 'input', termId, data: bytesOf(data) }));
  }

  resize(host: number, termId: number, cols: number, rows: number): void {
    this.sizes.set(viewKey(host, termId), { cols, rows });
    const view = this.views.get(viewKey(host, termId));
    if (view !== undefined) {
      view.cols = cols;
      view.rows = rows;
      view.screen.terminal.resize(cols, rows);
    }
    this.sendHost(host, { t: 'resize', termId, cols, rows });
  }

  /** Sends a daemon request to `host` with the next req; resolves with its correlated reply. */
  async request(host: number, body: RequestBody, timeout = DEFAULT_TIMEOUT): Promise<Reply> {
    const req = this.nextReq++;
    const from = this.mark();
    this.sendJson({ t: 'host', host, m: { ...body, req } });
    return this.reply(req, from, timeout);
  }

  /** Sends a hub-level request (restartDaemon, addRepo, …) with the next req; resolves with its reply. */
  async hubRequest(body: HubRequestBody, timeout = DEFAULT_TIMEOUT): Promise<Reply> {
    const req = this.nextReq++;
    const from = this.mark();
    this.sendJson({ ...body, req });
    return this.reply(req, from, timeout);
  }

  /** A daemon request expected to succeed with `done`. */
  async ok(host: number, body: RequestBody, timeout = DEFAULT_TIMEOUT): Promise<void> {
    const reply = await this.request(host, body, timeout);
    if (reply.m.t !== 'done') throw new Error(`${body.t} failed: ${JSON.stringify(reply)}`);
  }

  /** Watches a repo on `host`; resolves with the repoState preceding `done`. */
  async watch(host: number, repo: string): Promise<DaemonEventOf<'repoState'>> {
    const from = this.mark();
    await this.ok(host, { t: 'watchRepo', repo });
    const state = this.daemonEvents(host, 'repoState', from).findLast((m) => m.repo === repo);
    if (state === undefined) throw new Error(`no repoState before done for ${repo}`);
    return state;
  }

  async create(host: number, worktree: string, options: { command?: string | null; cols?: number; rows?: number } = {}): Promise<Terminal> {
    const reply = await this.request(host, {
      t: 'createTerm',
      worktree,
      preset: 'shell',
      command: options.command ?? null,
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
    });
    if (reply.m.t !== 'termCreated') throw new Error(`createTerm failed: ${JSON.stringify(reply)}`);
    return reply.m.term;
  }

  /** Attaches and resolves with the view once `done` arrived (the snapshot precedes it). */
  async attach(host: number, termId: number, timeout = DEFAULT_TIMEOUT): Promise<TermView> {
    await this.ok(host, { t: 'attach', termId }, timeout);
    return this.view(host, termId);
  }

  view(host: number, termId: number): TermView {
    const key = viewKey(host, termId);
    let view = this.views.get(key);
    if (view === undefined) {
      const size = this.sizes.get(key) ?? { cols: 80, rows: 24 };
      view = new TermView(termId, size.cols, size.rows);
      this.views.set(key, view);
    }
    return view;
  }

  /** Number of control messages received so far; pass as `from` to wait only for later ones. */
  mark(): number {
    return this.messages.length;
  }

  /** Daemon events of type `t` from `host` received since index `from`. */
  daemonEvents<T extends DaemonEvent['t']>(host: number, t: T, from = 0): DaemonEventOf<T>[] {
    const isT = (m: DaemonEvent): m is DaemonEventOf<T> => m.t === t;
    return this.messages.slice(from).flatMap((m) => (m.t === 'host' && m.host === host && isT(m.m) ? [m.m] : []));
  }

  /** The host entries of the latest `hosts` message. */
  hosts(): HostEntry[] {
    const latest = this.messages.findLast((m): m is HubMessageOf<'hosts'> => m.t === 'hosts');
    return latest?.hosts ?? [];
  }

  /** Resolves with the first `hosts` entry for `idx`, from index `from`, matching `predicate`. */
  async waitHost(idx: number, predicate: (entry: HostEntry) => boolean, { from = 0, timeout = DEFAULT_TIMEOUT } = {}): Promise<HostEntry> {
    const message = await this.waitFor('hosts', (m) => m.hosts.some((h) => h.idx === idx && predicate(h)), { from, timeout });
    const entry = message.hosts.find((h) => h.idx === idx && predicate(h));
    if (entry === undefined) throw new Error('unreachable');
    return entry;
  }

  /** Resolves with the first control message from index `from` of type `t` matching `predicate`. */
  waitFor<T extends HubMessage['t']>(
    t: T | readonly T[],
    predicate: (message: HubMessageOf<T>) => boolean = () => true,
    { from = 0, timeout = DEFAULT_TIMEOUT }: { from?: number; timeout?: number } = {},
  ): Promise<HubMessageOf<T>> {
    const types: readonly string[] = typeof t === 'string' ? [t] : t;
    const matches = (m: HubMessage): m is HubMessageOf<T> => types.includes(m.t);
    return this.until(
      () => this.messages.slice(from).find((m): m is HubMessageOf<T> => matches(m) && predicate(m)),
      timeout,
      `message ${types.join('|')}`,
    );
  }

  /** Resolves with the first daemon event of type `t` from `host`, from index `from`, matching `predicate`. */
  waitEvent<T extends DaemonEvent['t']>(
    host: number,
    t: T,
    predicate: (message: DaemonEventOf<T>) => boolean = () => true,
    { from = 0, timeout = DEFAULT_TIMEOUT }: { from?: number; timeout?: number } = {},
  ): Promise<DaemonEventOf<T>> {
    return this.until(() => this.daemonEvents(host, t, from).find(predicate), timeout, `daemon event ${t} from host ${String(host)}`);
  }

  /** Fails if a control message of type `t` matching `predicate` arrives within `ms`. */
  async expectNone<T extends HubMessage['t']>(
    t: T,
    predicate: (message: HubMessageOf<T>) => boolean = () => true,
    ms = 500,
  ): Promise<void> {
    const from = this.mark();
    await new Promise((resolve) => setTimeout(resolve, ms));
    const isT = (m: HubMessage): m is HubMessageOf<T> => m.t === t;
    const found = this.messages.slice(from).filter(isT).find(predicate);
    if (found !== undefined) throw new Error(`unexpected ${JSON.stringify(found)}`);
  }

  /** Resolves once the terminal's output since its latest snapshot contains `pattern`. */
  waitOutput(host: number, termId: number, pattern: string, timeout = DEFAULT_TIMEOUT): Promise<void> {
    return this.until(
      () => ((this.views.get(viewKey(host, termId))?.text() ?? '').includes(pattern) ? true : undefined),
      timeout,
      `output ${JSON.stringify(pattern)} on terminal ${viewKey(host, termId)}`,
    ).then(() => undefined);
  }

  async waitClosed(timeout = DEFAULT_TIMEOUT): Promise<void> {
    await this.until(() => (this.isClosed ? true : undefined), timeout, 'WebSocket close');
  }

  /** Stops reading from the WebSocket, so the hub's sends back up. */
  pauseReading(): void {
    this.socket.pause();
  }

  resumeReading(): void {
    this.socket.resume();
  }

  close(): void {
    this.socket.terminate();
  }

  private reply(req: number, from: number, timeout: number): Promise<Reply> {
    return this.until(
      () => {
        for (const m of this.messages.slice(from)) {
          if (m.t === 'host' && 'req' in m.m && m.m.req === req) return { from: 'daemon', host: m.host, m: m.m } satisfies Reply;
          if ((m.t === 'done' || m.t === 'error' || m.t === 'reposDiscovered') && m.req === req) return { from: 'hub', m } satisfies Reply;
        }
        return undefined;
      },
      timeout,
      `reply to req ${String(req)}`,
    );
  }

  /** Polls `probe` on every received message until it yields a value. */
  private until<T>(probe: () => T | undefined, timeout: number, what: string): Promise<T> {
    const found = probe();
    if (found !== undefined) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const check = (): void => {
        const value = probe();
        if (value === undefined) return;
        clearTimeout(timer);
        this.listeners.delete(check);
        resolve(value);
      };
      const timer = setTimeout(() => {
        this.listeners.delete(check);
        const last = this.texts.slice(-5).map((text) => text.slice(0, 200));
        reject(new Error(`timed out after ${String(timeout)} ms waiting for ${what}; last messages: ${last.join(' ')}`));
      }, timeout);
      this.listeners.add(check);
    });
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private receive(bytes: Uint8Array, isBinary: boolean): void {
    try {
      if (isBinary) this.onData(bytes);
      else {
        const text = new TextDecoder().decode(bytes);
        const message = decodeMessage('hubToBrowser', text);
        this.texts.push(text);
        this.messages.push(message);
        if (message.t === 'host' && message.m.t === 'termCreated') {
          this.sizes.set(viewKey(message.host, message.m.term.termId), { cols: message.m.term.cols, rows: message.m.term.rows });
        }
      }
    } catch (error) {
      this.decodeError = error instanceof Error ? error : new Error(String(error));
    }
    this.notify();
  }

  private onData(raw: Uint8Array): void {
    const { host, frame } = decodeWsData(raw);
    if (frame.kind === 'input') throw new Error('hub sent an input frame');
    this.data.push({ host, kind: frame.kind, termId: frame.termId, offset: frame.offset, data: frame.data, raw });
    const view = this.view(host, frame.termId);
    if (frame.kind === 'snapshot') {
      view.applySnapshot(frame.offset, frame.data);
      return;
    }
    view.applyOutput(frame.offset, frame.data);
    if (this.autoAck && view.position - view.acked >= ACK_EVERY) {
      view.acked = view.position;
      this.sendHost(host, { t: 'ack', termId: frame.termId, offset: view.position });
    }
  }
}
