import { z } from 'zod';
import { readFileIfExists, renameFile, writeFileAtomic } from '../../platform/files/index.js';
import { layoutSchema, type Layout } from '../../protocol/index.js';
import { pruneLayout } from './layout.js';

const absolute = z.string().regex(/^\//);

const fileSchema = z.strictObject({
  version: z.literal(1),
  repos: z.array(
    z.strictObject({
      repo: absolute,
      worktrees: z.array(z.strictObject({ path: absolute, checked: z.boolean(), layout: layoutSchema })),
    }),
  ),
});

interface Entry {
  checked: boolean;
  layout: Layout;
}

/** repo → worktree path → entry; only non-default entries are kept. */
type Repos = Map<string, Map<string, Entry>>;

type Change = (repos: Repos) => void;

interface Pending {
  change: Change;
  resolve: () => void;
  reject: (error: Error) => void;
}

export interface StateStoreOptions {
  /** Replaces a file's content atomically and durably. */
  write?: (path: string, data: string) => Promise<void>;
}

const EMPTY: Layout = { tabs: [], active: 0 };
const NO_TERMINALS: ReadonlySet<number> = new Set();

const isDefault = (entry: Entry): boolean => !entry.checked && entry.layout.tabs.length === 0;

const clone = (repos: Repos): Repos => new Map([...repos].map(([repo, entries]) => [repo, new Map(entries)]));

const update = (repo: string, path: string, edit: (entry: Entry) => Entry): Change => {
  return (repos) => {
    const entries = repos.get(repo) ?? new Map<string, Entry>();
    const entry = edit(entries.get(path) ?? { checked: false, layout: EMPTY });
    if (isDefault(entry)) entries.delete(path);
    else entries.set(path, entry);
    if (entries.size === 0) repos.delete(repo);
    else repos.set(repo, entries);
  };
};

const serialize = (repos: Repos): string =>
  JSON.stringify({
    version: 1,
    repos: [...repos].map(([repo, entries]) => ({ repo, worktrees: [...entries].map(([path, entry]) => ({ path, ...entry })) })),
  });

const parse = (text: string): Repos | null => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const result = fileSchema.safeParse(value);
  if (!result.success) return null;
  const repos: Repos = new Map();
  for (const { repo, worktrees } of result.data.repos) {
    for (const { path, checked, layout } of worktrees) {
      // No terminal survives a restart.
      update(repo, path, () => ({ checked, layout: pruneLayout(layout, NO_TERMINALS) }))(repos);
    }
  }
  return repos;
};

const asError = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));

/**
 * Checked state and layouts per repo and worktree, persisted in one file. A change resolves once
 * a write containing it has completed; a failed write rejects and rolls back its changes.
 */
export class StateStore {
  /** Content of the last successful write (or of the loaded file). */
  private committed: Repos;
  private current: Repos;
  private readonly queued: Pending[] = [];
  private writing: Promise<void> | null = null;

  private constructor(
    private readonly file: string,
    repos: Repos,
    private readonly write: (path: string, data: string) => Promise<void>,
  ) {
    this.committed = repos;
    this.current = clone(repos);
  }

  /** Loads `file`; an unreadable one is moved to `<file>.corrupt-<timestamp>` and state starts empty. */
  static async load(file: string, options: StateStoreOptions = {}): Promise<StateStore> {
    const text = await readFileIfExists(file);
    let repos: Repos = new Map();
    if (text !== null) {
      const parsed = parse(text);
      if (parsed === null) await renameFile(file, `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`);
      else repos = parsed;
    }
    return new StateStore(file, repos, options.write ?? writeFileAtomic);
  }

  /** Checked worktree paths of `repo`. */
  checked(repo: string): string[] {
    return [...(this.current.get(repo) ?? [])].filter(([, entry]) => entry.checked).map(([path]) => path);
  }

  layout(repo: string, path: string): Layout {
    return this.current.get(repo)?.get(path)?.layout ?? EMPTY;
  }

  /** Non-empty layouts of `repo`. */
  layouts(repo: string): { worktree: string; layout: Layout }[] {
    return [...(this.current.get(repo) ?? [])]
      .filter(([, entry]) => entry.layout.tabs.length > 0)
      .map(([worktree, entry]) => ({ worktree, layout: entry.layout }));
  }

  /** Worktree paths of `repo` that have an entry. */
  paths(repo: string): string[] {
    return [...(this.current.get(repo)?.keys() ?? [])];
  }

  setChecked(repo: string, path: string, checked: boolean): Promise<void> {
    return this.change(update(repo, path, (entry) => ({ ...entry, checked })));
  }

  setLayout(repo: string, path: string, layout: Layout): Promise<void> {
    return this.change(update(repo, path, (entry) => ({ ...entry, layout })));
  }

  /** Removes the entries of `repo` whose paths are not in `keep`; writes only if one is removed. */
  prune(repo: string, keep: ReadonlySet<string>): Promise<void> {
    const gone = this.paths(repo).filter((path) => !keep.has(path));
    if (gone.length === 0) return Promise.resolve();
    return this.change((repos) => {
      const entries = repos.get(repo);
      if (entries === undefined) return;
      for (const path of gone) entries.delete(path);
      if (entries.size === 0) repos.delete(repo);
    });
  }

  /** Resolves once no write is in flight or queued. */
  async flush(): Promise<void> {
    while (this.writing !== null) await this.writing; // NOSONAR(S9382) — each write may queue the next
  }

  private change(change: Change): Promise<void> {
    change(this.current);
    return new Promise((resolve, reject) => {
      this.queued.push({ change, resolve, reject });
      this.kick();
    });
  }

  private kick(): void {
    if (this.writing !== null || this.queued.length === 0) return;
    const batch = this.queued.splice(0);
    const snapshot = clone(this.current);
    this.writing = this.write(this.file, serialize(snapshot)).then(
      () => {
        this.committed = snapshot;
        this.settle();
        for (const pending of batch) pending.resolve();
      },
      (error: unknown) => {
        this.current = clone(this.committed);
        for (const pending of this.queued) pending.change(this.current);
        this.settle();
        for (const pending of batch) pending.reject(asError(error));
      },
    );
  }

  private settle(): void {
    this.writing = null;
    this.kick();
  }
}
