import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Duplex } from 'node:stream';
import { parseArgs } from 'node:util';
import pkg from '../../package.json' with { type: 'json' };
import { AlreadyRunningError, runDaemon } from '../daemon/main/index.js';
import { HubAlreadyRunningError, openUi, runHub } from '../hub/main/index.js';
import { dial } from '../platform/dialer/index.js';
import { currentHostPaths } from '../platform/files/index.js';
import { installLocal, installRemote } from '../platform/install/index.js';
import { PROTOCOL_VERSION } from '../protocol/index.js';

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const USAGE = `Usage: wtd <command> [options]

Commands:
  ui                      Start the hub and open the UI in Chrome
  hub                     Run the hub in the foreground
  daemon                  Run this host's daemon in the foreground
  connect                 Bridge stdio to this host's daemon, starting it if needed
  install-local [--systemd]
                          Install wtd for the current user, with a desktop launcher;
                          --systemd also installs and starts a systemd user unit for the daemon
  install-remote <alias> [--node <path>]
                          Install wtd on an SSH host; --node names the remote Node to use

Options:
  --help     Show this help
  --version  Show the version
`;

const OPTIONS = {
  help: { type: 'boolean' },
  version: { type: 'boolean' },
  systemd: { type: 'boolean' },
  node: { type: 'string' },
} as const;

/** Options a command was given. */
interface CommandOptions {
  systemd: boolean;
  node: string | null;
}

interface Command {
  /** Positional arguments after the verb. */
  args: readonly string[];
  /** Options the command takes besides `--help` and `--version`. */
  options: readonly (keyof CommandOptions)[];
  /** Runs the command and resolves with its exit code. */
  run: (io: CliIo, args: readonly string[], options: CommandOptions) => Promise<number>;
}

const message = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/\s+/g, (run) => (run.includes('\n') ? ' ' : run));

/** The command that runs this `wtd`, without a verb. */
const wtdCommand = (): string[] => {
  const script = process.argv[1];
  if (script === undefined) throw new Error('cannot tell how this wtd was started');
  return [process.execPath, script];
};

const hub = async (io: CliIo): Promise<number> => {
  try {
    const wtd = wtdCommand();
    await runHub({ version: pkg.version, paths: currentHostPaths(), wtd, webDir: join(dirname(wtd[1] ?? ''), 'web'), home: homedir() });
    return 0;
  } catch (error) {
    io.stderr(`wtd hub: ${error instanceof HubAlreadyRunningError ? 'already running' : message(error)}\n`);
    return 1;
  }
};

const ui = async (io: CliIo): Promise<number> => {
  try {
    const browser = process.env['WTD_BROWSER'] ?? 'google-chrome';
    await openUi({ version: pkg.version, paths: currentHostPaths(), wtd: wtdCommand(), home: homedir(), browser });
    return 0;
  } catch (error) {
    io.stderr(`wtd ui: ${message(error)}\n`);
    return 1;
  }
};

const daemon = async (io: CliIo): Promise<number> => {
  try {
    await runDaemon({ version: pkg.version, paths: currentHostPaths(), env: process.env });
    return 0;
  } catch (error) {
    io.stderr(`wtd daemon: ${error instanceof AlreadyRunningError ? 'already running' : message(error)}\n`);
    return 1;
  }
};

/** Whether a socket error only means the daemon closed the connection. */
const isPeerGone = (error: Error): boolean => 'code' in error && (error.code === 'ECONNRESET' || error.code === 'EPIPE');

/** Relays stdin to `socket` and `socket` to stdout until the socket closes; resolves with any failure. */
const bridge = (socket: Duplex): Promise<Error | null> =>
  new Promise((resolve) => {
    let failure: Error | null = null;
    socket.on('error', (error) => {
      if (!isPeerGone(error)) failure = error;
    });
    socket.once('close', () => {
      process.stdin.unpipe(socket);
      process.stdin.destroy();
      process.stdout.write('', () => {
        resolve(failure);
      });
    });
    socket.pipe(process.stdout, { end: false });
    process.stdin.pipe(socket);
  });

const connect = async (io: CliIo): Promise<number> => {
  let failure: Error | null;
  try {
    failure = await bridge(await dial(currentHostPaths(), [...wtdCommand(), 'daemon']));
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  }
  if (failure === null) return 0;
  io.stderr(`wtd connect: ${failure.message}\n`);
  return 1;
};

