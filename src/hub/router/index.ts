import { DAEMON_PROTOCOL_VERSION, type DataFrame, type MessageOf } from '../../protocol/index.js';
import { ConfigEditor, ConfigSource, type ConfigSnapshot, type HubConfig } from '../config/index.js';
import { installOnRemote, LocalDaemon, RemoteDaemon, type DaemonEndpoint, type DaemonPaths } from '../links/index.js';
import { HostCoordinator } from './coordinator.js';
import { localHostName } from './hosts.js';
import { DaemonRestarter } from './restart.js';
import { Session, type BrowserChannel, type SessionContext, type SessionHost } from './session.js';

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

/** How long a reinstall's installation step may take. */
const INSTALL_MS = 120_000;

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

  constructor(private readonly options: RouterOptions) {
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
    };
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
    const key = host.ssh === null ? 'local' : `remote:${host.name}:${host.ssh}`;
    let coordinator = this.coordinators.get(key);
    if (coordinator === undefined) {
      const restarter = new DaemonRestarter(this.endpoint(host), this.hello);
      const alias = host.ssh;
      coordinator = new HostCoordinator({
        restart: () => restarter.restart(),
        reinstall: async () => {
          if (alias === null) throw new Error('the local daemon is restarted, not reinstalled');
          const { paths, bundle, version } = this.options;
          await installOnRemote(paths, alias, bundle, version, INSTALL_MS).catch((error: unknown) => {
            throw new Error(`install: ${messageOf(error)}`, { cause: error });
          });
          await restarter.replaceOther(version).catch((error: unknown) => {
            throw new Error(`restart: ${messageOf(error)}`, { cause: error });
          });
        },
      });
      this.coordinators.set(key, coordinator);
    }
    return coordinator;
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
    this.config.snapshot().then(
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
