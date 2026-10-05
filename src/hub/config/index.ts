import { placeholder as files } from '../../platform/files/index.js';

/** Placeholder for hub configuration; implemented by DEV-2052. */
export function placeholder(): void {
  files();
  throw new Error('not implemented');
}
