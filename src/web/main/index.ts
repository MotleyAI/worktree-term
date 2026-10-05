import { placeholder as ui } from '../ui/index.js';
import { placeholder as client } from '../client/index.js';
import { placeholder as terminals } from '../terminals/index.js';

/** Placeholder for the browser entry; implemented by DEV-2052. */
export function placeholder(): void {
  ui();
  client();
  terminals();
  throw new Error('not implemented');
}
