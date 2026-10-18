import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect } from 'vitest';
import { sleep, type WtdProcess } from './daemon-host.js';
import { UpgradeRefused, type HubClient } from './hub-client.js';
import { HubHost, type RawResponse } from './hub-host.js';
import { REPO_ROOT } from './exec.js';

export let host: HubHost;

/** Registers the per-test setup and cleanup. */
export const useHubServerHost = (): void => {
  beforeEach(async () => {
    host = await HubHost.createHub();
  });

  afterEach(async () => {
    await host.cleanup();
  });
};

export const HEX64 = /^[0-9a-f]{64}$/;
export const ANY_TEXT: unknown = expect.any(String);
export const ANY_WORD: unknown = expect.stringMatching(/^\S+$/);
export const ANY_HEX64: unknown = expect.stringMatching(HEX64);
export const WEB = join(REPO_ROOT, 'dist', 'web');

export const packageVersion = (): string => {
  const pkg: unknown = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  if (typeof pkg !== 'object' || pkg === null || !('version' in pkg) || typeof pkg.version !== 'string') throw new Error('no version');
  return pkg.version;
};

export const header = (response: RawResponse, name: string): string[] => response.headers.get(name) ?? [];

/** Resolves the upgrade's outcome: the open client, or the refusal status. */
export const outcome = async (opening: Promise<HubClient>): Promise<HubClient | number> => {
  try {
    return await opening;
  } catch (error) {
    if (error instanceof UpgradeRefused) return error.status;
    throw error;
  }
};

export const refusal = async (opening: Promise<HubClient>): Promise<number> => {
  const result = await outcome(opening);
  if (typeof result !== 'number') {
    result.close();
    throw new Error('upgrade unexpectedly accepted');
  }
  return result;
};

export const waitExit = async (process_: WtdProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> => {
  const exit = await Promise.race([process_.exited, sleep(10_000).then(() => null)]);
  if (exit === null) throw new Error('process did not exit');
  return exit;
};
