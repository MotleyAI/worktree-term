import { connect, type Socket } from 'node:net';
import type { Readable, Writable } from 'node:stream';
import serializeAddon from '@xterm/addon-serialize';
import xterm from '@xterm/headless';
import {
  ACK_EVERY,
  decodeMessage,
  decodeStreamData,
  encodeFrame,
  encodeMessage,
  encodeStreamData,
  FrameKind,
  PROTOCOL_VERSION,
  StreamDecoder,
  type MessageOf,
  type Terminal,
} from '../../src/protocol/index.js';

export type Event = MessageOf<'daemonToClient'>;
export type Request = MessageOf<'clientToDaemon'>;
export type EventOf<T extends Event['t']> = Extract<Event, { t: T }>;

type Correlated = Extract<Request, { req: number }>;
type Unnumbered<T> = T extends unknown ? Omit<T, 'req'> : never;
export type RequestBody = Unnumbered<Correlated>;

export type Received =
  { kind: 'message'; message: Event } | { kind: 'output' | 'snapshot'; termId: number; offset: number; data: Uint8Array };

/** Everything observable about a screen: content with scrollback, cursor, active buffer and modes. */
export interface ScreenState {
  serialized: string;
  cursor: { x: number; y: number };
  buffer: 'normal' | 'alternate';
  modes: xterm.IModes;
}

const SCROLLBACK = 5000;
const DEFAULT_TIMEOUT = 5000;

const encoder = new TextEncoder();
const bytesOf = (data: string | Uint8Array): Uint8Array => (typeof data === 'string' ? encoder.encode(data) : data);

/** A headless terminal with the serialize addon, sized like the daemon's mirror. */
export class Screen {
  readonly terminal: xterm.Terminal;
  private readonly serializer = new serializeAddon.SerializeAddon();
  private pending: Promise<void> = Promise.resolve();

  constructor(cols: number, rows: number) {
    this.terminal = new xterm.Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true });
    this.terminal.loadAddon(this.serializer);
  }

  write(data: string | Uint8Array): void {
    this.pending = new Promise((resolve) => {
      this.terminal.write(data, resolve);
    });
  }

  /** Waits until everything written so far is parsed. */
  settled(): Promise<void> {
    return this.pending;
  }

  async state(): Promise<ScreenState> {
    await this.settled();
    const active = this.terminal.buffer.active;
    return {
      serialized: this.serializer.serialize({ scrollback: SCROLLBACK }),
      cursor: { x: active.cursorX, y: active.cursorY },
      buffer: active.type,
      modes: { ...this.terminal.modes },
    };
  }

  /** Plain text of scrollback and screen, trailing blanks trimmed. */
  async text(): Promise<string> {
    await this.settled();
    const buffer = this.terminal.buffer.active;
    const lines: string[] = [];
    for (let y = 0; y < buffer.length; y++) lines.push(buffer.getLine(y)?.translateToString(true) ?? '');
    return lines.join('\n').trimEnd();
  }
}

/** One attach's worth of a terminal as a client sees it: snapshot, then output. */
export interface Attachment {
  snapshotOffset: number;
  snapshot: Uint8Array;
  /** Offset of the first output frame after the snapshot, if any arrived. */
  firstOutput: number | null;
}

/** A client's view of one terminal, rebuilt on every snapshot. */
export class TermView {
  readonly attachments: Attachment[] = [];
  /** Output received since the latest snapshot. */
  readonly chunks: Uint8Array[] = [];
  /** Offsets of output frames that did not continue the previous one. */
  readonly gaps: { expected: number; got: number }[] = [];
  screen: Screen;
  /** Next expected output offset. */
  position = 0;
  acked = 0;
  private decoder = new TextDecoder();
  private decoded = '';

  constructor(
    readonly termId: number,
    public cols: number,
    public rows: number,
  ) {
    this.screen = new Screen(cols, rows);
  }

  applySnapshot(offset: number, data: Uint8Array): void {
    this.screen = new Screen(this.cols, this.rows);
    this.screen.write(data);
    this.attachments.push({ snapshotOffset: offset, snapshot: data, firstOutput: null });
    this.chunks.length = 0;
    this.decoder = new TextDecoder();
    this.decoded = '';
    this.position = offset;
    this.acked = offset;
  }

  applyOutput(offset: number, data: Uint8Array): void {
    const attachment = this.attachments.at(-1);
    if (attachment !== undefined) attachment.firstOutput ??= offset;
    if (offset !== this.position) this.gaps.push({ expected: this.position, got: offset });
    this.position = offset + data.length;
    this.chunks.push(data);
    this.decoded += this.decoder.decode(data, { stream: true });
    this.screen.write(data);
  }

  /** Output bytes received since the latest snapshot. */
  bytes(): Buffer {
    return Buffer.concat(this.chunks);
  }

  /** Output text received since the latest snapshot. */
  text(): string {
    return this.decoded;
  }
}

