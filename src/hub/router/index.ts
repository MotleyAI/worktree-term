import { placeholder as links } from '../links/index.js';
import { placeholder as config } from '../config/index.js';

/** Placeholder for browser-to-daemon routing; implemented by DEV-2052. */
export function placeholder(): void {
  links();
  config();
  throw new Error('not implemented');
}
