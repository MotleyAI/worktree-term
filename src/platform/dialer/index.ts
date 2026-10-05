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

/** Starts `command` detached in its own session, its output appended to the daemon log. */
const startDaemon = async (paths: HostPaths, command: readonly string[]): Promise<{ failure: () => Error | null }> => {
  const [file, ...args] = command;
  if (file === undefined) throw new Error('empty daemon command');
  await preparePrivateDirs(paths);
  const log = await openLog(paths.log);
  let failure: Error | null = null;
  try {
    const child = spawn(file, args, { detached: true, stdio: ['ignore', log.fd, log.fd] });
    child.once('error', (error) => {
      failure = error;
    });
    child.unref();
  } finally {
    await log.close();
  }
  return { failure: () => failure };
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Connects to this host's daemon, starting `command` first when no daemon serves the socket. */
export const dial = async (paths: HostPaths, command: readonly string[]): Promise<Socket> => {
  try {
    return await tryConnect(paths.socket);
  } catch (error) {
    if (!isAbsent(error)) throw error;
  }
  const started = await startDaemon(paths, command);
  const deadline = Date.now() + START_WAIT_MS;
  for (;;) {
    await sleep(RETRY_MS);
    try {
      return await tryConnect(paths.socket);
    } catch (error) {
      if (!isAbsent(error)) throw error;
      if (Date.now() >= deadline) {
        const spawnFailure = started.failure();
        const detail = spawnFailure === null ? '' : ` (${spawnFailure.message})`;
        throw new Error(`daemon did not start; see ${paths.log}${detail}`, { cause: error });
      }
    }
  }
};
