import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DaemonClient } from '../support/daemon-client.js';
import { BUNDLE, canConnect, DaemonHost, makeRepo, waitUntil, type Exit } from '../support/daemon-host.js';
import {
  daemonPidsOf,
  desktopExec,
  desktopString,
  directoryModes,
  expectOneLine,
  fakeSystemctl,
  iniGroup,
  installPaths,
  killAll,
  nodeAt,
  packageVersion,
  PTY_PACKAGE,
  releasesIn,
  systemctlCalls,
  systemdExec,
  treeSnapshot,
  UNIT_NAME,
  WM_CLASS,
} from './install-helpers.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 30_000 });

let host: DaemonHost;
const clients: DaemonClient[] = [];

beforeEach(() => {
  host = DaemonHost.create();
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await killAll(() => daemonPidsOf(host.stateHome));
  await host.cleanup();
});

interface Run {
  exit: Exit;
  stdout: string;
  stderr: string;
}

/** Runs `wtd install-local [args]` with this host's environment plus `env`. */
const installLocal = async (args: readonly string[] = [], env: Record<string, string | undefined> = {}): Promise<Run> => {
  const run = host.wtd(['install-local', ...args], env).captureStdout();
  const exit = await run.exited;
  return { exit, stdout: run.stdout, stderr: run.stderr };
};

const expectInstalled = (run: Run): void => {
  if (run.exit.code !== 0) throw new Error(`install-local failed: ${run.stderr}`);
};

