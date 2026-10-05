import { placeholder as worktrees } from '../worktrees/index.js';
import { placeholder as terminals } from '../terminals/index.js';
import { placeholder as state } from '../state/index.js';
import { PROTOCOL_VERSION } from '../../protocol/index.js';

/** Placeholder for the daemon protocol server; implemented by DEV-2051. */
export function placeholder(): void {
  worktrees();
  terminals();
  state();
  throw new Error('not implemented', { cause: { protocol: PROTOCOL_VERSION } });
}
