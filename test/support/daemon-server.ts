import { afterEach, beforeEach } from 'vitest';
import { DaemonHost } from './daemon-host.js';

/** Per-test values, refilled by the `beforeEach` that `useDaemonServerHost` registers. */
class DaemonServerFixture {
  host!: DaemonHost;
}

export const fx = new DaemonServerFixture();

/** Registers the per-test setup and cleanup. */
export const useDaemonServerHost = (): void => {
  beforeEach(() => {
    fx.host = DaemonHost.create();
  });

  afterEach(async () => {
    await fx.host.cleanup();
  });
};