/** Runs the installed shim of `home` with `args`, synchronously. */
const shim = (
  home: string,
  args: readonly string[],
  env: Record<string, string | undefined> = {},
): { status: number | null; stdout: string; stderr: string } => {
  const result = spawnSync(installPaths(home).shim, args, { env: host.env({ HOME: home, ...env }), encoding: 'utf8', timeout: 30_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

/** Starts `<shim> daemon` detached and waits for the socket. */
const shimDaemon = async (home: string): Promise<void> => {
  const child = spawn(installPaths(home).shim, ['daemon'], { env: host.env({ HOME: home }), stdio: 'ignore', detached: true });
  child.unref();
  await waitUntil(() => canConnect(host.socket), 'the daemon started through the shim', 10_000);
};

const client = async (): Promise<DaemonClient> => {
  const connected = await DaemonClient.connect(host.socket);
  clients.push(connected);
  await connected.handshake();
  return connected;
};

describe('wtd install-local', () => {
  it('installs a release, points current at it and writes a shim that runs it', async () => {
    const run = await installLocal();
    expectInstalled(run);
    const paths = installPaths(host.home);
    const version = packageVersion();
    expectOneLine(run.stdout);
    expect(run.stdout).toContain(version);
    expect(run.stdout).toContain(paths.dataDir);
    const [release, ...others] = releasesIn(paths.versions);
    expect(others).toEqual([]);
    expect(release).toMatch(new RegExp(`^${version.replaceAll('.', '\\.')}-[0-9a-f]{12}$`));
    expect(lstatSync(paths.current).isSymbolicLink()).toBe(true);
    expect(readlinkSync(paths.current).replace(/\/$/, '')).toMatch(new RegExp(`(^|/)versions/${release ?? ''}$`));
    const dir = join(paths.versions, release ?? '');
    for (const file of ['wtd.mjs', join('web', 'index.html'), join('web', 'icon.svg')]) {
      expect(existsSync(join(dir, file)), file).toBe(true);
    }
    expect(readdirSync(join(dir, PTY_PACKAGE)).sort()).toEqual(['LICENSE', 'lib', 'package.json', 'prebuilds']);
    expect(readdirSync(join(dir, PTY_PACKAGE, 'prebuilds')).length).toBeGreaterThan(0);
    expect(shim(host.home, ['--version'])).toEqual({ status: 0, stdout: `wtd ${version} (protocol 5)\n`, stderr: '' });
  });

  it('writes the shim as an owner-only POSIX shell script running the installing Node by absolute path', async () => {
    expectInstalled(await installLocal());
    const { shim: path } = installPaths(host.home);
    expect(lstatSync(path).isFile()).toBe(true);
    expect(lstatSync(path).mode & 0o777).toBe(0o700);
    const text = readFileSync(path, 'utf8');
    expect(text.split('\n', 1)[0]).toBe('#!/bin/sh');
    expect(text).toContain(process.execPath);
    expect(text).toContain('$HOME/.local/share/worktree-term/current/wtd.mjs');
  });

  it('creates the directories it needs owner-only', async () => {
    expectInstalled(await installLocal());
    const local = join(host.home, '.local');
    for (const [path, mode] of directoryModes(local)) expect(mode.toString(8), path).toBe('700');
  });

  it('leaves existing parent directories as they are', async () => {
    const bin = join(host.home, '.local', 'bin');
    const share = join(host.home, '.local', 'share');
    mkdirSync(bin, { recursive: true });
    mkdirSync(share, { recursive: true });
    chmodSync(join(host.home, '.local'), 0o755);
    chmodSync(bin, 0o755);
    chmodSync(share, 0o750);
    expectInstalled(await installLocal());
    expect(lstatSync(join(host.home, '.local')).mode & 0o777).toBe(0o755);
    expect(lstatSync(bin).mode & 0o777).toBe(0o755);
    expect(lstatSync(share).mode & 0o777).toBe(0o750);
    expect(lstatSync(installPaths(host.home).dataDir).mode & 0o777).toBe(0o700);
  });

  it('runs a Node whose path holds a space, a quote, $ and %', async () => {
    const dir = join(host.dir, `n o'd$e%x`);
    mkdirSync(dir);
    const node = nodeAt(dir);
    const install = spawnSync(node, [BUNDLE, 'install-local'], { env: host.env(), encoding: 'utf8', timeout: 60_000 });
    expect(install.status, install.stderr).toBe(0);
    expect(readFileSync(installPaths(host.home).shim, 'utf8')).not.toContain(process.execPath);
    await shimDaemon(host.home);
    const pid = await waitUntil(() => daemonPidsOf(host.stateHome)[0], 'the shim daemon');
    expect(readlinkSync(`/proc/${String(pid)}/exe`)).toBe(node);
    expect(shim(host.home, ['--version']).stdout).toBe(`wtd ${packageVersion()} (protocol 5)\n`);
  });
});

describe('launcher', () => {
  it.each([
    ['a space', 'my home'],
    ['quotes, $, %, a backquote and a backslash', `h "o'm$e %x \`y\\z`],
  ])('writes an owner-only desktop entry whose Exec runs the shim with ui, for a home with %s', async (_name, base) => {
    const home = join(host.dir, base);
    mkdirSync(home);
    expectInstalled(await installLocal([], { HOME: home }));
    const paths = installPaths(home);
    expect(lstatSync(paths.launcher).mode & 0o777).toBe(0o600);
    const entry = iniGroup(readFileSync(paths.launcher, 'utf8'), 'Desktop Entry');
    expect(entry.get('Type')).toBe('Application');
    expect(entry.get('Name')).toBe('worktree-term');
    expect(entry.get('Terminal')).toBe('false');
    expect(desktopExec(entry.get('Exec') ?? '')).toEqual([paths.shim, 'ui']);
    expect(desktopString(entry.get('Icon') ?? '')).toBe(join(paths.current, 'web', 'icon.svg'));
    expect(entry.get('StartupWMClass')).toBe(WM_CLASS);
  });

  it('runs a launcher Exec that reaches the installed wtd', async () => {
    const home = join(host.dir, 'my home');
    mkdirSync(home);
    expectInstalled(await installLocal([], { HOME: home }));
    const [program, ...args] = desktopExec(iniGroup(readFileSync(installPaths(home).launcher, 'utf8'), 'Desktop Entry').get('Exec') ?? '');
    const result = spawnSync(program ?? '', [...args.slice(0, -1), '--version'], { env: host.env({ HOME: home }), encoding: 'utf8' });
    expect(result.stdout).toBe(`wtd ${packageVersion()} (protocol 5)\n`);
  });

  it('writes no unit file without --systemd', async () => {
    expectInstalled(await installLocal());
    expect(existsSync(installPaths(host.home).unit)).toBe(false);
  });
});

describe('--systemd', () => {
  let log: string;

  beforeEach(() => {
    log = join(host.dir, 'systemctl.log');
  });

  const withSystemctl = (failOn: string | null = null): Record<string, string> => ({ WTD_SYSTEMCTL: fakeSystemctl(host.dir, log, failOn) });

  it('writes the unit, reloads, enables and starts it when no daemon runs', async () => {
    const run = await installLocal(['--systemd'], withSystemctl());
    expectInstalled(run);
    expect(systemctlCalls(log)).toEqual([
      ['--user', 'daemon-reload'],
      ['--user', 'enable', UNIT_NAME],
      ['--user', 'start', UNIT_NAME],
    ]);
    await waitUntil(() => canConnect(host.socket), 'the daemon the unit started', 10_000);
    expect((await (await client()).waitFor('hello')).protocol).toBe(5);
  });

  it('writes an owner-only unit running the shim with daemon, restarting on failure, for default.target', async () => {
    const home = join(host.dir, `my $home %x`);
    mkdirSync(home);
    expectInstalled(await installLocal(['--systemd'], { HOME: home, ...withSystemctl() }));
    const paths = installPaths(home);
    expect(lstatSync(paths.unit).mode & 0o777).toBe(0o600);
    const text = readFileSync(paths.unit, 'utf8');
    const service = iniGroup(text, 'Service');
    expect(systemdExec(service.get('ExecStart') ?? '')).toEqual([paths.shim, 'daemon']);
    expect(service.get('Restart')).toBe('on-failure');
    expect(iniGroup(text, 'Install').get('WantedBy')).toBe('default.target');
  });

  it('puts the unit under an absolute XDG_CONFIG_HOME', async () => {
    const configHome = join(host.dir, 'c');
    expectInstalled(await installLocal(['--systemd'], { XDG_CONFIG_HOME: configHome, ...withSystemctl() }));
    expect(existsSync(installPaths(host.home, configHome).unit)).toBe(true);
    expect(existsSync(installPaths(host.home).unit)).toBe(false);
  });

  it('ignores a relative XDG_CONFIG_HOME', async () => {
    expectInstalled(await installLocal(['--systemd'], { XDG_CONFIG_HOME: 'rel/dir', ...withSystemctl() }));
    expect(existsSync(installPaths(host.home).unit)).toBe(true);
  });

  it('enables the unit but leaves a running daemon alone', async () => {
    await host.start();
    const before = await client();
    const instance = (await before.waitFor('hello')).instance;
    const pids = daemonPidsOf(host.stateHome);
    expectInstalled(await installLocal(['--systemd'], withSystemctl()));
    expect(systemctlCalls(log)).toEqual([
      ['--user', 'daemon-reload'],
      ['--user', 'enable', UNIT_NAME],
    ]);
    expect(daemonPidsOf(host.stateHome)).toEqual(pids);
    expect((await (await client()).waitFor('hello')).instance).toBe(instance);
  });

  it.each(['daemon-reload', 'enable'])('fails with one line naming the command when systemctl %s fails', async (subcommand) => {
    const run = await installLocal(['--systemd'], withSystemctl(subcommand));
    expect(run.exit).toEqual({ code: 1, signal: null });
    expectOneLine(run.stderr);
    expect(run.stderr).toContain(subcommand);
  });
});

describe('reinstalling', () => {
  it('installs the same version into a new release, keeping the first', async () => {
    const paths = installPaths(host.home);
    expectInstalled(await installLocal());
    const first = readlinkSync(paths.current);
    expectInstalled(await installLocal());
    const second = readlinkSync(paths.current);
    expect(second).not.toBe(first);
    expect(releasesIn(paths.versions)).toHaveLength(2);
  });

  it('keeps only the releases of the last two installations', async () => {
    const paths = installPaths(host.home);
    const targets: string[] = [];
    for (let i = 0; i < 3; i++) {
      expectInstalled(await installLocal()); // NOSONAR(S9382) — installations run one after the other
      targets.push(readlinkSync(paths.current).split('/').pop() ?? '');
    }
    expect(releasesIn(paths.versions)).toEqual(targets.slice(1).sort());
  });

  it('keeps a daemon started from the first release working across two reinstalls', async () => {
    const repo = makeRepo(join(host.dir, 'repo'));
    expectInstalled(await installLocal());
    await shimDaemon(host.home);
    const pids = daemonPidsOf(host.stateHome);
    const before = await client();
    const instance = (await before.waitFor('hello')).instance;
    expectInstalled(await installLocal());
    expectInstalled(await installLocal());
    expect(daemonPidsOf(host.stateHome)).toEqual(pids);
    const after = await client();
    expect((await after.waitFor('hello')).instance).toBe(instance);
    await after.watch(repo);
    const term = await after.create(repo, { command: 'echo after-reinstall; exec sleep 60' });
    await after.attach(term.termId);
    await after.waitOutput(term.termId, 'after-reinstall');
    expect(shim(host.home, ['--version']).stdout).toBe(`wtd ${packageVersion()} (protocol 5)\n`);
  });

  it('runs the newest release through the shim after a reinstall', async () => {
    const paths = installPaths(host.home);
    expectInstalled(await installLocal());
    expectInstalled(await installLocal());
    const newest = readlinkSync(paths.current).split('/').pop() ?? '';
    const child = spawn(paths.shim, ['daemon'], { env: host.env(), stdio: 'ignore', detached: true });
    child.unref();
    const pid = await waitUntil(() => daemonPidsOf(host.stateHome)[0], 'the shim daemon', 10_000);
    const script = readFileSync(`/proc/${String(pid)}/cmdline`, 'utf8').split('\0')[1] ?? '';
    expect(script === join(paths.current, 'wtd.mjs') || script.includes(`/versions/${newest}/`)).toBe(true);
  });
});

describe('refusals', () => {
  /** Asserts the installation failed naming `path` and changed nothing in the home. */
  const expectRefused = async (path: string): Promise<void> => {
    const before = treeSnapshot(host.home);
    const run = await installLocal();
    expect(run.exit).toEqual({ code: 1, signal: null });
    expectOneLine(run.stderr);
    expect(run.stderr).toContain(path);
    expect(treeSnapshot(host.home)).toEqual(before);
  };

  it('refuses a planted symbolic link for versions/, writing nothing', async () => {
    const elsewhere = join(host.dir, 'elsewhere');
    mkdirSync(elsewhere);
    const { dataDir, versions } = installPaths(host.home);
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    symlinkSync(elsewhere, versions);
    await expectRefused(versions);
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it('refuses a symbolic link for the data directory', async () => {
    const elsewhere = join(host.dir, 'elsewhere');
    mkdirSync(elsewhere);
    const { dataDir } = installPaths(host.home);
    mkdirSync(join(dataDir, '..'), { recursive: true });
    symlinkSync(elsewhere, dataDir);
    await expectRefused(dataDir);
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it('refuses a file where the data directory belongs', async () => {
    const { dataDir } = installPaths(host.home);
    mkdirSync(join(dataDir, '..'), { recursive: true });
    writeFileSync(dataDir, 'not a directory');
    await expectRefused(dataDir);
  });

  it('refuses a directory where the shim belongs', async () => {
    const { shim: path } = installPaths(host.home);
    mkdirSync(path, { recursive: true });
    await expectRefused(path);
  });

  it('refuses a symbolic link where the shim belongs', async () => {
    const { shim: path } = installPaths(host.home);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(join(host.dir, 'target'), '');
    symlinkSync(join(host.dir, 'target'), path);
    await expectRefused(path);
  });

  it('refuses a directory where current belongs', async () => {
    const { current } = installPaths(host.home);
    mkdirSync(current, { recursive: true, mode: 0o700 });
    await expectRefused(current);
  });

  it('refuses a symbolic link where the launcher belongs', async () => {
    const { launcher } = installPaths(host.home);
    mkdirSync(join(launcher, '..'), { recursive: true });
    writeFileSync(join(host.dir, 'target'), '');
    symlinkSync(join(host.dir, 'target'), launcher);
    await expectRefused(launcher);
  });
});