/** A protocol client of the daemon over a socket or a child process's stdio, recording everything received. */
export class DaemonClient {
  readonly received: Received[] = [];
  readonly messages: Event[] = [];
  readonly views = new Map<number, TermView>();
  /** Ack output as ACK_EVERY bytes accumulate. */
  autoAck = true;
  decodeError: Error | null = null;
  isClosed = false;
  readonly closed: Promise<void>;

  private readonly decoder = new StreamDecoder();
  private readonly sizes = new Map<number, { cols: number; rows: number }>();
  private readonly listeners = new Set<() => void>();
  private nextReq = 1;

  private constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly socket: Socket | null,
  ) {
    input.on('data', (chunk: Buffer) => {
      this.receive(chunk);
    });
    this.closed = new Promise((resolve) => {
      const done = (): void => {
        this.isClosed = true;
        this.notify();
        resolve();
      };
      input.once('close', done);
      input.once('end', done);
    });
    input.on('error', () => undefined);
    output.on('error', () => undefined);
  }

  /** Connects to a daemon socket; no handshake yet. */
  static async connect(path: string): Promise<DaemonClient> {
    const socket = connect(path);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    return new DaemonClient(socket, socket, socket);
  }

  /** Speaks the protocol over a readable (daemon to client) and a writable (client to daemon). */
  static over(input: Readable, output: Writable): DaemonClient {
    return new DaemonClient(input, output, null);
  }

  /** Waits for the daemon's hello, then sends ours. */
  async handshake(protocol = PROTOCOL_VERSION): Promise<EventOf<'hello'>> {
    const hello = await this.waitFor('hello');
    this.send({ t: 'hello', protocol, version: '0.0.0-test', instance: 'test_client' });
    return hello;
  }

  send(message: Request): void {
    this.sendRaw(encodeFrame({ kind: FrameKind.control, payload: encoder.encode(encodeMessage('clientToDaemon', message)) }));
  }

  sendInput(termId: number, data: string | Uint8Array): void {
    this.sendRaw(encodeStreamData({ kind: 'input', termId, data: bytesOf(data) }));
  }

  /** Sends a control frame holding arbitrary JSON text, bypassing the encoder. */
  sendJson(value: unknown): void {
    this.sendRaw(encodeFrame({ kind: FrameKind.control, payload: encoder.encode(JSON.stringify(value)) }));
  }

  sendRaw(bytes: Uint8Array): void {
    this.output.write(bytes);
  }

  resize(termId: number, cols: number, rows: number): void {
    this.sizes.set(termId, { cols, rows });
    const view = this.views.get(termId);
    if (view !== undefined) {
      view.cols = cols;
      view.rows = rows;
      view.screen.terminal.resize(cols, rows);
    }
    this.send({ t: 'resize', termId, cols, rows });
  }

  /** Sends a request with the next req and resolves with its correlated reply. */
  async request(body: RequestBody, timeout = DEFAULT_TIMEOUT): Promise<EventOf<'done' | 'error' | 'termCreated' | 'reposDiscovered'>> {
    const req = this.nextReq++;
    const from = this.messages.length;
    const message: unknown = { ...body, req };
    this.sendJson(message);
    return this.waitFor(['done', 'error', 'termCreated', 'reposDiscovered'], (m) => m.req === req, { from, timeout });
  }

  /** A request expected to succeed with `done`. */
  async ok(body: RequestBody, timeout = DEFAULT_TIMEOUT): Promise<void> {
    const reply = await this.request(body, timeout);
    if (reply.t !== 'done') throw new Error(`${body.t} failed: ${JSON.stringify(reply)}`);
  }

  /** A request expected to fail; resolves with the error code. */
  async fails(body: RequestBody, timeout = DEFAULT_TIMEOUT): Promise<string> {
    const reply = await this.request(body, timeout);
    if (reply.t !== 'error') throw new Error(`${body.t} unexpectedly succeeded: ${JSON.stringify(reply)}`);
    return reply.code;
  }

  /** Watches a repo; resolves with the repoState preceding `done`. */
  async watch(repo: string): Promise<EventOf<'repoState'>> {
    const from = this.messages.length;
    await this.ok({ t: 'watchRepo', repo });
    const states = this.messages.slice(from).filter((m): m is EventOf<'repoState'> => m.t === 'repoState' && m.repo === repo);
    const state = states.at(-1);
    if (state === undefined) throw new Error(`no repoState before done for ${repo}`);
    return state;
  }

  async create(
    worktree: string,
    options: { command?: string | null; preset?: string; cols?: number; rows?: number } = {},
  ): Promise<Terminal> {
    const reply = await this.request({
      t: 'createTerm',
      worktree,
      preset: options.preset ?? 'shell',
      command: options.command ?? null,
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
    });
    if (reply.t !== 'termCreated') throw new Error(`createTerm failed: ${JSON.stringify(reply)}`);
    return reply.term;
  }

  /** Attaches and resolves with the view once `done` arrived (the snapshot precedes it). */
  async attach(termId: number, timeout = DEFAULT_TIMEOUT): Promise<TermView> {
    await this.ok({ t: 'attach', termId }, timeout);
    return this.view(termId);
  }

  view(termId: number): TermView {
    let view = this.views.get(termId);
    if (view === undefined) {
      const size = this.sizes.get(termId) ?? { cols: 80, rows: 24 };
      view = new TermView(termId, size.cols, size.rows);
      this.views.set(termId, view);
    }
    return view;
  }

  /** Number of messages received so far; pass as `from` to wait only for later ones. */
  mark(): number {
    return this.messages.length;
  }

  /** Resolves with the first message from index `from` of type `t` matching `predicate`. */
  waitFor<T extends Event['t']>(
    t: T | readonly T[],
    predicate: (message: EventOf<T>) => boolean = () => true,
    { from = 0, timeout = DEFAULT_TIMEOUT }: { from?: number; timeout?: number } = {},
  ): Promise<EventOf<T>> {
    const types: readonly string[] = typeof t === 'string' ? [t] : t;
    const matches = (m: Event): m is EventOf<T> => types.includes(m.t);
    return this.until(
      () => this.messages.slice(from).find((m): m is EventOf<T> => matches(m) && predicate(m)),
      timeout,
      `message ${types.join('|')}`,
    );
  }

  /** Fails if a matching message arrives within `ms`. */
  async expectNone<T extends Event['t']>(t: T, predicate: (message: EventOf<T>) => boolean = () => true, ms = 500): Promise<void> {
    const from = this.mark();
    await new Promise((resolve) => setTimeout(resolve, ms));
    const isT = (m: Event): m is EventOf<T> => m.t === t;
    const found = this.messages.slice(from).filter(isT).find(predicate);
    if (found !== undefined) throw new Error(`unexpected ${JSON.stringify(found)}`);
  }

  /** Resolves once the terminal's output since its latest snapshot contains `pattern`. */
  waitOutput(termId: number, pattern: string, timeout = DEFAULT_TIMEOUT): Promise<void> {
    let searched = 0;
    return this.until(
      () => {
        const text = this.views.get(termId)?.text() ?? '';
        if (text.length < searched) searched = 0;
        const found = text.indexOf(pattern, Math.max(0, searched - pattern.length));
        searched = text.length;
        return found >= 0 ? true : undefined;
      },
      timeout,
      `output ${JSON.stringify(pattern)} on terminal ${String(termId)}`,
    ).then(() => undefined);
  }

  /** Resolves once the connection is closed. */
  async waitClosed(timeout = DEFAULT_TIMEOUT): Promise<void> {
    await this.until(() => (this.isClosed ? true : undefined), timeout, 'connection close');
  }

  /** Stops reading from the socket, so the daemon's writes back up. */
  pauseReading(): void {
    this.input.pause();
  }

  resumeReading(): void {
    this.input.resume();
  }

  close(): void {
    if (this.socket !== null) this.socket.destroy();
    else this.output.end();
  }

  /** Polls `probe` on every received chunk until it yields a value. */
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
        const last = this.messages.slice(-5).map((m) => JSON.stringify(m).slice(0, 200));
        reject(new Error(`timed out after ${String(timeout)} ms waiting for ${what}; last messages: ${last.join(' ')}`));
      }, timeout);
      this.listeners.add(check);
    });
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  private receive(chunk: Buffer): void {
    try {
      for (const frame of this.decoder.push(chunk)) {
        if (frame.kind === FrameKind.control) this.onMessage(decodeMessage('daemonToClient', frame.payload));
        else {
          const data = decodeStreamData(frame);
          if (data.kind === 'input') throw new Error('daemon sent an input frame');
          this.onData(data.kind, data.termId, data.offset, data.data);
        }
      }
    } catch (error) {
      this.decodeError = error instanceof Error ? error : new Error(String(error));
    }
    this.notify();
  }

  private onMessage(message: Event): void {
    this.received.push({ kind: 'message', message });
    this.messages.push(message);
    if (message.t === 'termCreated') this.sizes.set(message.term.termId, { cols: message.term.cols, rows: message.term.rows });
    if (message.t === 'repoState') {
      for (const term of message.terminals) {
        if (!this.sizes.has(term.termId)) this.sizes.set(term.termId, { cols: term.cols, rows: term.rows });
      }
    }
  }

  private onData(kind: 'output' | 'snapshot', termId: number, offset: number, data: Uint8Array): void {
    this.received.push({ kind, termId, offset, data });
    const view = this.view(termId);
    if (kind === 'snapshot') {
      view.applySnapshot(offset, data);
      return;
    }
    view.applyOutput(offset, data);
    if (this.autoAck && view.position - view.acked >= ACK_EVERY) {
      view.acked = view.position;
      this.send({ t: 'ack', termId, offset: view.position });
    }
  }
}

/** The screen a terminal shows after `data`, at the given size. */
export const replay = async (cols: number, rows: number, ...data: Uint8Array[]): Promise<ScreenState> => {
  const screen = new Screen(cols, rows);
  for (const chunk of data) screen.write(chunk);
  return screen.state();
};
