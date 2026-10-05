import { placeholder as files } from '../../platform/files/index.js';
import { placeholder as router } from '../router/index.js';

/** Placeholder for the HTTP and WebSocket server; implemented by DEV-2052. */
export function placeholder(): void {
  files();
  router();
  throw new Error('not implemented');
}
