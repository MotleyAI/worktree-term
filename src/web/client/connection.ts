import { batch } from '@preact/signals';
import {
  decodeMessage,
  decodeWsData,
  encodeMessage,
  encodeWsData,
  MAX_INPUT,
  PROTOCOL_VERSION,
  ProtocolError,
  type DataFrame,
  type HostEntry,
  type MessageOf,
} from '../../protocol/index.js';
import { reconnectDelay } from './backoff.js';
import { hostKey, TerminalMemory, type TerminalStorage } from './memory.js';
import { PendingRequests } from './requests.js';
import { checkBundle } from './stale.js';
import { HubStore } from './store.js';

type HubMessage = MessageOf<'hubToBrowser'>;
type BrowserMessage = MessageOf<'browserToHub'>;
type ErrorCode = Extract<HubMessage, { t: 'error' }>['code'];
export type DaemonEvent = Extract<HubMessage, { t: 'host' }>['m'];
type DaemonMessage = Extract<BrowserMessage, { t: 'host' }>['m'];
type Unnumbered<T> = T extends unknown ? Omit<T, 'req'> : never;
/** A daemon request without its `req`, which the client assigns. */
export type DaemonRequestBody = Unnumbered<Extract<DaemonMessage, { req: number }>>;
/** A daemon message sent without a reply. */
export type DaemonNotice = Exclude<DaemonMessage, { req: number }>;
/** A successful reply to a daemon request. */
export type DaemonReply = Extract<DaemonEvent, { t: 'done' | 'termCreated' | 'reposDiscovered' }>;

type Reply =
  { ok: true; m: DaemonReply | Extract<HubMessage, { t: 'done' | 'reposDiscovered' }> } | { ok: false; code: ErrorCode; message: string };

