import { watch, type FSWatcher } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Worktree } from '../../protocol/index.js';
import { checkRepo, listWorktrees } from './git.js';

const DEBOUNCE_MS = 100;

/** Entries of the common git directory whose change can change the worktree list. */
const COMMON_ENTRIES: ReadonlySet<string> = new Set(['HEAD', 'packed-refs', 'worktrees', 'reftable']);

export interface WorktreeHandlers {
  /** The worktree list changed; receives the full new list. */
  changed: (worktrees: Worktree[]) => void;
  /** Watching or re-listing failed; the watch has stopped. */
  failed: (error: Error) => void;
}

export interface WorktreeWatch {
  /** The current worktree list, main first. */
  readonly worktrees: Worktree[];
  close: () => void;
}

interface Target {
  path: string;
  recursive: boolean;
  /** Only events naming one of these entries count; null for all. */
  only: ReadonlySet<string> | null;
}

interface Watched {
  watcher: FSWatcher;
  inode: number;
}

const isMissing = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');

const inodeOf = async (path: string): Promise<number | null> => {
  try {
    return (await stat(path)).ino;
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
};

const asError = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));

/** Watches a repo's worktree list through file-system events, reporting changes after 100 ms of quiet. */
class RepoWatch implements WorktreeWatch {
  worktrees: Worktree[] = [];
  private readonly watched = new Map<string, Watched>();
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private closed = false;

  constructor(
    private readonly repo: string,
    private readonly common: string,
    private readonly handlers: WorktreeHandlers,
  ) {}

  async start(): Promise<void> {
    await this.reconcile(await listWorktrees(this.repo));
    this.worktrees = await listWorktrees(this.repo);
    await this.reconcile(this.worktrees);
  }

  /** Whether the watch was closed, possibly while awaiting. */
  private isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    this.closed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    for (const { watcher } of this.watched.values()) watcher.close();
    this.watched.clear();
  }

  private targets(worktrees: readonly Worktree[]): Target[] {
    const admin = join(this.common, 'worktrees');
    const targets: Target[] = [
      { path: this.common, recursive: false, only: COMMON_ENTRIES },
      { path: admin, recursive: false, only: null },
      { path: join(this.common, 'refs', 'heads'), recursive: true, only: null },
      // Refs of the reftable format; absent in the files format.
      { path: join(this.common, 'reftable'), recursive: false, only: null },
    ];
    for (const worktree of worktrees) {
      if (worktree.main || worktree.bare) continue;
      targets.push({ path: join(worktree.path, '.git'), recursive: false, only: null });
    }
    return targets;
  }

  /** Keeps valid watchers, replaces lost ones and adds new ones, so later changes are seen. */
  private async reconcile(worktrees: readonly Worktree[]): Promise<void> {
    const admin = join(this.common, 'worktrees');
    const targets = this.targets(worktrees);
    for (const name of await this.adminEntries(admin)) targets.push({ path: join(admin, name), recursive: false, only: null });
    this.unwatchAllBut(new Set(targets.map((t) => t.path)));
    for (const target of targets) {
      const inode = await inodeOf(target.path);
      if (this.closed) return;
      const current = this.watched.get(target.path);
      if (current?.inode === inode) continue;
      current?.watcher.close();
      this.watched.delete(target.path);
      if (inode === null) {
        if (target.path === this.common) throw new Error(`${this.common} is gone`);
        continue;
      }
      const watcher = this.watch(target);
      if (watcher !== null) this.watched.set(target.path, { watcher, inode });
    }
  }

  private unwatchAllBut(wanted: ReadonlySet<string>): void {
    for (const [path, { watcher }] of this.watched) {
      if (wanted.has(path)) continue;
      watcher.close();
      this.watched.delete(path);
    }
  }

  private async adminEntries(admin: string): Promise<string[]> {
    try {
      return (await readdir(admin, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }

  /** Watches `target`; null when it vanished since it was found, so a refresh is scheduled instead. */
  private watch(target: Target): FSWatcher | null {
    let watcher: FSWatcher;
    try {
      watcher = watch(target.path, { recursive: target.recursive }, (_event, name) => {
        // An event without a name may concern any entry.
        if (target.only === null || name === null || target.only.has(name)) this.schedule();
      });
    } catch (error) {
      if (!isMissing(error) || target.path === this.common) throw error;
      this.schedule();
      return null;
    }
    watcher.on('error', () => {
      watcher.close();
      this.watched.delete(target.path);
      this.schedule();
    });
    return watcher;
  }

  private schedule(): void {
    if (this.closed) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.run();
    }, DEBOUNCE_MS);
  }

  private run(): void {
    if (this.running !== null) {
      this.again = true;
      return;
    }
    this.running = this.refresh().finally(() => {
      this.running = null;
      if (this.again) {
        this.again = false;
        this.run();
      }
    });
  }

  private async refresh(): Promise<void> {
    try {
      await this.reconcile(this.worktrees);
      const worktrees = await listWorktrees(this.repo);
      if (this.closed) return;
      await this.reconcile(worktrees);
      if (this.isClosed() || JSON.stringify(worktrees) === JSON.stringify(this.worktrees)) return;
      this.worktrees = worktrees;
      this.handlers.changed(worktrees);
    } catch (error) {
      if (this.closed) return;
      this.close();
      this.handlers.failed(asError(error));
    }
  }
}

/** Starts watching `repo`'s worktrees; rejects with NotARepoError if it is no repository's main worktree. */
export const watchWorktrees = async (repo: string, handlers: WorktreeHandlers): Promise<WorktreeWatch> => {
  const watch = new RepoWatch(repo, await checkRepo(repo), handlers);
  try {
    await watch.start();
  } catch (error) {
    watch.close();
    throw error;
  }
  return watch;
};
