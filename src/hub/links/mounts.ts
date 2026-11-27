import { listMounts, mount, MountError, mountPoint, removeLeftovers, unmount, type MountTarget } from '../../platform/mounts/index.js';

type MountPaths = Parameters<typeof mount>[0];

/** A remote worktree to mount, with the repo whose worktree list holds it. */
export interface WorktreeMount extends MountTarget {
  readonly repo: string;
}

/** How a mount ended: its mount point, or the failure to answer `openEditor` with. */
export type MountOutcome =
  { kind: 'mounted'; point: string } | { kind: 'error'; code: 'editor-missing' | 'editor-failed'; message: string };

interface Entry {
  readonly target: WorktreeMount;
  readonly mounted: Promise<MountOutcome>;
}

const outcomeOf = (error: unknown): MountOutcome => {
  if (error instanceof MountError && error.failure === 'missing-program' && error.program !== null) {
    return { kind: 'error', code: 'editor-missing', message: error.program };
  }
  return { kind: 'error', code: 'editor-failed', message: error instanceof Error ? error.message : String(error) };
};

/** The hub's mounts of remote worktrees, shared by every session; each made once and unmounted lazily. */
export class MountRegistry {
  private readonly entries = new Map<string, Entry>();
  /** Settles once `start` removed the stale mounts and leftover mount points of an earlier hub. */
  private readonly cleaned: Promise<void>;
  private markCleaned: () => void = () => undefined;
  private started = false;
  private closing = false;
  /** Settles once every queued unmount ran; unmounts run one at a time. */
  private unmounting: Promise<void>;
  /** Per mount point, settles once its queued unmount ran; a remount waits for it. */
  private readonly releasing = new Map<string, Promise<void>>();

  constructor(
    private readonly paths: MountPaths,
    /** Reports a failed unmount or cleanup. */
    private readonly report: (error: unknown) => void,
  ) {
    this.cleaned = new Promise((resolve) => {
      this.markCleaned = resolve;
    });
    this.unmounting = this.cleaned;
  }

  /** Starts removing an earlier hub's mounts; call once this hub owns its state directory. Mounts wait for it. */
  start(): void {
    if (this.started) return;
    this.started = true;
    void this.cleanStale().catch(this.report).then(this.markCleaned);
  }

  /** The mount point of `target`, mounting it unless a mount exists or is being made; refused once closing began. */
  mount(target: WorktreeMount): Promise<MountOutcome> {
    if (this.closing) return Promise.resolve({ kind: 'error', code: 'editor-failed', message: 'the hub is shutting down' });
    const point = mountPoint(this.paths, target);
    const existing = this.entries.get(point);
    if (existing !== undefined) return existing.mounted;
    const mounted = (this.releasing.get(point) ?? this.cleaned)
      .then(() => mount(this.paths, target))
      .then(
        (at): MountOutcome => ({ kind: 'mounted', point: at }),
        (error: unknown) => {
          if (this.entries.get(point)?.mounted === mounted) this.entries.delete(point);
          return outcomeOf(error);
        },
      );
    this.entries.set(point, { target, mounted });
    return mounted;
  }

  /** The daemon of host `host` on `alias` listed `worktrees` for `repo`: unmounts that repo's mounts it no longer lists. */
  listed(host: string, alias: string, repo: string, worktrees: readonly string[]): void {
    this.drop(({ target }) => target.host === host && target.alias === alias && target.repo === repo && !worktrees.includes(target.path));
  }

  /** A configuration listing `hosts` was read: unmounts the mounts of every other (name, alias). */
  configured(hosts: readonly { name: string; alias: string }[]): void {
    this.drop(({ target }) => !hosts.some((h) => h.name === target.host && h.alias === target.alias));
  }

  /** Unmounts every mount, waiting for unmounts already queued; a registry never started has none. */
  async close(): Promise<void> {
    this.closing = true;
    this.drop(() => true);
    if (this.started) await this.unmounting;
  }

  private drop(matches: (entry: Entry) => boolean): void {
    for (const [point, entry] of this.entries) if (matches(entry)) this.unmountEntry(point);
  }

  /** Queues the unmount of the entry at `point` once its mount settled, reporting a failure. */
  private unmountEntry(point: string): void {
    const entry = this.entries.get(point);
    if (entry === undefined) return;
    this.entries.delete(point);
    const released = this.unmounting.then(async () => {
      const outcome = await entry.mounted;
      if (outcome.kind === 'mounted') await unmount(outcome.point).catch(this.report);
      if (this.releasing.get(point) === released) this.releasing.delete(point);
    });
    this.unmounting = released;
    this.releasing.set(point, released);
  }

  /** Unmounts every mount under the mount directory and removes every leftover mount point. */
  private async cleanStale(): Promise<void> {
    for (const point of await listMounts(this.paths)) await unmount(point).catch(this.report); // NOSONAR(S9382) — one at a time
    await removeLeftovers(this.paths);
  }
}