const installLocalCommand = async (io: CliIo, _args: readonly string[], { systemd }: CommandOptions): Promise<number> => {
  try {
    const bundle = wtdCommand()[1] ?? '';
    const installed = await installLocal({
      home: homedir(),
      paths: currentHostPaths(),
      bundle,
      version: pkg.version,
      node: process.execPath,
      systemd,
    });
    io.stdout(`installed wtd ${installed.version} in ${installed.dataDir} (release ${installed.release})\n`);
    return 0;
  } catch (error) {
    io.stderr(`wtd install-local: ${message(error)}\n`);
    return 1;
  }
};

/** How long `wtd install-remote` waits for the remote installer. */
const REMOTE_INSTALL_MS = 10 * 60 * 1000;

const installRemoteCommand = async (io: CliIo, [alias = '']: readonly string[], { node }: CommandOptions): Promise<number> => {
  try {
    const bundle = wtdCommand()[1] ?? '';
    const paths = currentHostPaths();
    const installed = await installRemote({ paths, alias, bundle, version: pkg.version, node, timeoutMs: REMOTE_INSTALL_MS });
    io.stdout(`installed wtd ${installed.version} on ${alias} (release ${installed.release}, Node ${installed.node})\n`);
    return 0;
  } catch (error) {
    io.stderr(`wtd install-remote: ${message(error)}\n`);
    return 1;
  }
};

const COMMANDS: ReadonlyMap<string, Command> = new Map<string, Command>([
  ['ui', { args: [], options: [], run: ui }],
  ['hub', { args: [], options: [], run: hub }],
  ['daemon', { args: [], options: [], run: daemon }],
  ['connect', { args: [], options: [], run: connect }],
  ['install-local', { args: [], options: ['systemd'], run: installLocalCommand }],
  ['install-remote', { args: ['alias'], options: ['node'], run: installRemoteCommand }],
]);

class UsageError extends Error {
  override readonly name = 'UsageError';
}

interface Invocation {
  help: boolean;
  version: boolean;
  positionals: string[];
  options: CommandOptions;
  /** Command options given, by their written name, to check against the command. */
  given: { name: keyof CommandOptions; rawName: string }[];
}

const isCommandOption = (name: string): name is keyof CommandOptions => name === 'systemd' || name === 'node';

const parse = (argv: readonly string[]): Invocation => {
  const { tokens, positionals } = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: false, tokens: true });
  const invocation: Invocation = { help: false, version: false, positionals, options: { systemd: false, node: null }, given: [] };
  for (const token of tokens) {
    if (token.kind !== 'option') continue;
    if (token.name === 'node') {
      if (token.value === undefined) throw new UsageError(`option ${token.rawName} needs a value`);
      invocation.options.node = token.value;
    } else if (token.value !== undefined) throw new UsageError(`option ${token.rawName} takes no value`);
    if (token.name === 'help') invocation.help = true;
    else if (token.name === 'version') invocation.version = true;
    else if (token.name === 'systemd') invocation.options.systemd = true;
    else if (!isCommandOption(token.name)) throw new UsageError(`unknown option ${token.rawName}`);
    if (isCommandOption(token.name)) invocation.given.push({ name: token.name, rawName: token.rawName });
  }
  return invocation;
};

const dispatch = async (argv: readonly string[], io: CliIo): Promise<number> => {
  const { help, version, positionals, options, given } = parse(argv);
  if (help) {
    io.stdout(USAGE);
    return 0;
  }
  if (version) {
    io.stdout(`wtd ${pkg.version} (protocol ${String(PROTOCOL_VERSION)})\n`);
    return 0;
  }
  const [verb, ...args] = positionals;
  if (verb === undefined) throw new UsageError('missing command');
  const command = COMMANDS.get(verb);
  if (command === undefined) throw new UsageError(`unknown command '${verb}'`);
  const foreign = given.find((option) => !command.options.includes(option.name));
  if (foreign !== undefined) throw new UsageError(`${verb} takes no option ${foreign.rawName}`);
  const missing = command.args[args.length];
  if (missing !== undefined) throw new UsageError(`${verb}: ${missing} is required`);
  const extra = args[command.args.length];
  if (extra !== undefined) throw new UsageError(`${verb}: unexpected argument '${extra}'`);
  return command.run(io, args, options);
};

/** Runs `wtd` with `argv` (without node and script) and returns the exit code. */
export const runCli = async (argv: readonly string[], io: CliIo): Promise<number> => {
  try {
    return await dispatch(argv, io);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.stderr(`wtd: ${error.message}\n\n${USAGE}`);
    return 2;
  }
};
