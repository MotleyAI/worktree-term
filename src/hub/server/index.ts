import { acquireStartLock, preparePrivateDirs, type HostPaths } from '../../platform/files/index.js';
import type { BrowserChannel, RoutedSession } from '../router/index.js';
import { hubIdentity } from './client.js';
import { CodeStore } from './codes.js';
import { Listener } from './listener.js';
import { readHubRecord, removeHubRecord, writeHubRecord } from './record.js';
import { loadStaticFiles } from './static.js';
import { loadToken } from './token.js';

export { hubIdentity, portServed, requestCode, requestShutdown, type HubIdentity } from './client.js';
export { PortInUseError } from './listener.js';
export { readHubRecord, type HubRecord } from './record.js';
export { readToken } from './token.js';

/** The host files of the hub. */
export type HubPaths = Pick<HostPaths, 'stateDir' | 'runDir' | 'hubToken' | 'hubLog' | 'hubLock' | 'hubRecord'>;

/** Another hub answers for the hub record. */
export class HubAlreadyRunningError extends Error {
  override readonly name = 'HubAlreadyRunningError';
}

export interface HubServerOptions {
  paths: HubPaths;
  port: number;
  version: string;
  instance: string;
  /** The web bundle directory. */
  webDir: string;
  openSession: (channel: BrowserChannel) => RoutedSession;
  /** An authenticated shutdown request was answered. */
  shutdown: () => void;
}

export interface RunningHubServer {
  /** Closes every session with 1001, stops listening and removes the hub record. */
  close: () => Promise<void>;
}

/** Creates the state directories owner-only. */
export const prepareHubDirs = (paths: HubPaths): Promise<void> => preparePrivateDirs(paths);

/**
 * Loads the bundle and token, then binds under the hub start lock and writes the hub record.
 * Rejects with HubAlreadyRunningError when the recorded hub answers, PortInUseError when the port is taken.
 */
export const startHubServer = async (options: HubServerOptions): Promise<RunningHubServer> => {
  const { paths, port, version, instance } = options;
  const files = await loadStaticFiles(options.webDir);
  await prepareHubDirs(paths);
  const token = await loadToken(paths.hubToken);
  const lock = await acquireStartLock(paths.hubLock);
  let listener: Listener;
  try {
    const record = await readHubRecord(paths.hubRecord);
    if (record !== null && (await hubIdentity(record.port, token))?.instance === record.instance) {
      throw new HubAlreadyRunningError('already running');
    }
    listener = await Listener.listen({
      port,
      version,
      instance,
      token,
      codes: new CodeStore(),
      files,
      openSession: options.openSession,
      shutdown: options.shutdown,
    });
    await writeHubRecord(paths.hubRecord, { pid: process.pid, port, instance }).catch(async (error: unknown) => {
      await listener.close();
      throw error;
    });
    listener.open();
  } finally {
    await lock.release();
  }
  return {
    close: async () => {
      await listener.close();
      await removeHubRecord(paths.hubRecord, instance);
    },
  };
};
