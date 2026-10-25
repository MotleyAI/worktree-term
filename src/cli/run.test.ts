import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as hubMain from '../hub/main/index.js';
import { runCli } from './run.js';

const PRINTED = '{"port":7417,"code":"' + 'a'.repeat(64) + '"}\n';

const ui = vi.hoisted(() => ({ openUi: vi.fn<typeof hubMain.openUi>(), printCode: vi.fn<typeof hubMain.printCode>() }));

vi.mock('../hub/main/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof hubMain>()),
  openUi: ui.openUi,
  printCode: ui.printCode,
}));

beforeEach(() => {
  ui.openUi.mockReset().mockResolvedValue(undefined);
  ui.printCode.mockReset().mockResolvedValue(PRINTED);
});

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
      stdout: `wtd ${packageVersion()} (daemon protocol 7, browser protocol 11)\n`,
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
    expect(stdout).toContain('ui [<host>] [--print-code]');
  });
});

describe('wtd ui', () => {
  it('opens the UI for this machine without a host', async () => {
    expect(await wtd('ui')).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(ui.openUi).toHaveBeenCalledOnce();
    expect(ui.openUi.mock.calls[0]?.[0]).toMatchObject({ host: null });
    expect(ui.printCode).not.toHaveBeenCalled();
  });

  it('opens the UI switched to the named host', async () => {
    expect(await wtd('ui', 'box')).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(ui.openUi).toHaveBeenCalledOnce();
    expect(ui.openUi.mock.calls[0]?.[0]).toMatchObject({ host: 'box' });
  });

  it('prints the code line with --print-code, opening no browser', async () => {
    expect(await wtd('ui', '--print-code')).toEqual({ code: 0, stdout: PRINTED, stderr: '' });
    expect(ui.printCode).toHaveBeenCalledOnce();
    expect(ui.printCode.mock.calls[0]?.[0]).not.toHaveProperty('browser');
    expect(ui.openUi).not.toHaveBeenCalled();
  });

  it('reports an unknown host on one line and exits 1', async () => {
    ui.openUi.mockRejectedValue(new Error('no host named nope in /c/config.json'));
    expect(await wtd('ui', 'nope')).toEqual({ code: 1, stdout: '', stderr: 'wtd ui: no host named nope in /c/config.json\n' });
  });

  it('reports a failed print on one line and exits 1', async () => {
    ui.printCode.mockRejectedValue(new Error('the hub did not start; see /s/hub.log'));
    expect(await wtd('ui', '--print-code')).toEqual({ code: 1, stdout: '', stderr: 'wtd ui: the hub did not start; see /s/hub.log\n' });
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

  it('rejects an argument to hub', async () => {
    await expectUsageError(await wtd('hub', 'extra'), /extra/);
  });

  it('rejects a second host for ui, naming it', async () => {
    await expectUsageError(await wtd('ui', 'a', 'b'), /'b'/);
    expect(ui.openUi).not.toHaveBeenCalled();
  });

  it.each([
    ['ui', 'box', '--print-code'],
    ['ui', '--print-code', 'box'],
  ])('refuses a host combined with --print-code: %s %s %s', async (...argv) => {
    await expectUsageError(await wtd(...argv), /cannot be combined/);
    const result = await wtd(...argv);
    expect(result.stderr).toContain('--print-code');
    expect(ui.openUi).not.toHaveBeenCalled();
    expect(ui.printCode).not.toHaveBeenCalled();
  });

  it.each([['hub'], ['daemon'], ['connect'], ['install-local'], ['install-remote', 'box']])(
    'names --print-code as unknown for %s',
    async (...argv) => {
      await expectUsageError(await wtd(...argv, '--print-code'), /--print-code/);
    },
  );

  it('refuses --print-code with a value', async () => {
    await expectUsageError(await wtd('ui', '--print-code=x'), /--print-code/);
    expect(ui.printCode).not.toHaveBeenCalled();
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
