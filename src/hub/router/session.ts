import {
  decodeMessage,
  decodeStreamData,
  encodeMessage,
  encodeStreamData,
  FrameKind,
  ProtocolError,
  type DataFrame,
  type Frame,
  type HostEntry,
  type MessageOf,
} from '../../protocol/index.js';
import type { ConfigSnapshot } from '../config/index.js';
import type { Link, LocalDaemon } from '../links/index.js';
import { hostTransition, initialHostState, retryDelay, type HostEvent, type HostState } from './hosts.js';
import { controlFrame, type DaemonRestarter } from './restart.js';

type BrowserMessage = MessageOf<'browserToHub'>;
type HubMessage = MessageOf<'hubToBrowser'>;
type ErrorCode = Extract<HubMessage, { t: 'error' }>['code'];
type DaemonRequest = Extract<BrowserMessage, { t: 'host' }>['m'];

/** Where a session's messages to the browser go. */
export interface BrowserChannel {
  send: (data: string | Uint8Array) => void;
  /** Bytes handed to `send` and not yet written to the network. */
  unsent: () => number;
}

/** What a session shares with the rest of the hub. */
export interface SessionContext {
  daemon: LocalDaemon;
  restarter: DaemonRestarter;
  /** Our hello to a daemon. */
  hello: Extract<MessageOf<'clientToDaemon'>, { t: 'hello' }>;
  hostName: string;
}

const KiB = 1024;
/** Unsent bytes at which the session's links stop being read. */
const PAUSE_AT = 1024 * KiB;
/** Unsent bytes below which they are read again. */
const RESUME_BELOW = 256 * KiB;
const MAX_ERROR_MESSAGE = 1024;
const WS_HEADER = 3;

/** A hub `error` message, its text cut to the protocol's limit. */
export const hubError = (req: number | null, host: number | null, code: ErrorCode, message: string): HubMessage => ({
  t: 'error',
  req,
  host,
  code,
  message: message.slice(0, MAX_ERROR_MESSAGE),
});

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** One host's daemon link of one session, with the host's status. */
class HostLink {
  state: HostState = initialHostState;
  private link: Link | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private paused = false;
  private closed = false;

  constructor(
    readonly idx: number,
    private readonly session: Session,
    private readonly context: SessionContext,
  ) {}

  connect(): void {
    if (this.closed) return;
    this.retry = null;
    let greeted = false;
    const link = this.context.daemon.open({
      frame: (frame) => {
        if (this.link !== link) return;
        if (!greeted) {
          greeted = true;
          this.greet(frame);
        } else if (this.state.status === 'connected') this.relay(frame);
      },
      ended: () => {
        if (this.link === link) this.lost();
      },
    });
    this.link = link;
    if (this.paused) link.pause();
  }

  send(bytes: Uint8Array): void {
    this.link?.send(bytes);
  }

  pause(): void {
    this.paused = true;
    this.link?.pause();
  }

  resume(): void {
    this.paused = false;
    this.link?.resume();
  }

  close(): void {
    this.closed = true;
    if (this.retry !== null) clearTimeout(this.retry);
    this.link?.close();
    this.link = null;
  }

  private greet(frame: Frame): void {
    const hello = this.decode(frame);
    if (hello?.t !== 'hello') {
      this.fail();
      return;
    }
    this.link?.send(controlFrame(this.context.hello));
    this.transition({ kind: 'hello', protocol: hello.protocol, version: hello.version, instance: hello.instance });
  }

  private relay(frame: Frame): void {
    if (frame.kind === FrameKind.control) {
      const message = this.decode(frame);
      if (message === null || message.t === 'hello') {
        this.fail();
        return;
      }
      this.session.forwardText(this.idx, utf8.decode(frame.payload));
      return;
    }
    if (frame.kind === FrameKind.input || !this.validData(frame)) {
      this.fail();
      return;
    }
    const message = new Uint8Array(WS_HEADER + frame.payload.length);
    message[0] = frame.kind;
    new DataView(message.buffer).setUint16(1, this.idx);
    message.set(frame.payload, WS_HEADER);
    this.session.forwardData(message);
  }

  private decode(frame: Frame): MessageOf<'daemonToClient'> | null {
    if (frame.kind !== FrameKind.control) return null;
    try {
      return decodeMessage('daemonToClient', frame.payload);
    } catch (error) {
      if (error instanceof ProtocolError) return null;
      throw error;
    }
  }

  private validData(frame: Frame): boolean {
    try {
      decodeStreamData(frame);
      return true;
    } catch (error) {
      if (error instanceof ProtocolError) return false;
      throw error;
    }
  }

  /** The daemon broke the protocol: drop the link and reconnect. */
  private fail(): void {
    this.link?.close();
    this.lost();
  }

