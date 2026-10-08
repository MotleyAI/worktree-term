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
  type Preset,
} from '../../protocol/index.js';
import { ConfigError, type ConfigSnapshot, type PresetEdit, type RepoEdit } from '../config/index.js';
import type { DaemonEndpoint, Link } from '../links/index.js';
import type { HostCoordinator } from './coordinator.js';
import { hostTransition, initialHostState, retryDelay, type HostEvent, type HostState } from './hosts.js';
import { OneShotError, requestOnce } from './oneshot.js';
import { controlFrame } from './restart.js';

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

/** One host of a session's configuration snapshot. */
export interface SessionHost {
  idx: number;
  name: string;
  /** The SSH alias of a remote host; null for the local host. */
  ssh: string | null;
  repos: string[];
  roots: string[];
}

/** What a session shares with the rest of the hub. */
export interface SessionContext {
  /** Our hello to a daemon. */
  hello: Extract<MessageOf<'clientToDaemon'>, { t: 'hello' }>;
  endpoint: (host: SessionHost) => DaemonEndpoint;
  /** The coordinator of the host's restarts and reinstalls, shared by every session. */
  coordinator: (host: SessionHost) => HostCoordinator;
  /** Whether the configuration lists `repo` for `host`. */
  listsRepo: (host: SessionHost, repo: string) => Promise<boolean>;
  /** Adds or removes a repo of `host` in the configuration. */
  editRepos: (host: SessionHost, change: 'add' | 'remove', repo: string) => Promise<RepoEdit>;
  /** Shows the host's repos after an edit to every session listing it. */
  reposEdited: (host: SessionHost, repos: string[]) => void;
  /** Adds or removes a preset in the configuration. */
  editPresets: (
    edit: { t: 'add'; preset: Preset } | { t: 'remove'; name: string } | { t: 'move'; name: string; to: number },
  ) => Promise<PresetEdit>;
  /** Shows the presets after an edit to every session. */
  presetsEdited: (presets: Preset[]) => void;
}

