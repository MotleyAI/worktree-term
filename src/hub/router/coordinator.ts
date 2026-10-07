type Kind = 'restart' | 'reinstall';

interface Run {
  kind: Kind;
  promise: Promise<void>;
}

/** One host's restart and reinstall operations. */
export interface HostOperations {
  restart: () => Promise<void>;
  reinstall: () => Promise<void>;
}

/**
 * Runs one host's restarts and reinstalls one at a time, across sessions: identical requests share
 * a run, a restart shares a running or queued reinstall, and other requests wait for the running one.
 */
export class HostCoordinator {
  private running: Run | null = null;
  private queued: Run | null = null;

  constructor(private readonly operations: HostOperations) {}

  restart(): Promise<void> {
    return this.request('restart');
  }

  /** The running or queued reinstall, which a restart shares whatever the host's status; null without one. */
  reinstalling(): Promise<void> | null {
    return [this.running, this.queued].find((run) => run?.kind === 'reinstall')?.promise ?? null;
  }

  reinstall(): Promise<void> {
    return this.request('reinstall');
  }

  private request(kind: Kind): Promise<void> {
    const shared = [this.running, this.queued].find((run) => run !== null && (run.kind === kind || run.kind === 'reinstall'));
    if (shared !== undefined && shared !== null) return shared.promise;
    if (this.running === null) return this.start(kind).promise;
    const before = this.running.promise;
    const queued: Run = {
      kind,
      promise: before
        .catch(() => undefined)
        .then(() => {
          this.queued = null;
          return this.start(kind).promise;
        }),
    };
    this.queued = queued;
    return queued.promise;
  }

  private start(kind: Kind): Run {
    const run: Run = {
      kind,
      promise: this.operations[kind]().finally(() => {
        if (this.running === run) this.running = null;
      }),
    };
    this.running = run;
    return run;
  }
}
