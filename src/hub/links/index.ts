import { placeholder as dial } from '../../platform/dialer/index.js';
import { PROTOCOL_VERSION } from '../../protocol/index.js';

/** Placeholder for per-host daemon links; implemented by DEV-2052. */
export function placeholder(): void {
  dial();
  throw new Error('not implemented', { cause: { protocol: PROTOCOL_VERSION } });
}
