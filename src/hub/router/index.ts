import { PROTOCOL_VERSION, type DataFrame, type MessageOf } from '../../protocol/index.js';
import { ConfigSource, type ConfigSnapshot, type HubConfig } from '../config/index.js';
import { LocalDaemon, type DaemonPaths } from '../links/index.js';
import { localHostName } from './hosts.js';
import { DaemonRestarter } from './restart.js';
import { Session, type BrowserChannel, type SessionContext } from './session.js';

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

/** Routes every browser session to its own daemon links. */
export class Router {
  private readonly context: SessionContext;
  private readonly config: ConfigSource;

  constructor(private readonly options: RouterOptions) {
    const hello = { t: 'hello', protocol: PROTOCOL_VERSION, version: options.version, instance: options.instance } as const;
    const daemon = new LocalDaemon(options.paths, options.daemonCommand);
    this.config = new ConfigSource(options.configPath, options.home, options.config);
    this.context = {
      daemon,
      restarter: new DaemonRestarter(daemon, hello),
      hello,
      hostName: localHostName(options.hostName),
    };
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
      const started = new Session(channel, this.context, snapshot);
      session = started;
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
        session?.close();
      },
    };
  }
}
