import { parseArgs } from 'node:util';
import pkg from '../../package.json' with { type: 'json' };
import { placeholder as runDaemon } from '../daemon/main/index.js';
import { placeholder as runHub } from '../hub/main/index.js';
import { placeholder as dial } from '../platform/dialer/index.js';
import { placeholder as installFiles } from '../platform/files/index.js';
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
  run: (args: readonly string[]) => Promise<void>;
}

/** Adapts a synchronous placeholder entry to a command. */
const placeholderRun = (entry: () => void) => (): Promise<void> => {
  entry();
  return Promise.resolve();
};

// `daemon` and `connect` are implemented by DEV-2051, `ui` and `hub` by DEV-2052, the installers by DEV-2054.
const COMMANDS: Readonly<Record<string, Command>> = {
  ui: { args: [], run: placeholderRun(runHub) },
  hub: { args: [], run: placeholderRun(runHub) },
  daemon: { args: [], run: placeholderRun(runDaemon) },
  connect: { args: [], run: placeholderRun(dial) },
  'install-local': { args: [], run: placeholderRun(installFiles) },
  'install-remote': { args: ['alias'], run: placeholderRun(installFiles) },
};

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
  const command = COMMANDS[verb];
  if (command === undefined) throw new UsageError(`unknown command '${verb}'`);
  const missing = command.args[args.length];
  if (missing !== undefined) throw new UsageError(`${verb}: ${missing} is required`);
  const extra = args[command.args.length];
  if (extra !== undefined) throw new UsageError(`${verb}: unexpected argument '${extra}'`);
  try {
    await command.run(args);
  } catch (error) {
    if (error instanceof Error && error.message === NOT_IMPLEMENTED) {
      io.stderr(`wtd ${verb}: ${NOT_IMPLEMENTED}\n`);
      return 2;
    }
    throw error;
  }
  return 0;
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
