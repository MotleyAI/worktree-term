import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { readFileIfExists } from '../../platform/files/index.js';

export const DEFAULT_PORT = 7417;

const MAX_REPOS = 256;
const MAX_PATH = 4096;

/** The hub configuration, `~/` already expanded. */
export interface HubConfig {
  port: number;
  repos: string[];
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

const configSchema = z.strictObject({
  port: z.int().min(1024).max(65535).optional(),
  repos: z.array(repoPath).max(MAX_REPOS).optional(),
});

const oneLine = (text: string): string => text.replace(/\s+/g, (run) => (run.includes('\n') ? ' ' : run));

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`invalid JSON: ${oneLine(error instanceof Error ? error.message : String(error))}`, { cause: error });
  }
};

const expand = (path: string, home: string): string => {
  if (!path.startsWith('~/')) return path;
  const expanded = join(home, path.slice(2));
  if (expanded.length > MAX_PATH) throw new ConfigError(`repos: ${path} is longer than ${String(MAX_PATH)} characters once expanded`);
  return expanded;
};

/** Parses `config.json` text (null for a missing file); throws ConfigError naming the first problem. */
export const parseConfig = (text: string | null, home: string): HubConfig => {
  if (text === null) return { port: DEFAULT_PORT, repos: [] };
  const result = configSchema.safeParse(parseJson(text));
  if (!result.success) {
    const [issue] = result.error.issues;
    const where = issue === undefined || issue.path.length === 0 ? '' : `${issue.path.map(String).join('.')}: `;
    throw new ConfigError(oneLine(`${where}${issue?.message ?? 'invalid configuration'}`));
  }
  return { port: result.data.port ?? DEFAULT_PORT, repos: (result.data.repos ?? []).map((repo) => expand(repo, home)) };
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
