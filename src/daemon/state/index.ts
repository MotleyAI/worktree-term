import { placeholder as files } from '../../platform/files/index.js';

/** Placeholder for persisted checkbox and layout state; implemented by DEV-2051. */
export function placeholder(): void {
  files();
  throw new Error('not implemented');
}
