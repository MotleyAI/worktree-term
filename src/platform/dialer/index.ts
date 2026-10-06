import { spawn } from 'node:child_process';
import { connect, type Socket } from 'node:net';
import { openLog, preparePrivateDirs, type HostPaths } from '../files/index.js';

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

/** Connects to this host's daemon, starting `command` first when no daemon serves the socket. */
export const dial = async (paths: HostPaths, command: readonly string[]): Promise<Socket> => {
  const running = await connectIfServed(paths.socket);
  if (!(running instanceof Error)) return running;
  await preparePrivateDirs(paths);
  try {
    await spawnDetached(command, paths.log);
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
