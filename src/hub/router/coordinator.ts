type Kind = 'restart' | 'reinstall' | 'install';

interface Run {
  kind: Kind;
  promise: Promise<void>;
}

/** One host's restart, reinstall and install-only operations. */
export interface HostOperations {
  restart: () => Promise<void>;
  reinstall: () => Promise<void>;
  install: () => Promise<void>;
}

/** The runs a request of each kind shares instead of queueing its own. */
const SHARES: Readonly<Record<Kind, readonly Kind[]>> = {
  install: ['install', 'reinstall'],
  restart: ['restart', 'reinstall'],
  reinstall: ['reinstall'],
};

/**
 * Runs one host's operations one at a time, in request order, across sessions: a request shares a
 * running or queued run it is covered by, and otherwise queues behind every other.
 */
export class HostCoordinator {
  /** The running run first, then the queued ones. */
  private runs: Run[] = [];

  constructor(private readonly operations: HostOperations) {}

  restart(): Promise<void> {
    return this.request('restart');
  }

  /** The running or queued reinstall, which a restart shares whatever the host's status; null without one. */
  reinstalling(): Promise<void> | null {
    return this.runs.find((run) => run.kind === 'reinstall')?.promise ?? null;
  }

  reinstall(): Promise<void> {
    return this.request('reinstall');
  }

  install(): Promise<void> {
    return this.request('install');
  }

  private request(kind: Kind): Promise<void> {
    const shared = this.runs.find((run) => SHARES[kind].includes(run.kind));
    if (shared !== undefined) return shared.promise;
    const before = this.runs.at(-1)?.promise.catch(() => undefined) ?? Promise.resolve();
    const run: Run = {
      kind,
      promise: before
        .then(() => this.operations[kind]())
        .finally(() => {
          this.runs = this.runs.filter((r) => r !== run);
        }),
    };
    this.runs.push(run);
    return run.promise;
  }
}
