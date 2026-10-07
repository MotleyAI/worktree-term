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
  install-local           Install wtd for the current user
  install-remote <alias>  Install wtd on an SSH host

Options:
  --help     Show this help
  --version  Show the version
`;

const OPTIONS = { help: { type: 'boolean' }, version: { type: 'boolean' } } as const;

const NOT_IMPLEMENTED = 'not implemented';

interface Command {
  /** Positional arguments after the verb. */
  args: readonly string[];
  /** Runs the command and resolves with its exit code. */
  run: (io: CliIo) => Promise<number>;
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

// The installers are implemented by DEV-2054.
const COMMANDS: ReadonlyMap<string, Command> = new Map([
  ['ui', { args: [], run: ui }],
  ['hub', { args: [], run: hub }],
  ['daemon', { args: [], run: daemon }],
  ['connect', { args: [], run: connect }],
  ['install-local', { args: [], run: installLocal }],
  ['install-remote', { args: ['alias'], run: installRemote }],
]);

class UsageError extends Error {
  override readonly name = 'UsageError';
}

interface Invocation {
  help: boolean;
  version: boolean;
  positionals: string[];
}

const parse = (argv: readonly string[]): Invocation => {
  const { tokens, positionals } = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: false, tokens: true });
  let help = false;
  let version = false;
  for (const token of tokens) {
    if (token.kind !== 'option') continue;
    if (token.name !== 'help' && token.name !== 'version') throw new UsageError(`unknown option ${token.rawName}`);
    if (token.value !== undefined) throw new UsageError(`option ${token.rawName} takes no value`);
    if (token.name === 'help') help = true;
    else version = true;
  }
  return { help, version, positionals };
};

const dispatch = async (argv: readonly string[], io: CliIo): Promise<number> => {
  const { help, version, positionals } = parse(argv);
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
  const missing = command.args[args.length];
  if (missing !== undefined) throw new UsageError(`${verb}: ${missing} is required`);
  const extra = args[command.args.length];
  if (extra !== undefined) throw new UsageError(`${verb}: unexpected argument '${extra}'`);
  try {
    return await command.run(io);
  } catch (error) {
    if (error instanceof Error && error.message === NOT_IMPLEMENTED) {
      io.stderr(`wtd ${verb}: ${NOT_IMPLEMENTED}\n`);
      return 2;
    }
    throw error;
  }
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
