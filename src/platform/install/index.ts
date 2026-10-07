import { spawnDetached } from '../dialer/index.js';
import { currentHostPaths } from '../files/index.js';

// Placeholder keeping the model's arrows live; the installer replaces it.
const notImplemented = (): Promise<never> => Promise.reject(new Error('not implemented'));

/** Installs the running bundle for this user. */
export const installLocal = (): Promise<never> => notImplemented();

/** Installs the running bundle on the SSH host `alias`. */
export const installRemote = (): Promise<never> => notImplemented();

export const placeholderDependencies = [spawnDetached, currentHostPaths] as const;
