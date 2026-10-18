import { DAEMON_PROTOCOL_VERSION, encodeRemoteFragment, type DataFrame, type MessageOf } from '../../protocol/index.js';
import { ConfigEditor, ConfigSource, type ConfigSnapshot, type HubConfig } from '../config/index.js';
import {
  HubOpener,
  installOnRemote,
  LocalDaemon,
  RemoteDaemon,
  type DaemonEndpoint,
  type DaemonPaths,
  type HubOpenResult,
} from '../links/index.js';
import { HostCoordinator } from './coordinator.js';
import { hostKey, localHostName } from './hosts.js';
import { DaemonRestarter } from './restart.js';
import { HostGoneError, Session, type BrowserChannel, type HubOpenOutcome, type SessionContext, type SessionHost } from './session.js';

export { hubError, type BrowserChannel } from './session.js';

type BrowserMessage = MessageOf<'browserToHub'>;

export interface RouterOptions {
  /** Host files of the local daemon. */
  paths: DaemonPaths;
  /** Starts the local daemon when none serves its socket. */
  daemonCommand: readonly string[];
  /** The configuration file, `home` to expand `~/` with, and its content at start. */
  configPath: string;
  home: string;
  config: HubConfig;
  /** The hub's package version and instance, announced to daemons. */
  version: string;
  instance: string;
  /** This host's name as the OS reports it. */
  hostName: string;
  /** The running `wtd.mjs`, installed on remote hosts by `reinstallDaemon`. */
  bundle: string;
  /** Reports an unexpected failure. */
  report: (error: unknown) => void;
  /** Tunnel listeners to remote hubs. */
  tunnels: HubTunnels;
  /** A valid configuration was read; the latest one decides which tunnel connections are forwarded. */
  configRead: (config: HubConfig) => void;
  /** Time limits, shortened in tests; each defaults when undefined. */
  budgets?: { [K in keyof RouterBudgets]?: number | undefined };
}

export interface RouterBudgets {
  /** For `wtd ui --print-code` on a host without a login link. */
  openMs: number;
  /** For an installation, alone or within a reinstall. */
  installMs: number;
}

/** What a tunnel listener forwards to. */
export interface TunnelTarget {
  host: string;
  alias: string;
  port: number;
  remotePort: number;
}

/** The hub's listeners forwarding a loopback port per remote host to its hub. */
export interface HubTunnels {
  /** Makes the listener on `target.port` forward to `target`; rejects naming a port another process holds. */
  ensure: (target: TunnelTarget) => Promise<void>;
  /** Null when `GET /` through the listener on `port` answers 200 in time, else the failure; aborting ends it. */
  probe: (port: number, signal: AbortSignal) => Promise<string | null>;
}

/** A browser session as the server drives it. */
export interface RoutedSession {
  /** The browser's `hello` arrived: start once the configuration snapshot is read. */
  hello: () => void;
  receive: (message: Exclude<BrowserMessage, { t: 'hello' }>) => void;
  input: (host: number, frame: DataFrame) => void;
  drained: () => void;
  close: () => void;
}

const DEFAULT_BUDGETS: RouterBudgets = { openMs: 30_000, installMs: 120_000 };

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Routes every browser session to its own daemon links. */
export class Router {
  private readonly context: SessionContext;
  private readonly config: ConfigSource;
  private readonly editor: ConfigEditor;
  private readonly local: LocalDaemon;
  private readonly hello: SessionContext['hello'];
  private readonly sessions = new Set<Session>();
  private readonly coordinators = new Map<string, HostCoordinator>();
  private readonly budgets: RouterBudgets;

