import { hostPaths } from '../../platform/files/index.js';

/** Placeholder for hub configuration; implemented by DEV-2052. */
export function placeholder(): void {
  throw new Error('not implemented', { cause: { paths: hostPaths } });
}
