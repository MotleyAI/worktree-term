import { dirname } from 'node:path';
import { fileIdentity, makePrivateDirs, readFileIfExists, writeFileAtomic } from '../../platform/files/index.js';
import type { Preset } from '../../protocol/index.js';
import { ConfigError, expandHome, MAX_PRESETS, MAX_REPOS, parseConfig, type HubConfig } from './config.js';

const ATTEMPTS = 3;

/** The outcome of a repo edit: whether the file changed, and the host's repos afterwards, `~/` expanded. */
export interface RepoEdit {
  changed: boolean;
  repos: string[];
}

/** The outcome of a preset edit: whether the file changed, and the presets afterwards. */
export interface PresetEdit {
  changed: boolean;
  presets: Preset[];
}

export interface EditorHooks {
  /** Runs after an attempt computed its result and before it checks the file and replaces it. */
  beforeReplace?: (attempt: number) => void | Promise<void>;
}

type JsonObject = Record<string, unknown>;

/** A change to one array in the file. */
interface FieldEdit<T> {
  /** The object holding the array, and its key there. */
  owner: (raw: JsonObject) => JsonObject;
  key: string;
  /** The array's current value, from the parsed configuration or the object as written. */
  current: (config: HubConfig, owner: JsonObject) => T[];
  /** The new value, null to leave the file alone; throws ConfigError to refuse the edit. */
  change: (current: T[]) => T[] | null;
}

const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);

const stringsOf = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);

/** Edits the repos of one host, or the presets, in `config.json`, keeping everything else as written; one edit at a time. */
export class ConfigEditor {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly home: string,
    private readonly hooks: EditorHooks = {},
  ) {}

  /** Adds `repo` to the local host (`host` null) or the named remote host unless it is listed already. */
  addRepo(host: string | null, repo: string): Promise<RepoEdit> {
    return this.editRepos(host, (repos) => {
      if (repos.some((entry) => this.names(host, entry, repo))) return null;
      if (repos.length >= MAX_REPOS) throw new ConfigError(`${host ?? 'the local host'} would list more than ${String(MAX_REPOS)} repos`);
      return [...repos, repo];
    });
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
    return this.editRepos(host, (repos) => {
      const kept = repos.filter((entry) => !this.names(host, entry, repo));
      return kept.length === repos.length ? null : kept;
    });
  }

  /** Appends `preset` to the presets, the defaults when the file has none; refuses a taken name. */
  addPreset(preset: Preset): Promise<PresetEdit> {
    return this.editPresets((presets) => {
      if (presets.some((p) => p.name === preset.name)) throw new ConfigError(`a preset named ${preset.name} exists`);
      if (presets.length >= MAX_PRESETS) throw new ConfigError(`there would be more than ${String(MAX_PRESETS)} presets`);
      return [...presets, preset];
    });
  }

  /** Removes the preset named `name`; refuses to remove the last one. */
  removePreset(name: string): Promise<PresetEdit> {
    return this.editPresets((presets) => {
      const kept = presets.filter((p) => p.name !== name);
      if (kept.length === presets.length) return null;
      if (kept.length === 0) throw new ConfigError('the last preset cannot be removed');
      return kept;
    });
  }

  /** Moves the preset named `name` to position `to`, the last position when `to` is beyond it. */
  movePreset(name: string, to: number): Promise<PresetEdit> {
    return this.editPresets((presets) => {
      const from = presets.findIndex((p) => p.name === name);
      const moved = presets[from];
      if (moved === undefined) return null;
      const rest = presets.filter((_, i) => i !== from);
      const at = Math.min(to, rest.length);
      return at === from ? null : [...rest.slice(0, at), moved, ...rest.slice(at)];
    });
  }

  private names(host: string | null, entry: string, repo: string): boolean {
    return entry === repo || (host === null && expandHome(entry, this.home) === repo);
  }

  private async editRepos(host: string | null, change: (repos: string[]) => string[] | null): Promise<RepoEdit> {
    const { changed, value } = await this.edit({
      owner: (raw) => this.ownerOf(raw, host),
      key: 'repos',
      current: (_config, owner) => stringsOf(owner['repos']),
      change,
    });
    return { changed, repos: host === null ? value.map((repo) => expandHome(repo, this.home)) : value };
  }

  private async editPresets(change: (presets: Preset[]) => Preset[] | null): Promise<PresetEdit> {
    const { changed, value } = await this.edit({ owner: (raw) => raw, key: 'presets', current: (config) => config.presets, change });
    return { changed, presets: value };
  }

  private edit<T>(field: FieldEdit<T>): Promise<{ changed: boolean; value: T[] }> {
    const run = this.queue.then(() => this.attempt(field, 1));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async attempt<T>(field: FieldEdit<T>, attempt: number): Promise<{ changed: boolean; value: T[] }> {
    const identity = await fileIdentity(this.path);
    const text = await readFileIfExists(this.path);
    const config = parseConfig(text, this.home);
    const raw: unknown = text === null ? {} : JSON.parse(text);
    if (!isObject(raw)) throw new ConfigError('the configuration is not an object');
    const owner = field.owner(raw);
    const current = field.current(config, owner);
    const next = field.change(current);
    if (next === null) return { changed: false, value: current };
    owner[field.key] = next;
    await this.hooks.beforeReplace?.(attempt);
    if ((await fileIdentity(this.path)) !== identity || (await readFileIfExists(this.path)) !== text) {
      if (attempt >= ATTEMPTS) throw new ConfigError(`${this.path} kept changing while being edited`);
      return this.attempt(field, attempt + 1);
    }
    if (text === null) await makePrivateDirs(dirname(this.path));
    await writeFileAtomic(this.path, `${JSON.stringify(raw, null, 2)}\n`);
    return { changed: true, value: next };
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