  constructor(private readonly options: RouterOptions) {
    this.budgets = {
      openMs: options.budgets?.openMs ?? DEFAULT_BUDGETS.openMs,
      installMs: options.budgets?.installMs ?? DEFAULT_BUDGETS.installMs,
    };
    this.hello = { t: 'hello', protocol: DAEMON_PROTOCOL_VERSION, version: options.version, instance: options.instance };
    this.local = new LocalDaemon(options.paths, options.daemonCommand);
    this.config = new ConfigSource(options.configPath, options.home, options.config);
    this.editor = new ConfigEditor(options.configPath, options.home);
    this.context = {
      hello: this.hello,
      endpoint: (host) => this.endpoint(host),
      coordinator: (host) => this.coordinator(host),
      listsRepo: (host, repo) => this.editor.lists(host.ssh === null ? null : host.name, repo),
      editRepos: (host, change, repo) => {
        const name = host.ssh === null ? null : host.name;
        return change === 'add' ? this.editor.addRepo(name, repo) : this.editor.removeRepo(name, repo);
      },
      reposEdited: (host, repos) => {
        for (const session of this.sessions) session.showRepos(host, repos);
      },
      editPresets: (edit) => {
        if (edit.t === 'add') return this.editor.addPreset(edit.preset);
        return edit.t === 'remove' ? this.editor.removePreset(edit.name) : this.editor.movePreset(edit.name, edit.to);
      },
      presetsEdited: (presets) => {
        for (const session of this.sessions) session.showPresets(presets);
      },
      greeted: (host, from) => {
        for (const session of this.sessions) if (session !== from) session.redialLogin(host);
      },
      openHub: (name, events) => this.openHub(name, events),
      installHub: async (name) => {
        const config = await this.readConfig();
        const host = config.hosts.find((h) => h.name === name);
        if (host === undefined) throw new HostGoneError(`host ${name} is no longer configured`);
        await this.coordinator({ idx: 0, name, ssh: host.ssh, repos: [], roots: [] }).install();
      },
    };
  }

  /** Reads the configuration, reporting a valid read; an invalid file gives the last valid one. */
  private async readConfig(): Promise<HubConfig> {
    return (await this.snapshot()).config;
  }

  private async snapshot(): Promise<ConfigSnapshot> {
    const read = await this.config.snapshot();
    if (read.problem === null) this.options.configRead(read.config);
    return read;
  }

  /** Opens the hub of the remote host `name`; a cancelled opening changes no listener and reports nothing. */
  private openHub(name: string, events: Parameters<SessionContext['openHub']>[1]): { cancel: () => void } {
    const controller = new AbortController();
    const { signal } = controller;
    const login = (url: string): void => {
      if (!signal.aborted) events.login(url);
    };
    this.openSteps(name, login, signal).then(
      (outcome) => {
        if (!signal.aborted) events.done(outcome);
      },
      (error: unknown) => {
        if (!signal.aborted) events.done({ kind: 'error', code: 'internal', message: messageOf(error) });
      },
    );
    return {
      cancel: () => {
        controller.abort();
      },
    };
  }

  private async openSteps(name: string, login: (url: string) => void, signal: AbortSignal): Promise<HubOpenOutcome> {
    const failed = (message: string): HubOpenOutcome => ({ kind: 'error', code: 'hub-failed', message });
    // Read through a call: the opening may end while any await is pending.
    const ended = (): boolean => signal.aborted;
    const config = await this.readConfig();
    const host = config.hosts.find((h) => h.name === name);
    if (host === undefined) return { kind: 'error', code: 'unknown-host', message: `host ${name} is no longer configured` };
    const printed = await this.printCode(host.ssh, login, signal);
    if (printed === null) return failed('cancelled');
    if (printed.kind === 'outdated') return { kind: 'error', code: 'hub-outdated', message: printed.message };
    if (printed.kind === 'failed') return failed(printed.message);
    let port = host.port;
    if (port === null) {
      try {
        port = (await this.editor.assignPort(name)).port;
      } catch (error) {
        return failed(messageOf(error));
      }
      await this.readConfig();
    }
    if (ended()) return failed('cancelled');
    try {
      await this.options.tunnels.ensure({ host: name, alias: host.ssh, port, remotePort: printed.port });
    } catch (error) {
      return failed(messageOf(error));
    }
    if (ended()) return failed('cancelled');
    const probe = await this.options.tunnels.probe(port, signal);
    if (probe !== null) return failed(probe);
    const fragment = encodeRemoteFragment({
      code: printed.code,
      host: name,
      home: this.options.config.port,
      hubs: config.hosts.map((h) => h.name),
    });
    return { kind: 'opened', url: `http://127.0.0.1:${String(port)}/#${fragment}` };
  }