  private lost(): void {
    this.link = null;
    if (this.closed) return;
    this.transition({ kind: 'failed' });
    this.retry = setTimeout(() => {
      this.connect();
    }, retryDelay(this.state.failures));
  }

  private transition(event: HostEvent): void {
    this.state = hostTransition(this.state, event);
    this.session.hostsChanged();
  }
}

/** One browser session: its configuration snapshot, its daemon links and its routing. */
export class Session {
  private readonly hosts: HostLink[];
  private paused = false;
  private closed = false;

  constructor(
    private readonly channel: BrowserChannel,
    private readonly context: SessionContext,
    private readonly snapshot: ConfigSnapshot,
  ) {
    this.hosts = [new HostLink(0, this, context)];
  }

  /** Sends the configuration problem, if any, the presets and the hosts, then connects every host. */
  start(): void {
    if (this.snapshot.problem !== null) this.error(null, null, 'internal', `invalid configuration: ${this.snapshot.problem}`);
    this.message({ t: 'presets', presets: this.snapshot.config.presets });
    this.hostsChanged();
    for (const host of this.hosts) host.connect();
  }

  /** Routes a browser message other than `hello`. */
  receive(message: Exclude<BrowserMessage, { t: 'hello' }>): void {
    if (this.closed) return;
    switch (message.t) {
      case 'host':
        this.route(message.host, message.m);
        return;
      case 'restartDaemon':
        this.restart(message.req, message.host);
        return;
      case 'addRepo':
      case 'removeRepo':
      case 'discoverRepos':
      case 'reinstallDaemon':
        this.error(message.req, message.host, 'internal', `${message.t} is not implemented`);
        return;
    }
  }

  /** Routes browser input for a terminal of `host`. */
  input(host: number, frame: DataFrame): void {
    if (this.closed) return;
    const target = this.hosts[host];
    if (target === undefined) {
      this.error(null, host, 'unknown-host', `no host ${String(host)}`);
      return;
    }
    if (target.state.status === 'connected') target.send(encodeStreamData(frame));
  }

  /** The channel wrote some of what it held. */
  drained(): void {
    if (this.paused && this.channel.unsent() < RESUME_BELOW) {
      this.paused = false;
      for (const host of this.hosts) host.resume();
    }
  }

  close(): void {
    this.closed = true;
    for (const host of this.hosts) host.close();
  }

  /** Sends a daemon message, given as its JSON text, inside a `host` envelope. */
  forwardText(host: number, text: string): void {
    this.send(`{"t":"host","host":${String(host)},"m":${text}}`);
  }

  /** Sends a binary WebSocket data message. */
  forwardData(message: Uint8Array): void {
    this.send(message);
  }

  hostsChanged(): void {
    const hosts: HostEntry[] = this.hosts.map((host) => ({
      idx: host.idx,
      name: this.context.hostName,
      remote: false,
      status: host.state.status,
      daemonVersion: host.state.daemonVersion,
      instance: host.state.instance,
      repos: this.snapshot.config.repos,
    }));
    this.message({ t: 'hosts', hosts });
  }

  private route(idx: number, m: DaemonRequest): void {
    const req = 'req' in m ? m.req : null;
    const host = this.hosts[idx];
    if (host === undefined) {
      this.error(req, idx, 'unknown-host', `no host ${String(idx)}`);
      return;
    }
    const { status } = host.state;
    if (status === 'connected') host.send(controlFrame(m));
    else if (req !== null) {
      this.error(req, idx, status === 'outdated' ? 'version-mismatch' : 'host-unavailable', `host ${String(idx)} is ${status}`);
    }
  }

  private restart(req: number, idx: number): void {
    const host = this.hosts[idx];
    if (host === undefined) {
      this.error(req, idx, 'unknown-host', `no host ${String(idx)}`);
      return;
    }
    const { status } = host.state;
    if (status !== 'connected' && status !== 'outdated') {
      this.error(req, idx, 'host-unavailable', `host ${String(idx)} is ${status}`);
      return;
    }
    this.context.restarter.restart().then(
      () => {
        this.message({ t: 'done', req });
      },
      (error: unknown) => {
        this.error(req, idx, 'internal', error instanceof Error ? error.message : String(error));
      },
    );
  }

  private error(req: number | null, host: number | null, code: ErrorCode, message: string): void {
    this.message(hubError(req, host, code, message));
  }

  private message(message: HubMessage): void {
    this.send(encodeMessage('hubToBrowser', message));
  }

  private send(data: string | Uint8Array): void {
    if (this.closed) return;
    this.channel.send(data);
    if (!this.paused && this.channel.unsent() >= PAUSE_AT) {
      this.paused = true;
      for (const host of this.hosts) host.pause();
    }
  }
}
