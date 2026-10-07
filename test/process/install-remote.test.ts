import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION } from '../../src/protocol/index.js';
import { DaemonClient } from '../support/daemon-client.js';
import { DaemonHost, waitUntil } from '../support/daemon-host.js';
import { REPO_ROOT } from '../support/exec.js';
import { currentNodeDir, FakeSsh, oldNodeDir, runInstallRemote, shellQuote, type FakeRemote } from '../support/fake-ssh.js';
import { expectOneLine, installPaths, PTY_PACKAGE, packageVersion, treeSnapshot } from './install-helpers.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 30_000 });

const CONNECT = '"$HOME/.local/bin/wtd" connect';

let host: DaemonHost;
let ssh: FakeSsh;
const clients: DaemonClient[] = [];

beforeEach(() => {
  host = DaemonHost.create();
  ssh = new FakeSsh(join(host.dir, 'ssh'));
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await ssh.cleanup();
  await host.cleanup();
});

/** Runs `"$HOME/.local/bin/wtd" connect` on `alias` through the fake SSH and speaks the protocol over it. */
const remoteConnect = (alias: string): DaemonClient => {
  const child = spawn(ssh.program, ['--', alias, CONNECT], { stdio: 'pipe' });
  const client = DaemonClient.over(child.stdout, child.stdin);
  clients.push(client);
  return client;
};

/** A remote `box` whose login shell (bash) puts `nodeDir` first on its PATH. */
const withLoginNode = (remote: FakeRemote, nodeDir: string): void => {
  writeFileSync(join(remote.home, '.profile'), `PATH=${shellQuote(nodeDir)}:"$PATH"\nexport PATH\necho 'profile noise on stdout'\n`);
};

/** Asserts the remote holds one complete release of this version, without launcher or unit file. */
const expectRemoteLayout = (remote: FakeRemote): void => {
  const version = packageVersion();
  const [release, ...others] = remote.releases();
  expect(others).toEqual([]);
  expect(release).toMatch(new RegExp(`^${version.replaceAll('.', '\\.')}-[0-9a-f]{12}$`));
  expect(remote.current()?.replace(/\/$/, '')).toMatch(new RegExp(`(^|/)versions/${release ?? ''}$`));
  const dir = join(remote.dataDir, 'versions', release ?? '');
  for (const file of ['wtd.mjs', join('web', 'index.html')]) expect(existsSync(join(dir, file)), file).toBe(true);
  expect(readdirSync(join(dir, PTY_PACKAGE)).sort()).toEqual(['LICENSE', 'lib', 'package.json', 'prebuilds']);
  expect(readFileSync(remote.shim, 'utf8').split('\n', 1)[0]).toBe('#!/bin/sh');
  const paths = installPaths(remote.home);
  expect(existsSync(paths.launcher)).toBe(false);
  expect(existsSync(paths.unit)).toBe(false);
};

/** Asserts `alias` bridges to a daemon of this version run by the Node at `node`. */
const expectBridged = async (alias: string, remote: FakeRemote, node: string): Promise<void> => {
  const hello = await remoteConnect(alias).waitFor('hello', () => true, { timeout: 15_000 });
  expect(hello.protocol).toBe(PROTOCOL_VERSION);
  expect(hello.version).toBe(packageVersion());
  const [pid, ...others] = await waitUntil(() => {
    const pids = remote.daemonPids();
    return pids.length > 0 ? pids : undefined;
  }, 'the remote daemon');
  expect(others).toEqual([]);
  expect(readlinkSync(`/proc/${String(pid)}/exe`)).toBe(realpathSync(node));
};

/** Expected SSH arguments for `alias`, up to and including the alias. */
const sshOptions = (alias: string): string[] => [
  '-o',
  'BatchMode=yes',
  '-o',
  'ConnectTimeout=10',
  '-o',
  'ControlMaster=auto',
  '-o',
  'ControlPersist=10m',
  '-o',
  `ControlPath=${join(host.runDir, 'ssh-%C')}`,
  '-o',
  'ServerAliveInterval=15',
  '--',
  alias,
];

