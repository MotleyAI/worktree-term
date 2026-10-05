import { hostPaths } from '../../platform/files/index.js';
import { placeholder as router } from '../router/index.js';

/** Placeholder for the HTTP and WebSocket server; implemented by DEV-2052. */
export function placeholder(): void {
  router();
  throw new Error('not implemented', { cause: { paths: hostPaths } });
}
