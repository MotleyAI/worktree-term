import { spawn, type ChildProcess } from 'node:child_process';
import { connect, type Socket } from 'node:net';
import { openLog, pathExists, preparePrivateDirs, sshControlPath, UNIT_NAME, type HostPaths } from '../files/index.js';

const RETRY_MS = 50;
const START_WAIT_MS = 5000;

const hasCode = (error: unknown, code: string): boolean => error instanceof Error && 'code' in error && error.code === code;

/** Whether connecting failed because no daemon serves the socket. */
const isAbsent = (error: unknown): boolean => hasCode(error, 'ENOENT') || hasCode(error, 'ECONNREFUSED');

const tryConnect = (path: string): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const socket = connect(path);
    const fail = (error: Error): void => {
      socket.destroy();
      reject(error);
    };
    socket.once('error', fail);
    socket.once('connect', () => {
      socket.off('error', fail);
      resolve(socket);
    });
  });

/**
 * Starts `command` in its own session with stdin from /dev/null and its output appended to `log`
 * (ignored when null); resolves once it has started, rejects naming a program that cannot start.
 */
export const spawnDetached = async (command: readonly string[], log: string | null): Promise<void> => {
  const [file, ...args] = command;
  if (file === undefined) throw new Error('empty command');
  const handle = log === null ? null : await openLog(log);
  try {
    const output = handle === null ? 'ignore' : handle.fd;
    const child = spawn(file, args, { detached: true, stdio: ['ignore', output, output] });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', (error) => {
        reject(new Error(`cannot start ${file}: ${error.message}`, { cause: error }));
      });
    });
    child.unref();
  } finally {
    await handle?.close();
  }
};

const nonEmpty = (value: string | undefined): string | undefined => (value === undefined || value === '' ? undefined : value);

/** The systemctl program: `$WTD_SYSTEMCTL` when set and non-empty, else `systemctl`. */
export const systemctlProgram = (): string => nonEmpty(process.env['WTD_SYSTEMCTL']) ?? 'systemctl';

/** Whether `command` ran and exited 0; its output is discarded. */
const succeeds = (command: readonly string[]): Promise<boolean> =>
  new Promise((resolve) => {
    const [file, ...args] = command;
    if (file === undefined) {
      resolve(false);
      return;
    }
    const child = spawn(file, args, { stdio: 'ignore' });
    child.once('error', () => {
      resolve(false);
    });
    child.once('exit', (code) => {
      resolve(code === 0);
    });
  });

/** Starts the daemon: through its systemd user unit when installed and that works, else `command` detached. */
const startDaemon = async (paths: HostPaths, command: readonly string[]): Promise<void> => {
  if ((await pathExists(paths.unitFile)) && (await succeeds([systemctlProgram(), '--user', 'start', UNIT_NAME]))) return;
  await spawnDetached(command, paths.log);
};

const SSH_OPTIONS = ['BatchMode=yes', 'ConnectTimeout=10', 'ControlMaster=auto', 'ControlPersist=10m'];
const MAX_ALIAS = 255;
// eslint-disable-next-line no-control-regex -- control characters are what aliases must not contain
const BAD_ALIAS_CHARACTER = /[\s\u0000-\u0008\u000e-\u001f\u007f]/;

/** Throws naming `alias` unless it is a usable SSH alias: 1–255 characters, no leading `-`, whitespace or control characters. */
export const checkSshAlias = (alias: string): void => {
  if (alias === '' || alias.length > MAX_ALIAS || alias.startsWith('-') || BAD_ALIAS_CHARACTER.test(alias)) {
    throw new Error(`invalid SSH alias '${alias}'`);
  }
};

/** The SSH command line running `remote` on `alias`, sharing a control master per host. */
export const sshCommand = (paths: Pick<HostPaths, 'runDir'>, alias: string, remote: string): string[] => {
  checkSshAlias(alias);
  const options = [...SSH_OPTIONS, `ControlPath=${sshControlPath(paths)}`, 'ServerAliveInterval=15'].flatMap((o) => ['-o', o]);
  return [nonEmpty(process.env['WTD_SSH']) ?? 'ssh', ...options, '--', alias, remote];
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The connected socket, or the error when no daemon serves `path`; other failures throw. */
const connectIfServed = async (path: string): Promise<Socket | Error> => {
  try {
    return await tryConnect(path);
  } catch (error) {
    if (error instanceof Error && isAbsent(error)) return error;
    throw error;
  }
};

/** Connects to this host's daemon, starting it first when no daemon serves the socket. */
export const dial = async (paths: HostPaths, command: readonly string[]): Promise<Socket> => {
  const running = await connectIfServed(paths.socket);
  if (!(running instanceof Error)) return running;
  await preparePrivateDirs(paths);
  try {
    await startDaemon(paths, command);
  } catch (error) {
    throw new Error(`daemon did not start; see ${paths.log} (${error instanceof Error ? error.message : String(error)})`, { cause: error });
  }
  const deadline = Date.now() + START_WAIT_MS;
  for (;;) {
    await sleep(RETRY_MS);
    const result = await connectIfServed(paths.socket); // NOSONAR(S9382) — retries until the daemon listens
    if (!(result instanceof Error)) return result;
    if (Date.now() >= deadline) {
      throw new Error(`daemon did not start; see ${paths.log}`, { cause: result });
    }
  }
};

/** Sends `child` SIGTERM, then SIGKILL if it is still running `graceMs` later. */
export const stopProcess = (child: ChildProcess, graceMs: number): void => {
  const running = (): boolean => child.exitCode === null && child.signalCode === null;
  if (!running()) return;
  child.kill('SIGTERM');
  setTimeout(() => {
    if (running()) child.kill('SIGKILL');
  }, graceMs).unref();
};

export { StderrTail } from './tail.js';
