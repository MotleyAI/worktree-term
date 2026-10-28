import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve('scripts/wtd-dev-restart');
/** What the script runs before its build, besides node and pnpm. */
const BASICS = ['bash', 'mkdir', 'cat', 'tail', 'ss', 'setsid'];

interface Outcome {
  status: number | null;
  stderr: string;
  /** The PATH the fake pnpm ran with, or null when it did not run. */
  buildPath: string | null;
}

describe('wtd-dev-restart finding node and pnpm', () => {
  let dir: string;
  /** Holds only the basics: stands in for a desktop launcher's PATH, which lacks node and pnpm. */
  let basics: string;
  /** Holds a fake node and pnpm, whose build reports its PATH and fails, ending the script. */
  let tools: string;
  let home: string;

  /** Runs the script; without `shell`, SHELL is unset, as in some desktop sessions. */
  const run = (path: string, shell?: string): Outcome => {
    const result = spawnSync('/bin/bash', [SCRIPT, '--no-browser'], {
      env: { HOME: home, PATH: path, WTD_REPO: dir, XDG_STATE_HOME: join(dir, 'state'), ...(shell === undefined ? {} : { SHELL: shell }) },
      encoding: 'utf8',
      timeout: 30_000,
    });
    const buildPath = /^build PATH=(.*)$/m.exec(result.stderr)?.[1] ?? null;
    return { status: result.status, stderr: result.stderr, buildPath };
  };

  const bashrc = (line: string): void => {
    writeFileSync(join(home, '.bashrc'), `${line}\n`);
  };

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'wtd-dev-restart-')));
    basics = join(dir, 'basics');
    tools = join(dir, 'tools');
    home = join(dir, 'home');
    for (const d of [basics, tools, home]) mkdirSync(d);
    for (const name of BASICS) {
      const found = spawnSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim();
      symlinkSync(found, join(basics, name));
    }
    writeFileSync(join(tools, 'node'), '#!/bin/sh\nexit 0\n');
    writeFileSync(join(tools, 'pnpm'), '#!/bin/sh\necho "build PATH=$PATH"\nexit 3\n');
    for (const name of ['node', 'pnpm']) chmodSync(join(tools, name), 0o755);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('builds with the inherited PATH when it has node and pnpm', () => {
    bashrc(`export PATH=/nowhere:$PATH`);
    const outcome = run(`${tools}:${basics}`);
    expect(outcome.status).toBe(1);
    expect(outcome.buildPath).toBe(`${tools}:${basics}`);
  });

  it('puts the interactive shell’s PATH first when the inherited one lacks node and pnpm', () => {
    bashrc(`export PATH=${tools}:$PATH`);
    expect(run(basics).buildPath).toBe(`${tools}:${basics}:${basics}`);
  });

  it('keeps the inherited PATH when the shell’s replaces it', () => {
    bashrc(`export PATH=${tools}`);
    expect(run(basics).buildPath).toBe(`${tools}:${basics}`);
  });

  it('falls back when only node is missing', () => {
    writeFileSync(join(basics, 'pnpm'), '#!/bin/sh\necho "build PATH=$PATH"\nexit 3\n');
    chmodSync(join(basics, 'pnpm'), 0o755);
    bashrc(`export PATH=${tools}:$PATH`);
    expect(run(basics).buildPath).toBe(`${tools}:${basics}:${basics}`);
  });

  it('asks the user’s shell from SHELL rather than bash', () => {
    bashrc('export PATH=/nowhere:$PATH');
    // Like a zsh whose startup files put the tools on PATH: answers the interactive command with that PATH.
    const shell = join(dir, 'zsh');
    writeFileSync(shell, `#!/bin/sh\n[ "$1" = -ic ] || exit 9\nprintf '\\n%s' "${tools}:$PATH"\n`);
    chmodSync(shell, 0o755);
    expect(run(basics, shell).buildPath).toBe(`${tools}:${basics}:${basics}`);
  });

  it('names a missing system command too, before building', () => {
    rmSync(join(basics, 'ss'));
    bashrc('');
    const outcome = run(`${tools}:${basics}`);
    expect(outcome.buildPath).toBeNull();
    expect(outcome.stderr).toBe("wtd-dev-restart: not on PATH, nor on an interactive shell's: ss\n");
  });

  it('names what is still missing and stops before building', () => {
    bashrc('');
    const outcome = run(basics);
    expect(outcome.status).toBe(1);
    expect(outcome.buildPath).toBeNull();
    expect(outcome.stderr).toBe("wtd-dev-restart: not on PATH, nor on an interactive shell's: node pnpm\n");
  });
});