  /** Runs `wtd ui --print-code` on `alias`; resolves null once `signal` aborts, killing the run. */
  private printCode(alias: string, login: (url: string) => void, signal: AbortSignal): Promise<HubOpenResult | null> {
    return new Promise((resolve) => {
      const run = new HubOpener(this.options.paths, alias, { timeoutMs: this.budgets.openMs }).open({ login, done: resolve });
      signal.addEventListener(
        'abort',
        () => {
          run.cancel();
          resolve(null);
        },
        { once: true },
      );
    });
  }

  /** The hosts of a session reading `config`: the local host, then the remote hosts in order. */
  private hostsOf(config: HubConfig): SessionHost[] {
    const local: SessionHost = {
      idx: 0,
      name: localHostName(this.options.hostName),
      ssh: null,
      repos: [...config.repos],
      roots: config.roots,
    };
    return [
      local,
      ...config.hosts.map((host, i) => ({ idx: i + 1, name: host.name, ssh: host.ssh, repos: [...host.repos], roots: host.roots })),
    ];
  }

  private endpoint(host: SessionHost): DaemonEndpoint {
    return host.ssh === null ? this.local : new RemoteDaemon(this.options.paths, host.ssh);
  }

  private coordinator(host: SessionHost): HostCoordinator {
    const key = hostKey(host);
    let coordinator = this.coordinators.get(key);
    if (coordinator === undefined) {
      const restarter = new DaemonRestarter(this.endpoint(host), this.hello);
      const alias = host.ssh;
      coordinator = new HostCoordinator({
        restart: () => restarter.restart(),
        reinstall: async () => {
          await this.install(alias);
          await restarter.replaceOther(this.options.version).catch((error: unknown) => {
            throw new Error(`restart: ${messageOf(error)}`, { cause: error });
          });
        },
        install: () => this.install(alias),
      });
      this.coordinators.set(key, coordinator);
    }
    return coordinator;
  }

  /** Installs the hub's bundle on `alias`. */
  private async install(alias: string | null): Promise<void> {
    if (alias === null) throw new Error('the local daemon is restarted, not reinstalled');
    const { paths, bundle, version } = this.options;
    await installOnRemote(paths, alias, bundle, version, this.budgets.installMs).catch((error: unknown) => {
      throw new Error(`install: ${messageOf(error)}`, { cause: error });
    });
  }

  /** Starts a session for `channel`, reading its configuration snapshot now. */
  open(channel: BrowserChannel): RoutedSession {
    let session: Session | null = null;
    let snapshot: ConfigSnapshot | null = null;
    let greeted = false;
    let closed = false;
    const pending: ((s: Session) => void)[] = [];
    const start = (): void => {
      if (closed || snapshot === null || !greeted || session !== null) return;
      const started = new Session(channel, this.context, snapshot, this.hostsOf(snapshot.config));
      session = started;
      this.sessions.add(started);
      started.start();
      for (const action of pending.splice(0)) action(started);
    };
    const run = (action: (s: Session) => void): void => {
      if (session === null) pending.push(action);
      else action(session);
    };
    this.snapshot().then(
      (read) => {
        snapshot = read;
        start();
      },
      (error: unknown) => {
        this.options.report(error);
      },
    );
    return {
      hello: () => {
        greeted = true;
        start();
      },
      receive: (message) => {
        run((s) => {
          s.receive(message);
        });
      },
      input: (host, frame) => {
        run((s) => {
          s.input(host, frame);
        });
      },
      drained: () => session?.drained(),
      close: () => {
        closed = true;
        pending.length = 0;
        if (session !== null) {
          this.sessions.delete(session);
          session.close();
        }
      },
    };
  }
}