describe('wtd install-remote', () => {
  it('installs with the Node given by --node and names the version and the alias', async () => {
    const remote = ssh.addHost('box');
    const run = await runInstallRemote(host, ssh, 'box', ['--node', process.execPath]);
    expect(run.exit, run.stderr).toEqual({ code: 0, signal: null });
    expectOneLine(run.stdout);
    expect(run.stdout).toContain(packageVersion());
    expect(run.stdout).toContain('box');
    expectRemoteLayout(remote);
    expect(readFileSync(remote.shim, 'utf8')).toContain(process.execPath);
    await expectBridged('box', remote, process.execPath);
  });

  it('finds Node on the command’s PATH', async () => {
    const nodeDir = currentNodeDir(join(host.dir, 'path-node'));
    const remote = ssh.addHost('box', { path: `${nodeDir}:${ssh.pathWithoutNode}` });
    const run = await runInstallRemote(host, ssh, 'box', []);
    expect(run.exit, run.stderr).toEqual({ code: 0, signal: null });
    expectRemoteLayout(remote);
    await expectBridged('box', remote, join(nodeDir, 'node'));
  });

  it('finds Node 22 only in the login shell’s PATH, ignoring profile noise', async () => {
    const nodeDir = currentNodeDir(join(host.dir, 'login-node'));
    const remote = ssh.addHost('box', { shell: '/bin/bash' });
    withLoginNode(remote, nodeDir);
    const run = await runInstallRemote(host, ssh, 'box', []);
    expect(run.exit, run.stderr).toEqual({ code: 0, signal: null });
    expectRemoteLayout(remote);
    expect(readFileSync(remote.shim, 'utf8')).toMatch(
      new RegExp(`${nodeDir.replaceAll('/', '\\/')}\\/node|${process.execPath.replaceAll('/', '\\/')}`),
    );
    await expectBridged('box', remote, join(nodeDir, 'node'));
  });

  it('passes over Node 18 on the command’s PATH for the login shell’s Node 22', async () => {
    const old = oldNodeDir(join(host.dir, 'old-node'));
    const nodeDir = currentNodeDir(join(host.dir, 'login-node'));
    const remote = ssh.addHost('box', { path: `${old}:${ssh.pathWithoutNode}`, shell: '/bin/bash' });
    withLoginNode(remote, nodeDir);
    const run = await runInstallRemote(host, ssh, 'box', []);
    expect(run.exit, run.stderr).toEqual({ code: 0, signal: null });
    expect(readFileSync(remote.shim, 'utf8')).not.toContain(old);
    await expectBridged('box', remote, join(nodeDir, 'node'));
  });

  it('runs a given Node whose path holds a space, quotes, $, % and a backslash', async () => {
    const dir = join(host.dir, `n o'd$e%x "y\\z`);
    mkdirSync(dir);
    symlinkSync(process.execPath, join(dir, 'node'));
    const remote = ssh.addHost('box');
    const run = await runInstallRemote(host, ssh, 'box', ['--node', join(dir, 'node')]);
    expect(run.exit, run.stderr).toEqual({ code: 0, signal: null });
    await expectBridged('box', remote, join(dir, 'node'));
  });

  it('runs every SSH command with the fixed options and a fixed remote command carrying no values', async () => {
    ssh.addHost('box');
    const nodeDir = join(host.dir, 'other node');
    mkdirSync(nodeDir);
    symlinkSync(process.execPath, join(nodeDir, 'node'));
    expect((await runInstallRemote(host, ssh, 'box', ['--node', process.execPath])).exit.code).toBe(0);
    expect((await runInstallRemote(host, ssh, 'box', ['--node', join(nodeDir, 'node')])).exit.code).toBe(0);
    const calls = ssh.calls();
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const call of calls) {
      expect(call.args).toEqual([...sshOptions('box'), call.command]);
      const quoted = [...call.command.matchAll(/'([^']*)'/g)].map((m) => m[1] ?? '');
      expect(quoted.length).toBeGreaterThan(0);
      for (const part of quoted) expect(part).not.toMatch(/["\\]/);
      expect(call.command.replaceAll(/'[^']*'/g, '')).not.toMatch(/['"\\]/);
      expect(call.command).not.toContain(packageVersion());
      expect(call.command).not.toContain(process.execPath);
      expect(call.command).not.toContain('other node');
    }
    expect(new Set(calls.map((call) => call.command)).size).toBe(1);
  });

  it('treats a hostile --node as data', async () => {
    const remote = ssh.addHost('box');
    const hostile = "/opt/n'; touch x; '/node";
    const run = await runInstallRemote(host, ssh, 'box', ['--node', hostile]);
    expect(run.exit).toEqual({ code: 1, signal: null });
    expectOneLine(run.stderr);
    expect(run.stderr).toContain(hostile);
    expect(run.stderr).toMatch(/node/i);
    expect(treeSnapshot(remote.home).filter((entry) => /(^|\/)x /.test(entry))).toEqual([]);
    expect(existsSync(join(REPO_ROOT, 'x'))).toBe(false);
    expect(existsSync(join(host.dir, 'x'))).toBe(false);
    expect(existsSync(remote.shim)).toBe(false);
    expect(existsSync(remote.dataDir)).toBe(false);
  });

  it.each([
    ['a relative path', 'bin/node'],
    ['a path with a newline', '/opt/node\n/bin/sh'],
  ])('refuses %s for --node', async (_name, node) => {
    const remote = ssh.addHost('box');
    const run = await runInstallRemote(host, ssh, 'box', ['--node', node]);
    expect(run.exit).toEqual({ code: 1, signal: null });
    expectOneLine(run.stderr);
    expect(run.stdout).toBe('');
    expect(existsSync(remote.dataDir)).toBe(false);
  });

  it('refuses a remote system other than Linux, changing nothing', async () => {
    // The remote side tells the system by `uname -s`, which this remote's PATH answers with Darwin.
    const bin = join(host.dir, 'darwin-bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'uname'), '#!/bin/sh\necho Darwin\n', { mode: 0o755 });
    const remote = ssh.addHost('box', { path: `${bin}:${currentNodeDir(join(host.dir, 'node-dir'))}:${ssh.pathWithoutNode}` });
    const before = treeSnapshot(remote.home);
    const run = await runInstallRemote(host, ssh, 'box');
    expect(run.exit).toEqual({ code: 1, signal: null });
    expectOneLine(run.stderr);
    expect(run.stderr).toMatch(/linux|darwin/i);
    expect(treeSnapshot(remote.home)).toEqual(before);
  });

  it('refuses a given Node older than 20', async () => {
    const remote = ssh.addHost('box');
    const run = await runInstallRemote(host, ssh, 'box', ['--node', join(oldNodeDir(join(host.dir, 'old')), 'node')]);
    expect(run.exit).toEqual({ code: 1, signal: null });
    expectOneLine(run.stderr);
    expect(run.stderr).toMatch(/node/i);
    expect(existsSync(remote.dataDir)).toBe(false);
  });

  it.each([
    ['no Node', false],
    ['only Node 18', true],
  ])('fails with one line naming the alias and the missing Node when the remote has %s, leaving it unchanged', async (_name, old) => {
    const path = old ? `${oldNodeDir(join(host.dir, 'old'))}:${ssh.pathWithoutNode}` : ssh.pathWithoutNode;
    const remote = ssh.addHost('box', { path });
    const before = treeSnapshot(join(remote.home, '.local'));
    const run = await runInstallRemote(host, ssh, 'box', []);
    expect(run.exit).toEqual({ code: 1, signal: null });
    expect(run.stdout).toBe('');
    expectOneLine(run.stderr);
    expect(run.stderr).toContain('box');
    expect(run.stderr).toMatch(/node/i);
    expect(treeSnapshot(join(remote.home, '.local'))).toEqual(before);
    expect(existsSync(remote.shim)).toBe(false);
  });

  it('keeps the previous installation when the new one fails for want of Node', async () => {
    const remote = ssh.addHost('box');
    expect((await runInstallRemote(host, ssh, 'box', ['--node', process.execPath])).exit.code).toBe(0);
    const before = treeSnapshot(join(remote.home, '.local'));
    expect((await runInstallRemote(host, ssh, 'box', [])).exit.code).toBe(1);
    expect(treeSnapshot(join(remote.home, '.local'))).toEqual(before);
  });

  it('fails with SSH’s last error line when the host cannot be reached', async () => {
    const run = await runInstallRemote(host, ssh, 'nowhere', ['--node', process.execPath]);
    expect(run.exit).toEqual({ code: 1, signal: null });
    expect(run.stdout).toBe('');
    expectOneLine(run.stderr);
    expect(run.stderr).toContain('ssh: Could not resolve hostname nowhere: Name or service not known');
  });

  it('reports the last line SSH wrote when it fails', async () => {
    ssh.failHost('box', 'ssh: connect to host box port 22: Connection refused');
    const run = await runInstallRemote(host, ssh, 'box', ['--node', process.execPath]);
    expect(run.exit).toEqual({ code: 1, signal: null });
    expectOneLine(run.stderr);
    expect(run.stderr).toContain('ssh: connect to host box port 22: Connection refused');
  });

  it('refuses an option-like alias without running SSH', async () => {
    const run = host.wtd(['install-remote', '--node', process.execPath, '--', '-oProxyCommand=touch x'], { WTD_SSH: ssh.program });
    expect((await run.exited).code).not.toBe(0);
    expect(run.stderr).toContain('-oProxyCommand=touch x');
    expect(ssh.calls()).toEqual([]);
  });

  it('replaces a previous remote release and keeps the one before', async () => {
    const remote = ssh.addHost('box');
    for (let i = 0; i < 3; i++) {
      expect((await runInstallRemote(host, ssh, 'box', ['--node', process.execPath])).exit.code).toBe(0); // NOSONAR(S9382) — installations run one after the other
    }
    expect(remote.releases()).toHaveLength(2);
    expect(remote.releases()).toContain(remote.current()?.split('/').pop());
  });
});