/** Depth of hub-level repo discovery. */
const DISCOVERY_DEPTH = 3;
/** Request id of the hub's one-shot requests, each on a link of its own. */
const ONE_SHOT_REQ = 1;

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
    readonly host: SessionHost,
    private readonly session: Session,
    readonly daemon: DaemonEndpoint,
    private readonly hello: SessionContext['hello'],
  ) {}

  get idx(): number {
    return this.host.idx;
  }

  connect(): void {
    if (this.closed) return;
    this.retry = null;
    let greeted = false;
    const link = this.daemon.open({
      frame: (frame) => {
        if (this.link !== link) return;
        if (!greeted) {
          greeted = true;
          this.greet(frame);
        } else if (this.state.status === 'connected') this.relay(frame);
      },
      ended: (error) => {
        if (this.link === link) this.lost(error?.message ?? 'the link to the daemon ended');
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
      this.fail('the daemon did not greet');
      return;
    }
    this.link?.send(controlFrame(this.hello));
    this.transition({ kind: 'hello', protocol: hello.protocol, version: hello.version, instance: hello.instance });
  }

  private relay(frame: Frame): void {
    if (frame.kind === FrameKind.control) {
      const message = this.decode(frame);
      if (message === null || message.t === 'hello') {
        this.fail('the daemon sent an invalid message');
        return;
      }
      this.session.forwardText(this.idx, utf8.decode(frame.payload));
      return;
    }
    if (frame.kind === FrameKind.input || !this.validData(frame)) {
      this.fail('the daemon sent an invalid data frame');
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
  private fail(reason: string): void {
    this.link?.close();
    this.lost(reason);
  }

  private lost(reason: string): void {
    this.link = null;
    if (this.closed) return;
    this.transition({ kind: 'failed', reason });
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
    hosts: readonly SessionHost[],
  ) {
    this.hosts = hosts.map((host) => new HostLink(host, this, context.endpoint(host), context.hello));
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
      case 'reinstallDaemon':
        this.reinstall(message.req, message.host);
        return;
      case 'discoverRepos':
        this.discover(message.req, message.host);
        return;
      case 'addRepo':
        this.addRepo(message.req, message.host, message.repo);
        return;
      case 'removeRepo':
        this.removeRepo(message.req, message.host, message.repo);
        return;
      case 'addPreset':
        this.editPresets(message.req, { t: 'add', preset: message.preset });
        return;
      case 'removePreset':
        this.editPresets(message.req, { t: 'remove', name: message.name });
        return;
      case 'movePreset':
        this.editPresets(message.req, { t: 'move', name: message.name, to: message.to });
        return;
    }
  }

  /** Sends presets changed by an edit. */
  showPresets(presets: Preset[]): void {
    if (!this.closed) this.message({ t: 'presets', presets });
  }

  /** Replaces the repos of the session's matching host after an edit and sends `hosts`. */
  showRepos(host: SessionHost, repos: string[]): void {
    const target = this.hosts.find((h) => (host.ssh === null ? h.host.ssh === null : h.host.ssh !== null && h.host.name === host.name));
    if (target === undefined || this.closed) return;
    target.host.repos = repos;
    this.hostsChanged();
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
    const hosts: HostEntry[] = this.hosts.map(({ host, state }) => ({
      idx: host.idx,
      name: host.name,
      remote: host.ssh !== null,
      status: state.status,
      reason: state.reason,
      daemonVersion: state.daemonVersion,
      instance: state.instance,
      repos: host.repos,
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

  /** The connected host `idx`, or null after answering as routing does. */
  private connectedHost(req: number, idx: number): HostLink | null {
    const host = this.hosts[idx];
    if (host === undefined) {
      this.error(req, idx, 'unknown-host', `no host ${String(idx)}`);
      return null;
    }
    const { status } = host.state;
    if (status === 'connected') return host;
    this.error(req, idx, status === 'outdated' ? 'version-mismatch' : 'host-unavailable', `host ${String(idx)} is ${status}`);
    return null;
  }

  private restart(req: number, idx: number): void {
    const host = this.hosts[idx];
    if (host === undefined) {
      this.error(req, idx, 'unknown-host', `no host ${String(idx)}`);
      return;
    }
    const reinstall = this.context.coordinator(host.host).reinstalling();
    if (reinstall !== null) {
      this.reply(req, idx, reinstall);
      return;
    }
    const { status } = host.state;
    if (status !== 'connected' && status !== 'outdated') {
      this.error(req, idx, 'host-unavailable', `host ${String(idx)} is ${status}`);
      return;
    }
    this.reply(req, idx, this.context.coordinator(host.host).restart());
  }

  private reinstall(req: number, idx: number): void {
    const host = this.hosts[idx];
    if (host === undefined) this.error(req, idx, 'unknown-host', `no host ${String(idx)}`);
    else if (host.host.ssh === null) this.error(req, idx, 'internal', 'the local daemon is restarted, not reinstalled');
    else this.reply(req, idx, this.context.coordinator(host.host).reinstall());
  }

  private discover(req: number, idx: number): void {
    const host = this.connectedHost(req, idx);
    if (host === null) return;
    const request = { t: 'discoverRepos', req: ONE_SHOT_REQ, roots: host.host.roots, depth: DISCOVERY_DEPTH } as const;
    this.oneShot(req, idx, async () => {
      const { reply } = await requestOnce(host.daemon, this.context.hello, request);
      if (reply.t !== 'reposDiscovered') throw new OneShotError('internal', `unexpected reply ${reply.t}`);
      this.message({ t: 'reposDiscovered', req, host: idx, repos: reply.repos });
    });
  }

  private addRepo(req: number, idx: number, repo: string): void {
    const host = this.connectedHost(req, idx);
    if (host === null) return;
    this.oneShot(req, idx, async () => {
      if (!(await this.context.listsRepo(host.host, repo))) {
        await requestOnce(host.daemon, this.context.hello, { t: 'watchRepo', req: ONE_SHOT_REQ, repo });
      }
      this.edited(req, host.host, await this.context.editRepos(host.host, 'add', repo));
    });
  }

  private removeRepo(req: number, idx: number, repo: string): void {
    const host = this.connectedHost(req, idx);
    if (host === null) return;
    this.oneShot(req, idx, async () => {
      try {
        const { before } = await requestOnce(host.daemon, this.context.hello, { t: 'watchRepo', req: ONE_SHOT_REQ, repo });
        const state = before.find((m) => m.t === 'repoState' && m.repo === repo);
        if (state?.t === 'repoState' && state.terminals.length > 0) {
          throw new OneShotError('busy', `${repo} has terminals; close them first`);
        }
      } catch (error) {
        if (!(error instanceof OneShotError) || error.code !== 'not-a-repo') throw error;
      }
      this.edited(req, host.host, await this.context.editRepos(host.host, 'remove', repo));
    });
  }

  /** Edits the presets, answering `done` and showing the result to every session, or `internal` naming the refusal. */
  private editPresets(req: number, edit: Parameters<SessionContext['editPresets']>[0]): void {
    this.context.editPresets(edit).then(
      (result) => {
        this.message({ t: 'done', req });
        if (result.changed) this.context.presetsEdited(result.presets);
      },
      (error: unknown) => {
        const text = error instanceof Error ? error.message : String(error);
        this.error(req, null, 'internal', error instanceof ConfigError ? `cannot edit the configuration: ${text}` : text);
      },
    );
  }

  /** Answers `done` for an edit, then shows its repos to every session listing the host. */
  private edited(req: number, host: SessionHost, edit: RepoEdit): void {
    this.message({ t: 'done', req });
    if (edit.changed) this.context.reposEdited(host, edit.repos);
  }

  /** Runs a hub-level request, answering its failure with the daemon's code or `internal`. */
  private oneShot(req: number, idx: number, run: () => Promise<void>): void {
    run().catch((error: unknown) => {
      if (error instanceof OneShotError) this.error(req, idx, error.code, error.message);
      else if (error instanceof ConfigError) this.error(req, idx, 'internal', `cannot edit the configuration: ${error.message}`);
      else this.error(req, idx, 'internal', error instanceof Error ? error.message : String(error));
    });
  }

  /** Answers `done` when `operation` succeeds, else `internal` naming its failure. */
  private reply(req: number, idx: number, operation: Promise<void>): void {
    operation.then(
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
