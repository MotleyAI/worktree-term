import { placeholder as client } from '../client/index.js';
import { placeholder as terminals } from '../terminals/index.js';
import { placeholder as layout } from '../layout/index.js';

/** Placeholder for the Preact UI; implemented by DEV-2052. */
export function placeholder(): void {
  client();
  terminals();
  layout();
  throw new Error('not implemented');
}
