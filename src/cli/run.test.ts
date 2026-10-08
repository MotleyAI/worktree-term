import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runCli } from './run.js';

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

const wtd = async (...argv: string[]): Promise<Result> => {
  let stdout = '';
  let stderr = '';
  const code = await runCli(argv, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
};

const packageVersion = (): string => {
  const pkg: unknown = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  if (typeof pkg !== 'object' || pkg === null || !('version' in pkg) || typeof pkg.version !== 'string') {
    throw new Error('package.json has no version');
  }
  return pkg.version;
};

const COMMANDS = ['ui', 'hub', 'daemon', 'connect', 'install-local', 'install-remote'];

/** Asserts a usage error: one error line plus the usage on stderr, nothing on stdout, exit 2. */
const expectUsageError = async (result: Result, mentions: RegExp): Promise<void> => {
  const usage = (await wtd('--help')).stdout;
  expect(result.code).toBe(2);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain(usage);
  const error = result.stderr.replace(usage, '').trim();
  expect(error).not.toContain('\n');
  expect(error).toMatch(mentions);
  expect(result.stderr).not.toMatch(/\n\s+at /);
};

describe('wtd --version', () => {
  it('prints the package and both protocol versions', async () => {
    expect(await wtd('--version')).toEqual({
      code: 0,
      stdout: `wtd ${packageVersion()} (daemon protocol 6, browser protocol 8)\n`,
      stderr: '',
    });
  });
});

describe('wtd --help', () => {
  it('lists every command and option on stdout', async () => {
    const { code, stdout, stderr } = await wtd('--help');
    expect(code).toBe(0);
    expect(stderr).toBe('');
    for (const word of [...COMMANDS, '--help', '--version']) {
      expect(stdout).toMatch(new RegExp(`(^|\\s)${word}(\\s|$)`, 'm'));
    }
    expect(stdout).toContain('install-local [--systemd]');
    expect(stdout).toContain('install-remote <alias> [--node <path>]');
  });
});

describe('usage errors', () => {
  it('rejects no arguments', async () => {
    await expectUsageError(await wtd(), /\S/);
  });

  it('names an unknown command', async () => {
    await expectUsageError(await wtd('frobnicate'), /frobnicate/);
  });

  it.each(['constructor', '__proto__', 'toString'])('treats inherited name %s as an unknown command', async (verb) => {
    await expectUsageError(await wtd(verb), new RegExp(verb));
  });

  it('names an unknown option', async () => {
    await expectUsageError(await wtd('--frob'), /--frob/);
  });

  it.each(['ui', 'hub'])('rejects an argument to %s', async (verb) => {
    await expectUsageError(await wtd(verb, 'extra'), /extra/);
  });

  it('requires an alias for install-remote', async () => {
    await expectUsageError(await wtd('install-remote'), /alias.*required|required.*alias/i);
  });

  it('requires an alias for install-remote even with --node', async () => {
    await expectUsageError(await wtd('install-remote', '--node', '/usr/bin/node'), /alias.*required|required.*alias/i);
  });

  it('names --systemd as unknown for install-remote', async () => {
    await expectUsageError(await wtd('install-remote', 'box', '--systemd'), /--systemd.*install-remote|install-remote.*--systemd/);
  });

  it('names --node as unknown for install-local', async () => {
    await expectUsageError(await wtd('install-local', '--node', '/usr/bin/node'), /--node.*install-local|install-local.*--node/);
  });

  it.each(['ui', 'hub', 'daemon', 'connect'])('names --node and --systemd as unknown for %s', async (verb) => {
    await expectUsageError(await wtd(verb, '--systemd'), /--systemd/);
    await expectUsageError(await wtd(verb, '--node', '/n'), /--node/);
  });

  it('requires a value for --node', async () => {
    await expectUsageError(await wtd('install-remote', 'box', '--node'), /--node.*value|value.*--node/i);
  });

  it('refuses --systemd with a value', async () => {
    await expectUsageError(await wtd('install-local', '--systemd=yes'), /--systemd/);
  });

  it('refuses a second alias', async () => {
    await expectUsageError(await wtd('install-remote', 'box', 'other'), /other/);
  });
});
