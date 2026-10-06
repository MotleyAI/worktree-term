/** What restoring a host needs from the rest of the page. */
export interface RestoreDeps {
  /** Watches `repo`; resolves true once the watch is done, false when it failed. */
  watch: (host: number, repo: string) => Promise<boolean>;
  /** Terminals of `repo` the page has terminal objects for. */
  attached: (host: number, repo: string) => number[];
  /** Terminals of `repo` the daemon lists. */
  listed: (host: number, repo: string) => number[];
  attach: (host: number, termId: number) => void;
  /** Drops every terminal and state of `host`. */
  dispose: (host: number) => void;
}

/** Restores each host's repos and terminals when it becomes connected. */
export class Restorer {
  /** The daemon instance each host was last connected to. */
  private readonly instances = new Map<number, string>();

  constructor(private readonly deps: RestoreDeps) {}

  /** Host `host` became connected to daemon `instance`: dispose if the instance changed, then watch and re-attach. */
  async connected(host: number, instance: string, repos: readonly string[]): Promise<void> {
    const last = this.instances.get(host);
    if (last !== undefined && last !== instance) this.deps.dispose(host);
    this.instances.set(host, instance);
    await Promise.all(repos.map((repo) => this.restoreRepo(host, repo)));
  }

  private async restoreRepo(host: number, repo: string): Promise<void> {
    if (!(await this.deps.watch(host, repo))) return;
    const listed = new Set(this.deps.listed(host, repo));
    for (const termId of this.deps.attached(host, repo)) {
      if (listed.has(termId)) this.deps.attach(host, termId);
    }
  }
}
