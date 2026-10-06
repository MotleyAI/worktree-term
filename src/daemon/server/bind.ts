import { randomBytes } from 'node:crypto';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import {
  acquireStartLock,
  fileIdentity,
  makeOwnerOnly,
  preparePrivateDirs,
  removeFile,
  renameFile,
  type HostPaths,
} from '../../platform/files/index.js';

/** A daemon already serves this host's socket. */
export class AlreadyRunningError extends Error {
  override readonly name = 'AlreadyRunningError';
}

/** The daemon's bound socket. */
export interface Listener {
  /** Hands connections, including any that arrived before, to `accept`. */
  serve: (accept: (socket: Socket) => void) => void;
  /** Stops listening and removes the socket file if it is still the one bound. */
  close: () => Promise<void>;
}

const hasCode = (error: unknown, code: string): boolean => error instanceof Error && 'code' in error && error.code === code;

/** Whether something accepts connections on `path`. */
const answers = (path: string): Promise<boolean> =>
  new Promise((resolve, reject) => {
    const socket = connect(path);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', (error) => {
      if (hasCode(error, 'ENOENT') || hasCode(error, 'ECONNREFUSED')) resolve(false);
      else reject(error);
    });
  });

const listen = (server: Server, path: string): Promise<void> =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.off('error', reject);
      resolve();
    });
  });

/**
 * Binds this host's socket owner-only while holding the start lock; a socket that answers means
 * a daemon is running, one that does not is replaced. The socket is bound under a temporary name
 * no longer than the socket's own and renamed into place, because closing a unix socket server
 * unlinks the name it was bound to, which by then may be another daemon's socket.
 */
export const bindSocket = async (paths: HostPaths): Promise<Listener> => {
  await preparePrivateDirs(paths);
  const lock = await acquireStartLock(paths.lock);
  let server: Server;
  let identity: string | null;
  let accept: (socket: Socket) => void;
  const early: Socket[] = [];
  try {
    if (await answers(paths.socket)) throw new AlreadyRunningError('already running');
    accept = (socket) => early.push(socket);
    server = createServer((socket) => {
      accept(socket);
    });
    const bound = join(paths.runDir, randomBytes(2).toString('hex'));
    await removeFile(bound);
    await listen(server, bound);
    try {
      await makeOwnerOnly(bound);
      await renameFile(bound, paths.socket);
      identity = await fileIdentity(paths.socket);
    } catch (error) {
      server.close();
      for (const socket of early.splice(0)) socket.destroy();
      await removeFile(bound).catch(() => undefined);
      throw error;
    }
  } finally {
    await lock.release();
  }
  return {
    serve: (handler) => {
      accept = handler;
      for (const socket of early.splice(0)) handler(socket);
    },
    close: async () => {
      server.close();
      if (identity !== null && (await fileIdentity(paths.socket)) === identity) await removeFile(paths.socket);
    },
  };
};
