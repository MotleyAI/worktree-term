import type { Terminal } from '../../protocol/index.js';
import { RequestError } from '../client/index.js';

/** The targets that have not exited, in order: closing them needs confirmation. */
export const needsConfirm = (targets: readonly Terminal[]): Terminal[] => targets.filter((t) => t.exit === null);

/** Closes the targets still `live`, concurrently; a terminal already gone counts as closed. */
export const closeTargets = async (
  targets: readonly number[],
  live: readonly number[],
  close: (termId: number) => Promise<void>,
): Promise<void> => {
  const alive = new Set(live);
  await Promise.all(
    targets
      .filter((termId) => alive.has(termId))
      .map(async (termId) => {
        try {
          await close(termId);
        } catch (error) {
          if (!(error instanceof RequestError && error.code === 'unknown-term')) throw error;
        }
      }),
  );
};