/** A request the daemon or the hub answered with an error. */
export class RequestError extends Error {
  override readonly name = 'RequestError';

  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

interface Credential {
  kind: 'token' | 'code';
  secret: string;
}

const TOKEN_KEY = 'wtd.token';
const RELOADED_KEY = 'wtd.reloadedFor';
const CODE_FRAGMENT = /^#code=([0-9a-f]{64})$/;
const SECRET = /^[0-9a-f]{64}$/;

const randomInstance = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return btoa(String.fromCodePoint(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_');
};

/** The page's `localStorage`, or null when the browser refuses it. */
const localStorageOrNull = (): TerminalStorage | null => {
  try {
    return localStorage;
  } catch (error) {
    console.warn('local storage is unavailable', error);
    return null;
  }
};

/** Whether the hub answers HTTP at all, as opposed to being down or starting. */
const hubAnswers = async (): Promise<boolean> => {
  try {
    return (await fetch('/', { method: 'HEAD', cache: 'no-store' })).ok;
  } catch (error) {
    if (error instanceof TypeError) return false;
    throw error;
  }
};

/** The page's one WebSocket session with the hub: authentication, reconnects, requests and dispatch. */
export class HubClient {
  readonly store = new HubStore();
  /** The running terminals last seen per host and daemon instance, for confirmations. */
  readonly memory = new TerminalMemory(localStorageOrNull());
  private readonly pending = new PendingRequests<Reply>();
  private readonly dataListeners = new Set<(host: number, frame: DataFrame) => void>();
  private readonly eventListeners = new Set<(host: number, m: DaemonEvent) => void>();
  private readonly connectedListeners = new Set<(host: number, instance: string, repos: readonly string[]) => void>();
  private readonly instance = randomInstance();
  private readonly encoder = new TextEncoder();
  private credential: Credential | null = null;
  private ws: WebSocket | null = null;
  /** Each host's status, instance and repos in the current session. */
  private hostStates = new Map<number, { status: HostEntry['status']; instance: string | null; repos: readonly string[] }>();
  private attempts = 0;
  /** A failed upgrade while the hub answered HTTP; a second one means our credential is refused. */
  private refusedOnce = false;
  private stopped = false;
  /** A stale bundle waiting for the token before it reloads. */
  private reloadOnToken = false;

  constructor(private readonly version: string) {}

  /** Takes the one-time code from the address or the stored token, and connects. */
  start(): void {
    const code = CODE_FRAGMENT.exec(location.hash)?.[1];
    if (location.hash !== '') history.replaceState(null, '', `${location.pathname}${location.search}`);
    const token = sessionStorage.getItem(TOKEN_KEY);
    if (code !== undefined) this.credential = { kind: 'code', secret: code };
    else if (token !== null && SECRET.test(token)) this.credential = { kind: 'token', secret: token };
    if (this.credential === null) {
      this.stop('auth');
      return;
    }
    this.connect();
  }

  onData(listener: (host: number, frame: DataFrame) => void): void {
    this.dataListeners.add(listener);
  }

  onEvent(listener: (host: number, m: DaemonEvent) => void): void {
    this.eventListeners.add(listener);
  }

  /** Called whenever a host becomes connected to a daemon instance. */
  onHostConnected(listener: (host: number, instance: string, repos: readonly string[]) => void): void {
    this.connectedListeners.add(listener);
  }

  /** Sends a daemon request to `host`; resolves with its reply, rejects with RequestError or when it cannot complete. */
  async request(host: number, body: DaemonRequestBody): Promise<DaemonReply> {
    const m = await this.exchange(host, (req) => ({ t: 'host', host, m: { ...body, req } }));
    if ('host' in m) throw new Error(`unexpected hub reply ${m.t}`);
    return m;
  }

  /** Asks the hub to restart the daemon of `host`. */
  async restartDaemon(host: number): Promise<void> {
    await this.exchange(null, (req) => ({ t: 'restartDaemon', req, host }));
  }

  /** Asks the hub to install its bundle on remote `host` and restart its daemon. */
  async reinstallDaemon(host: number): Promise<void> {
    await this.exchange(null, (req) => ({ t: 'reinstallDaemon', req, host }));
  }

  /** The repos the hub discovers on `host` below its configured roots. */
  async discoverRepos(host: number): Promise<readonly string[]> {
    const m = await this.exchange(null, (req) => ({ t: 'discoverRepos', req, host }));
    if (m.t !== 'reposDiscovered') throw new Error(`unexpected hub reply ${m.t}`);
    return m.repos;
  }

  /** Asks the hub to add `repo` to `host`'s configured repos. */
  async addRepo(host: number, repo: string): Promise<void> {
    await this.exchange(null, (req) => ({ t: 'addRepo', req, host, repo }));
  }

  /** Asks the hub to remove `repo` from `host`'s configured repos. */
  async removeRepo(host: number, repo: string): Promise<void> {
    await this.exchange(null, (req) => ({ t: 'removeRepo', req, host, repo }));
  }

  private async exchange(host: number | null, message: (req: number) => BrowserMessage): Promise<Extract<Reply, { ok: true }>['m']> {
    if (this.ws?.readyState !== WebSocket.OPEN) throw new Error('not connected to the hub');
    const { req, reply } = this.pending.add(host);
    this.sendMessage(message(req));
    const result = await reply;
    if (!result.ok) throw new RequestError(result.code, result.message);
    return result.m;
  }

  /** Sends a daemon message that has no reply; dropped while disconnected. */
  notify(host: number, m: DaemonNotice): void {
    this.sendMessage({ t: 'host', host, m });
  }

  /** Sends terminal input, split into frames of at most MAX_INPUT bytes. */
  input(host: number, termId: number, data: string | Uint8Array): void {
    const ws = this.ws;
    if (ws?.readyState !== WebSocket.OPEN) return;
    const bytes = typeof data === 'string' ? this.encoder.encode(data) : data;
    for (let at = 0; at < bytes.length; at += MAX_INPUT) {
      ws.send(encodeWsData(host, { kind: 'input', termId, data: bytes.subarray(at, at + MAX_INPUT) }));
    }
  }

  private sendMessage(message: BrowserMessage): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(encodeMessage('browserToHub', message));
    return true;
  }

  private connect(): void {
    const credential = this.credential;
    if (credential === null || this.stopped) return;
    const ws = new WebSocket(`ws://${location.host}/ws`, ['wtd', `wtd.${credential.kind}.${credential.secret}`]);
    ws.binaryType = 'arraybuffer';
    let opened = false;
    ws.onopen = () => {
      opened = true;
      this.refusedOnce = false;
    };
    ws.onmessage = (event: MessageEvent) => {
      this.receive(ws, event.data);
    };
    ws.onclose = () => {
      if (this.ws === ws) void this.closed(credential, opened);
    };
    this.ws = ws;
  }

  private async closed(credential: Credential, opened: boolean): Promise<void> {
    this.ws = null;
    this.hostStates = new Map();
    this.store.sessionClosed();
    this.pending.failAll('the connection to the hub closed');
    if (this.stopped) return;
    this.store.status.value = 'reconnecting';
    if (!opened) {
      const answers = await hubAnswers();
      if (answers && (this.refusedOnce || credential.kind === 'code')) {
        this.refused(credential);
        return;
      }
      this.refusedOnce = answers;
    }
    this.attempts++;
    setTimeout(
      () => {
        this.connect();
      },
      this.refusedOnce ? 0 : reconnectDelay(this.attempts),
    );
  }

  /** The hub refused our credential: forget a stored token and ask the user to run `wtd ui`. */
  private refused(credential: Credential): void {
    if (credential.kind === 'token' && sessionStorage.getItem(TOKEN_KEY) === credential.secret) sessionStorage.removeItem(TOKEN_KEY);
    this.credential = null;
    this.stop('auth');
  }

  private reload(): void {
    this.stopped = true;
    this.ws?.close();
    location.reload();
  }

  private stop(status: 'auth' | 'outdated'): void {
    this.stopped = true;
    this.store.status.value = status;
    this.ws?.close();
  }

  private receive(ws: WebSocket, data: unknown): void {
    try {
      if (typeof data === 'string') this.message(decodeMessage('hubToBrowser', data));
      else if (data instanceof ArrayBuffer) this.data(new Uint8Array(data));
    } catch (error) {
      if (!(error instanceof ProtocolError)) throw error;
      console.error('malformed message from the hub', error);
      ws.close();
    }
  }

  private data(bytes: Uint8Array): void {
    const { host, frame } = decodeWsData(bytes);
    if (frame.kind === 'input') throw new ProtocolError('input frame from the hub');
    for (const listener of this.dataListeners) listener(host, frame);
  }

  private message(m: HubMessage): void {
    switch (m.t) {
      case 'hello':
        this.hello(m);
        return;
      case 'token':
        sessionStorage.setItem(TOKEN_KEY, m.token);
        this.credential = { kind: 'token', secret: m.token };
        if (this.reloadOnToken) this.reload();
        return;
      case 'hosts':
        this.hosts(m.hosts);
        return;
      case 'host':
        this.daemonEvent(m.host, m.m);
        return;
      case 'done':
      case 'reposDiscovered':
        this.pending.resolve(m.req, { ok: true, m });
        return;
      case 'error':
        if (m.req === null || !this.pending.resolve(m.req, { ok: false, code: m.code, message: m.message })) {
          this.store.notice.value = `${m.code}: ${m.message}`;
        }
        return;
      case 'presets':
        this.store.setPresets(m.presets);
        return;
    }
  }

  private hello(m: Extract<HubMessage, { t: 'hello' }>): void {
    const check = checkBundle({ protocol: PROTOCOL_VERSION, version: this.version }, m, sessionStorage.getItem(RELOADED_KEY));
    if (check === 'reload') {
      sessionStorage.setItem(RELOADED_KEY, m.instance);
      // A code session's token follows `hello`; the reloaded page needs it.
      if (this.credential?.kind === 'code') this.reloadOnToken = true;
      else this.reload();
      return;
    }
    if (check === 'outdated') {
      this.stop('outdated');
      return;
    }
    this.sendMessage({ t: 'hello', protocol: PROTOCOL_VERSION, version: this.version, instance: this.instance });
    this.store.status.value = 'open';
  }

  private hosts(hosts: readonly HostEntry[]): void {
    this.attempts = 0;
    const previous = this.hostStates;
    this.hostStates = new Map(hosts.map((h) => [h.idx, { status: h.status, instance: h.instance, repos: h.repos }]));
    const connected: HostEntry[] = [];
    const following: [HostEntry, readonly string[]][] = [];
    batch(() => {
      this.store.hosts.value = hosts;
      for (const host of hosts) {
        const before = previous.get(host.idx);
        const same = before?.status === 'connected' && host.status === 'connected' && before.instance === host.instance;
        if (before?.status === 'connected' && !same) this.pending.failHost(host.idx, `host ${String(host.idx)} is ${host.status}`);
        if (host.status === 'connected' && !same) connected.push(host);
        if (same) following.push([host, before.repos]);
      }
    });
    for (const [host, before] of following) this.followRepos(host.idx, before, host.repos);
    for (const host of connected) {
      if (host.instance === null) continue;
      const repos = [...host.repos, ...(this.store.kept.value.get(host.idx) ?? []).filter((r) => !host.repos.includes(r))];
      for (const listener of this.connectedListeners) listener(host.idx, host.instance, repos);
    }
  }

  /** The hub's repos of a connected host changed: watches added repos and lets go of removed ones. */
  private followRepos(host: number, before: readonly string[], after: readonly string[]): void {
    for (const repo of after) {
      if (before.includes(repo)) continue;
      this.store.keep(host, repo, false);
      void this.watch(host, repo);
    }
    for (const repo of before) {
      if (after.includes(repo)) continue;
      if (this.store.hasRunning(host, repo)) this.store.keep(host, repo, true);
      else this.letGo(host, repo);
    }
  }

  private async watch(host: number, repo: string): Promise<void> {
    try {
      await this.request(host, { t: 'watchRepo', repo });
    } catch (error) {
      if (error instanceof RequestError) this.store.repoError(host, repo, { code: error.code, message: error.message });
      else console.warn(`watching ${repo} failed`, error);
    }
  }

  /** Stops watching `repo` and forgets its state. */
  private letGo(host: number, repo: string): void {
    this.store.dropRepo(host, repo);
    this.request(host, { t: 'unwatchRepo', repo }).catch((error: unknown) => {
      console.warn(`unwatching ${repo} failed`, error);
    });
  }

  /** Lets go of kept repos of `host` without running terminals, and remembers its running terminals. */
  private terminalsChanged(host: number): void {
    for (const repo of this.store.kept.value.get(host) ?? []) {
      if (!this.store.hasRunning(host, repo)) this.letGo(host, repo);
    }
    const entry = this.store.hosts.value.find((h) => h.idx === host);
    if (entry?.status !== 'connected' || entry.instance === null) return;
    this.memory.remember(hostKey(entry), entry.instance, this.store.running(host), Date.now());
  }

  private daemonEvent(host: number, m: DaemonEvent): void {
    switch (m.t) {
      case 'done':
      case 'reposDiscovered':
        this.pending.resolve(m.req, { ok: true, m });
        break;
      case 'termCreated':
        this.store.apply(host, m);
        this.terminalsChanged(host);
        if (m.req !== null) this.pending.resolve(m.req, { ok: true, m });
        break;
      case 'error':
        if (m.req === null || !this.pending.resolve(m.req, { ok: false, code: m.code, message: m.message })) {
          console.warn(`host ${String(host)}: ${m.code}: ${m.message}`);
        }
        break;
      case 'repoState':
      case 'termExited':
      case 'termClosed':
        this.store.apply(host, m);
        this.terminalsChanged(host);
        break;
      case 'worktreesChanged':
      case 'detached':
      case 'activity':
      case 'checkedChanged':
      case 'layoutChanged':
        this.store.apply(host, m);
    }
    for (const listener of this.eventListeners) listener(host, m);
  }
}
