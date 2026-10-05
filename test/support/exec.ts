import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

export interface ExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Runs a command in the repo root and captures its output. */
export const exec = (command: string, args: readonly string[]): ExecResult => {
  const result = spawnSync(command, args, { cwd: REPO_ROOT, encoding: 'utf8', timeout: 600_000 });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};
