import { placeholder as client } from '../client/index.js';

/** Placeholder for xterm.js terminals and the WebGL budget; implemented by DEV-2052. */
export function placeholder(): void {
  client();
  throw new Error('not implemented');
}
