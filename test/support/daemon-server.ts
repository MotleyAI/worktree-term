import { afterEach, beforeEach } from 'vitest';
import { DaemonHost } from './daemon-host.js';

export let host: DaemonHost;

/** Registers the per-test setup and cleanup. */
export const useDaemonServerHost = (): void => {
  beforeEach(() => {
    host = DaemonHost.create();
  });

  afterEach(async () => {
    await host.cleanup();
  });
};
