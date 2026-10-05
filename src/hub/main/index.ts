import { placeholder as server } from '../server/index.js';
import { placeholder as router } from '../router/index.js';
import { placeholder as links } from '../links/index.js';
import { placeholder as config } from '../config/index.js';

/** Placeholder for the hub process entry; implemented by DEV-2052. */
export function placeholder(): void {
  server();
  router();
  links();
  config();
  throw new Error('not implemented');
}
