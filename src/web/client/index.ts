import { PROTOCOL_VERSION } from '../../protocol/index.js';

/** Placeholder for the hub WebSocket client; implemented by DEV-2052. */
export function placeholder(): void {
  throw new Error('not implemented', { cause: { protocol: PROTOCOL_VERSION } });
}
