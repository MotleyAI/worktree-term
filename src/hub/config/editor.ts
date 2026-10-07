import { dirname } from 'node:path';
import { fileIdentity, makePrivateDirs, readFileIfExists, writeFileAtomic } from '../../platform/files/index.js';
import { ConfigError, expandHome, MAX_REPOS, parseConfig } from './config.js';

const ATTEMPTS = 3;

/** The outcome of a repo edit: whether the file changed, and the host's repos afterwards, `~/` expanded. */
export interface RepoEdit {
  changed: boolean;
  repos: string[];
}

export interface EditorHooks {
  /** Runs after an attempt computed its result and before it checks the file and replaces it. */
  beforeReplace?: (attempt: number) => void | Promise<void>;
}

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);

const stringsOf = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);

/** Edits the repos of one host in `config.json`, keeping everything else as written; one edit at a time. */
export class ConfigEditor {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly home: string,
    private readonly hooks: EditorHooks = {},
  ) {}

  /** Adds `repo` to the local host (`host` null) or the named remote host unless it is listed already. */
  addRepo(host: string | null, repo: string): Promise<RepoEdit> {
    return this.edit(host, (repos) => (repos.some((entry) => this.names(host, entry, repo)) ? null : [...repos, repo]));
  }

  /** Whether the host's repos name `repo`, as given or by a `~/` form; throws ConfigError for an unusable file. */
  async lists(host: string | null, repo: string): Promise<boolean> {
    const text = await readFileIfExists(this.path);
    parseConfig(text, this.home);
    const raw: unknown = text === null ? {} : JSON.parse(text);
    if (!isObject(raw)) throw new ConfigError('the configuration is not an object');
    return stringsOf(this.ownerOf(raw, host)['repos']).some((entry) => this.names(host, entry, repo));
  }

  /** Removes every entry naming `repo`, as given or by a `~/` form, from the host's repos. */
  removeRepo(host: string | null, repo: string): Promise<RepoEdit> {
    return this.edit(host, (repos) => {
      const kept = repos.filter((entry) => !this.names(host, entry, repo));
      return kept.length === repos.length ? null : kept;
    });
  }

  private names(host: string | null, entry: string, repo: string): boolean {
    return entry === repo || (host === null && expandHome(entry, this.home) === repo);
  }

  private expanded(host: string | null, repos: readonly string[]): string[] {
    return host === null ? repos.map((repo) => expandHome(repo, this.home)) : [...repos];
  }

  private edit(host: string | null, change: (repos: string[]) => string[] | null): Promise<RepoEdit> {
    const run = this.queue.then(() => this.attempt(host, change, 1));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async attempt(host: string | null, change: (repos: string[]) => string[] | null, attempt: number): Promise<RepoEdit> {
    const identity = await fileIdentity(this.path);
    const text = await readFileIfExists(this.path);
    parseConfig(text, this.home);
    const raw: unknown = text === null ? {} : JSON.parse(text);
    if (!isObject(raw)) throw new ConfigError('the configuration is not an object');
    const owner = this.ownerOf(raw, host);
    const current = stringsOf(owner['repos']);
    const next = change(current);
    if (next === null) return { changed: false, repos: this.expanded(host, current) };
    if (next.length > MAX_REPOS) throw new ConfigError(`${host ?? 'the local host'} would list more than ${String(MAX_REPOS)} repos`);
    owner['repos'] = next;
    await this.hooks.beforeReplace?.(attempt);
    if ((await fileIdentity(this.path)) !== identity || (await readFileIfExists(this.path)) !== text) {
      if (attempt >= ATTEMPTS) throw new ConfigError(`${this.path} kept changing while being edited`);
      return this.attempt(host, change, attempt + 1);
    }
    if (text === null) await makePrivateDirs(dirname(this.path));
    await writeFileAtomic(this.path, `${JSON.stringify(raw, null, 2)}\n`);
    return { changed: true, repos: this.expanded(host, next) };
  }

  /** The object holding the edited host's `repos`: the configuration itself, or the named host's entry. */
  private ownerOf(raw: JsonObject, host: string | null): JsonObject {
    if (host === null) return raw;
    const hosts: unknown = raw['hosts'];
    const entry = Array.isArray(hosts) ? hosts.find((h): h is JsonObject => isObject(h) && h['name'] === host) : undefined;
    if (entry === undefined) throw new ConfigError(`host ${host} is no longer configured`);
    return entry;
  }
}
