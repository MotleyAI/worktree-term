import { placeholder as server } from '../server/index.js';
import { placeholder as worktrees } from '../worktrees/index.js';
import { placeholder as terminals } from '../terminals/index.js';
import { placeholder as state } from '../state/index.js';

/** Placeholder for the daemon process entry; implemented by DEV-2051. */
export function placeholder(): void {
  server();
  worktrees();
  terminals();
  state();
  throw new Error('not implemented');
}
