import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { readFileIfExists } from '../../platform/files/index.js';
import { discoveryRootSchema, presetSchema, type Preset } from '../../protocol/index.js';

export const DEFAULT_PORT = 7417;

export const MAX_REPOS = 256;
const MAX_PATH = 4096;
const MAX_PRESETS = 64;
const MAX_ROOTS = 32;
const MAX_REMOTE_HOSTS = 63;
const DEFAULT_PRESETS: readonly Preset[] = [{ name: 'shell', command: null }];
const DEFAULT_ROOTS: readonly string[] = ['~'];

/** A configured remote host. */
export interface RemoteHostConfig {
  name: string;
  /** The SSH alias. */
  ssh: string;
  repos: string[];
  roots: string[];
}

/** The hub configuration, local `~/` repos already expanded. */
export interface HubConfig {
  port: number;
  /** The local host's repos and discovery roots. */
  repos: string[];
  roots: string[];
  presets: Preset[];
  hosts: RemoteHostConfig[];
}

/** An unusable configuration; the message is one line. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

// eslint-disable-next-line no-control-regex -- NUL is the character paths must not contain
const NO_NUL = /^[^\u0000]*$/;

const repoPath = z
  .string()
  .max(MAX_PATH)
  .regex(NO_NUL, 'must not contain NUL')
  .refine((p) => isAbsolute(p) || p.startsWith('~/'), 'must be absolute or start with ~/');

const absolutePath = z.string().max(MAX_PATH).regex(NO_NUL, 'must not contain NUL').refine(isAbsolute, 'must be absolute');

const roots = z.array(discoveryRootSchema).min(1).max(MAX_ROOTS);

// eslint-disable-next-line no-control-regex -- control characters are what aliases must not contain
const SSH_ALIAS = /^[^-\s\u0000-\u0008\u000e-\u001f\u007f][^\s\u0000-\u0008\u000e-\u001f\u007f]*$/;

const remoteHost = z.strictObject({
  name: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/, 'must be 1–64 characters from A–Z, a–z, 0–9, ., _ and -'),
  ssh: z.string().max(255).regex(SSH_ALIAS, 'must not be empty, start with - or contain whitespace or control characters'),
  repos: z.array(absolutePath).max(MAX_REPOS).optional(),
  roots: roots.optional(),
});

const configSchema = z.strictObject({
  port: z.int().min(1024).max(65535).optional(),
  repos: z.array(repoPath).max(MAX_REPOS).optional(),
  roots: roots.optional(),
  hosts: z
    .array(remoteHost)
    .max(MAX_REMOTE_HOSTS)
    .refine((list) => new Set(list.map((h) => h.name)).size === list.length, 'host names must be unique')
    .optional(),
  presets: z
    .array(presetSchema)
    .min(1)
    .max(MAX_PRESETS)
    .refine((list) => new Set(list.map((p) => p.name)).size === list.length, 'preset names must be unique')
    .optional(),
});

const oneLine = (text: string): string => text.replace(/\s+/g, (run) => (run.includes('\n') ? ' ' : run));

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`invalid JSON: ${oneLine(error instanceof Error ? error.message : String(error))}`, { cause: error });
  }
};

/** `path` with a leading `~/` expanded against `home`. */
export const expandHome = (path: string, home: string): string => (path.startsWith('~/') ? join(home, path.slice(2)) : path);

const expand = (path: string, home: string): string => {
  if (!path.startsWith('~/')) return path;
  const expanded = expandHome(path, home);
  if (expanded.length > MAX_PATH) throw new ConfigError(`repos: ${path} is longer than ${String(MAX_PATH)} characters once expanded`);
  return expanded;
};

/** Parses `config.json` text (null for a missing file); throws ConfigError naming the first problem. */
export const parseConfig = (text: string | null, home: string): HubConfig => {
  if (text === null) return { port: DEFAULT_PORT, repos: [], roots: [...DEFAULT_ROOTS], presets: [...DEFAULT_PRESETS], hosts: [] };
  const result = configSchema.safeParse(parseJson(text));
  if (!result.success) {
    const [issue] = result.error.issues;
    const where = issue === undefined || issue.path.length === 0 ? '' : `${issue.path.map(String).join('.')}: `;
    throw new ConfigError(oneLine(`${where}${issue?.message ?? 'invalid configuration'}`));
  }
  return {
    port: result.data.port ?? DEFAULT_PORT,
    repos: (result.data.repos ?? []).map((repo) => expand(repo, home)),
    roots: result.data.roots ?? [...DEFAULT_ROOTS],
    presets: result.data.presets ?? [...DEFAULT_PRESETS],
    hosts: (result.data.hosts ?? []).map((h) => ({ name: h.name, ssh: h.ssh, repos: h.repos ?? [], roots: h.roots ?? [...DEFAULT_ROOTS] })),
  };
};

/** Reads and parses the configuration at `path`; throws ConfigError naming the file and the problem. */
export const loadConfig = async (path: string, home: string): Promise<HubConfig> => {
  try {
    return parseConfig(await readFileIfExists(path), home);
  } catch (error) {
    if (error instanceof ConfigError) throw new ConfigError(`${path}: ${error.message}`, { cause: error });
    throw new ConfigError(`${path}: ${oneLine(error instanceof Error ? error.message : String(error))}`, { cause: error });
  }
};

/** A configuration read for one session, with the problem of an invalid file. */
export interface ConfigSnapshot {
  config: HubConfig;
  problem: string | null;
}

/** Reads the configuration per session, falling back to the last valid one. */
export class ConfigSource {
  constructor(
    private readonly path: string,
    private readonly home: string,
    private last: HubConfig,
  ) {}

  async snapshot(): Promise<ConfigSnapshot> {
    try {
      this.last = await loadConfig(this.path, this.home);
      return { config: this.last, problem: null };
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      return { config: this.last, problem: error.message };
    }
  }
}
