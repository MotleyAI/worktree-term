import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeSshfs } from '../../../test/support/fake-sshfs.js';
import { sshCommand } from '../dialer/index.js';
import { hostPaths, sshControlPath, type HostPaths } from '../files/index.js';
import {
  listMounts,
  mount,
  mountCommand,
  mountDir,
  MountError,
  mountPoint,
  removeLeftovers,
  unmount,
  unmountCommand,
  type MountTarget,
} from './index.js';

const BOX_A: MountTarget = { host: 'box', alias: 'box', path: '/srv/a' };
const KEEP_ALIVE = 'reconnect,ServerAliveInterval=15,ServerAliveCountMax=3';
const OPTION_LIKE = '-oProxyCommand=touch /tmp/x';

let dir: string;
let paths: HostPaths;
let fake: FakeSshfs;

/** Points the mount code at the fake programs and mount table. */
const useFake = (): void => {
  for (const [name, value] of Object.entries(fake.env)) vi.stubEnv(name, value);
};

/** An executable shell script standing in for a program. */
const script = (name: string, body: string): string => {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
};

const failure = async (operation: Promise<unknown>): Promise<MountError> => {
  const error: unknown = await operation.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(MountError);
  if (!(error instanceof MountError)) throw new Error('not a MountError');
  return error;
};

const entries = (path: string): string[] => (existsSync(path) ? readdirSync(path) : []);

const modeOf = (path: string): number => statSync(path).mode & 0o777;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wtd-mounts-'));
  paths = hostPaths({ env: { XDG_STATE_HOME: join(dir, 'state') }, home: '/nonexistent', host: 'box' });
  fake = new FakeSshfs(join(dir, 'fake'));
  vi.stubEnv('WTD_SSH', undefined);
  vi.stubEnv('WTD_SSHFS', undefined);
  vi.stubEnv('WTD_FUSERMOUNT', undefined);
  vi.stubEnv('WTD_MOUNTINFO', undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('mountPoint', () => {
  it('lives in run/mounts under the state directory', () => {
    expect(mountDir(paths)).toBe(join(paths.stateDir, 'run', 'mounts'));
  });

  it('gives each host, alias and path a distinct directory named by 32 hex digits under run/mounts', () => {
    const points = [BOX_A, { ...BOX_A, path: '/srv/b' }, { ...BOX_A, host: 'gpu' }].map((target) => mountPoint(paths, target));
    expect(new Set(points).size).toBe(3);
    for (const point of points) {
      expect(point.startsWith(`${mountDir(paths)}/`)).toBe(true);
      expect(point.slice(mountDir(paths).length + 1)).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it('names the directory by the first 32 hex digits of the SHA-256 of host, alias and path joined by NUL', () => {
    const target: MountTarget = { host: 'gpu', alias: 'user@gpu.example.org', path: '/srv/a b' };
    const id = createHash('sha256').update('gpu\0user@gpu.example.org\0/srv/a b').digest('hex').slice(0, 32);
    expect(mountPoint(paths, target)).toBe(join(mountDir(paths), id));
  });

  it('keeps targets apart that would join to the same text without the NUL separators', () => {
    expect(mountPoint(paths, { host: 'ab', alias: 'c', path: '/x' })).not.toBe(mountPoint(paths, { host: 'a', alias: 'bc', path: '/x' }));
  });
});

describe('mountCommand', () => {
  const sshPart = (): string => sshCommand(paths, 'box', 'x').slice(0, -3).join(' ');

  it('puts the keep-alive options, ssh_command, the source as one argument and the mount point, in that order', () => {
    const target: MountTarget = { host: 'box', alias: 'box', path: '/srv/a b' };
    expect(mountCommand(paths, target)).toEqual([
      'sshfs',
      '-o',
      KEEP_ALIVE,
      '-o',
      `ssh_command=${sshPart()}`,
      'box:/srv/a b',
      mountPoint(paths, target),
    ]);
  });

  it('gives ssh_command the SSH program with the dialer options, BatchMode and the control path included', () => {
    const option = mountCommand(paths, BOX_A)[4] ?? '';
    expect(option).toMatch(/^ssh_command=ssh -o /);
    expect(option).toContain('-o BatchMode=yes');
    expect(option).toContain(`-o ControlPath=${sshControlPath(paths)}`);
    expect(option).not.toContain(' -- ');
  });

  it('uses WTD_SSH as the SSH program of ssh_command', () => {
    vi.stubEnv('WTD_SSH', '/opt/fake-ssh');
    expect(mountCommand(paths, BOX_A)[4]).toBe(`ssh_command=${sshPart()}`);
    expect(mountCommand(paths, BOX_A)[4]).toMatch(/^ssh_command=\/opt\/fake-ssh -o /);
  });

  it('runs WTD_SSHFS when set', () => {
    vi.stubEnv('WTD_SSHFS', '/opt/fake sshfs');
    expect(mountCommand(paths, BOX_A)[0]).toBe('/opt/fake sshfs');
  });

  it('runs sshfs when WTD_SSHFS is empty', () => {
    vi.stubEnv('WTD_SSHFS', '');
    expect(mountCommand(paths, BOX_A)[0]).toBe('sshfs');
  });

  it.each([
    ['an option-like alias', OPTION_LIKE],
    ['a space', 'my box'],
    ['an empty alias', ''],
    ['a leading dash', '-box'],
  ])('refuses %s, naming it', (_name, alias) => {
    expect(() => mountCommand(paths, { ...BOX_A, alias })).toThrow(`'${alias}'`);
  });

  it.each([
    ['a space', '/opt/fake ssh'],
    ['a tab', '/opt/fake\tssh'],
    ['a comma', '/opt/fake,ssh'],
    ['a backslash', '/opt/fake\\ssh'],
  ])('refuses an SSH program holding %s, naming it', (_name, program) => {
    vi.stubEnv('WTD_SSH', program);
    expect(() => mountCommand(paths, BOX_A)).toThrow(program);
  });

  it.each([
    ['whitespace', 'a b'],
    ['a comma', 'a,b'],
    ['a backslash', 'a\\b'],
  ])('refuses a control path holding %s, naming it', (_name, state) => {
    const odd = hostPaths({ env: { XDG_STATE_HOME: join(dir, state) }, home: '/nonexistent', host: 'box' });
    expect(() => mountCommand(odd, BOX_A)).toThrow(sshControlPath(odd));
  });
});

describe('unmountCommand', () => {
  it('runs fusermount3 with -u -z and the mount point', () => {
    expect(unmountCommand('/run/x/mounts/abc')).toEqual(['fusermount3', '-u', '-z', '/run/x/mounts/abc']);
  });

  it('runs WTD_FUSERMOUNT when set', () => {
    vi.stubEnv('WTD_FUSERMOUNT', '/opt/fake fusermount');
    expect(unmountCommand('/run/x/mounts/abc')).toEqual(['/opt/fake fusermount', '-u', '-z', '/run/x/mounts/abc']);
  });

  it('runs fusermount3 when WTD_FUSERMOUNT is empty', () => {
    vi.stubEnv('WTD_FUSERMOUNT', '');
    expect(unmountCommand('/run/x/mounts/abc')[0]).toBe('fusermount3');
  });
});

describe('mount', () => {
  beforeEach(useFake);

  it('runs the mount command once and resolves to the mount point once the mount table lists it', async () => {
    const point = await mount(paths, BOX_A);
    expect(point).toBe(mountPoint(paths, BOX_A));
    expect(fake.calls()).toEqual([{ program: 'sshfs', args: mountCommand(paths, BOX_A).slice(1) }]);
    expect(fake.mounted()).toEqual([point]);
  });

  it('creates the mount directory and the mount point owner-only', async () => {
    const point = await mount(paths, BOX_A);
    expect(modeOf(paths.stateDir)).toBe(0o700);
    expect(modeOf(paths.runDir)).toBe(0o700);
    expect(modeOf(mountDir(paths))).toBe(0o700);
    expect(modeOf(point)).toBe(0o700);
  });

  it('tightens a looser mount directory to owner-only', async () => {
    mkdirSync(mountDir(paths), { recursive: true, mode: 0o700 });
    chmodSync(mountDir(paths), 0o755);
    await mount(paths, BOX_A);
    expect(modeOf(mountDir(paths))).toBe(0o700);
  });

  it('mounts onto a leftover mount point directory', async () => {
    mkdirSync(mountPoint(paths, BOX_A), { recursive: true });
    await expect(mount(paths, BOX_A)).resolves.toBe(mountPoint(paths, BOX_A));
    expect(fake.mounted()).toEqual([mountPoint(paths, BOX_A)]);
  });

  it('fails with not mounted and removes the mount point when the program exits 0 but the mount table does not list it', async () => {
    fake.exitUnlisted();
    const error = await failure(mount(paths, BOX_A));
    expect(error.message).toBe('not mounted');
    expect(error.failure).toBe('failed');
    expect(existsSync(mountPoint(paths, BOX_A))).toBe(false);
  });

  it('is not ready when the mount table lists only a path that starts with the mount point', async () => {
    fake.addMount(`${mountPoint(paths, BOX_A)}0`);
    fake.exitUnlisted();
    expect((await failure(mount(paths, BOX_A))).message).toBe('not mounted');
  });

  it('fails with the last non-empty error line and removes the mount point when the program exits 1', async () => {
    fake.failWith('read: Connection reset by peer');
    const error = await failure(mount(paths, BOX_A));
    expect(error.message).toBe('read: Connection reset by peer');
    expect(error.failure).toBe('failed');
    expect(existsSync(mountPoint(paths, BOX_A))).toBe(false);
  });

  it('fails with the last error line after megabytes of error output', async () => {
    vi.stubEnv(
      'WTD_SSHFS',
      script('sshfs-noisy', "head -c 4000000 /dev/zero | tr '\\0' 'x' >&2\necho >&2\necho 'the real reason' >&2\nexit 1"),
    );
    expect((await failure(mount(paths, BOX_A))).message).toBe('the real reason');
  });

  it('fails with the error line, not its standard output, when the program exits 0 without listing the mount point', async () => {
    vi.stubEnv('WTD_SSHFS', script('sshfs-warns', "echo 'on stdout'\necho 'warning: no mount' >&2\necho 'on stdout again'\nexit 0"));
    expect((await failure(mount(paths, BOX_A))).message).toBe('warning: no mount');
    expect(existsSync(mountPoint(paths, BOX_A))).toBe(false);
  });

  it('fails with not mounted when the failing program printed no error line', async () => {
    vi.stubEnv('WTD_SSHFS', script('sshfs-silent', "echo 'on stdout'\nprintf '\\n\\n' >&2\nexit 1"));
    expect((await failure(mount(paths, BOX_A))).message).toBe('not mounted');
    expect(existsSync(mountPoint(paths, BOX_A))).toBe(false);
  });

  it('fails as a missing program naming WTD_SSHFS when it does not exist, removing the mount point', async () => {
    const missing = join(dir, 'no-sshfs');
    vi.stubEnv('WTD_SSHFS', missing);
    const error = await failure(mount(paths, BOX_A));
    expect(error.failure).toBe('missing-program');
    expect(error.program).toBe(missing);
    expect(error.message).toContain(missing);
    expect(existsSync(mountPoint(paths, BOX_A))).toBe(false);
  });

  it('fails as a missing program naming sshfs when it is not on PATH', async () => {
    vi.stubEnv('WTD_SSHFS', '');
    vi.stubEnv('PATH', join(dir, 'empty-bin'));
    const error = await failure(mount(paths, BOX_A));
    expect(error.failure).toBe('missing-program');
    expect(error.program).toBe('sshfs');
    expect(error.message).toContain('sshfs');
  });

  it('fails as a missing program naming the unmount program before mounting, running nothing', async () => {
    const missing = join(dir, 'no-fusermount');
    vi.stubEnv('WTD_FUSERMOUNT', missing);
    const error = await failure(mount(paths, BOX_A));
    expect(error.failure).toBe('missing-program');
    expect(error.program).toBe(missing);
    expect(fake.calls()).toEqual([]);
    expect(entries(mountDir(paths))).toEqual([]);
  });

  it('refuses an option-like alias, naming it, running nothing and creating no mount point', async () => {
    await expect(mount(paths, { ...BOX_A, alias: OPTION_LIKE })).rejects.toThrow(OPTION_LIKE);
    expect(fake.calls()).toEqual([]);
    expect(entries(mountDir(paths))).toEqual([]);
  });

  it('refuses an SSH program holding whitespace, naming it and running nothing', async () => {
    vi.stubEnv('WTD_SSH', '/opt/fake ssh');
    await expect(mount(paths, BOX_A)).rejects.toThrow('/opt/fake ssh');
    expect(fake.calls()).toEqual([]);
    expect(entries(mountDir(paths))).toEqual([]);
  });

  it('refuses a control path holding whitespace, naming it and running nothing', async () => {
    const spaced = hostPaths({ env: { XDG_STATE_HOME: join(dir, 'a b') }, home: '/nonexistent', host: 'box' });
    await expect(mount(spaced, BOX_A)).rejects.toThrow(sshControlPath(spaced));
    expect(fake.calls()).toEqual([]);
    expect(entries(mountDir(spaced))).toEqual([]);
  });

  it('stops a mount program outliving its deadline, failing with timed out and leaving no mount point', async () => {
    fake.hold();
    const error = await failure(mount(paths, BOX_A, 300));
    expect(error.message).toBe('timed out');
    expect(fake.calls('fusermount3')).toEqual([]);
    expect(entries(mountDir(paths))).toEqual([]);
  });

  it('fails with timed out when unmounting after the deadline fails too, keeping that failure as its cause', async () => {
    const point = mountPoint(paths, BOX_A);
    fake.hold();
    fake.addMount(point);
    vi.stubEnv('WTD_FUSERMOUNT', script('fusermount-fails', 'echo "fusermount3: busy" >&2; exit 1'));
    const error = await failure(mount(paths, BOX_A, 300));
    expect(error.message).toBe('timed out');
    expect(error.cause).toBeInstanceOf(MountError);
  });

  it('keeps both failures when reading the mount table fails and so does cleaning up', async () => {
    vi.stubEnv('WTD_MOUNTINFO', join(dir, 'no-such-mountinfo'));
    const error: unknown = await mount(paths, BOX_A).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AggregateError);
    const codes =
      error instanceof AggregateError ? error.errors.map((e: unknown) => (e instanceof Error && 'code' in e ? e.code : null)) : [];
    expect(codes).toEqual(['ENOENT', 'ENOENT']);
  });

  it('keeps a failed start’s own cause beside a failed cleanup', async () => {
    vi.stubEnv('WTD_SSHFS', join(dir, 'no-such-sshfs'));
    vi.stubEnv('WTD_MOUNTINFO', join(dir, 'no-such-mountinfo'));
    const error = await failure(mount(paths, BOX_A));
    expect(error.failure).toBe('missing-program');
    expect(error.cause).toBeInstanceOf(AggregateError);
    const paths_ =
      error.cause instanceof AggregateError
        ? error.cause.errors.map((e: unknown) => (e instanceof Error && 'path' in e ? e.path : null))
        : [];
    expect(paths_).toEqual([join(dir, 'no-such-sshfs'), join(dir, 'no-such-mountinfo')]);
  });

  it('unmounts what a mount program outliving its deadline mounted', async () => {
    const point = mountPoint(paths, BOX_A);
    fake.hold();
    fake.addMount(point);
    const error = await failure(mount(paths, BOX_A, 300));
    expect(error.message).toBe('timed out');
    expect(fake.calls('fusermount3')).toEqual([{ program: 'fusermount3', args: ['-u', '-z', point] }]);
    expect(fake.mounted()).toEqual([]);
    expect(entries(mountDir(paths))).toEqual([]);
  });
});

describe('unmount', () => {
  beforeEach(useFake);

  it('runs the unmount command with -u -z, then removes the mount point', async () => {
    const point = await mount(paths, BOX_A);
    await unmount(point);
    expect(fake.calls('fusermount3')).toEqual([{ program: 'fusermount3', args: ['-u', '-z', point] }]);
    expect(fake.mounted()).toEqual([]);
    expect(existsSync(point)).toBe(false);
  });

  it('fails with the unmount program error line when it exits non-zero', async () => {
    const point = mountPoint(paths, BOX_A);
    mkdirSync(point, { recursive: true });
    const error = await failure(unmount(point));
    expect(error.failure).toBe('failed');
    expect(error.message).toContain('not found in /etc/mtab');
  });

  it('fails as a missing program naming WTD_FUSERMOUNT when it does not exist', async () => {
    const point = await mount(paths, BOX_A);
    const missing = join(dir, 'no-fusermount');
    vi.stubEnv('WTD_FUSERMOUNT', missing);
    const error = await failure(unmount(point));
    expect(error.failure).toBe('missing-program');
    expect(error.program).toBe(missing);
    expect(error.message).toContain(missing);
  });
});

describe('listMounts', () => {
  beforeEach(useFake);

  it('lists the mount points under the mount directory that the mount table lists', async () => {
    const a = await mount(paths, BOX_A);
    const b = await mount(paths, { ...BOX_A, path: '/srv/b' });
    const stale = mountPoint(paths, { ...BOX_A, host: 'gpu' });
    mkdirSync(stale);
    fake.addMount(stale);
    mkdirSync(mountPoint(paths, { ...BOX_A, path: '/srv/leftover' }));
    fake.addMount('/mnt/elsewhere');
    fake.addMount(`${mountDir(paths)}-other/abc`);
    expect((await listMounts(paths)).sort()).toEqual([a, b, stale].sort());
  });

  it('lists nothing when the mount directory does not exist', async () => {
    fake.addMount('/mnt/elsewhere');
    await expect(listMounts(paths)).resolves.toEqual([]);
  });

  it('unescapes the mount table, finding a mount point under a state directory holding a backslash', async () => {
    const odd = hostPaths({ env: { XDG_STATE_HOME: join(dir, 'a\\b') }, home: '/nonexistent', host: 'box' });
    const point = mountPoint(odd, BOX_A);
    mkdirSync(point, { recursive: true });
    fake.addMount(point);
    await expect(listMounts(odd)).resolves.toEqual([point]);
  });

  it('reads the process mount table, finding none of its mounts, when WTD_MOUNTINFO is not set', async () => {
    vi.stubEnv('WTD_MOUNTINFO', undefined);
    mkdirSync(mountPoint(paths, BOX_A), { recursive: true });
    await expect(listMounts(paths)).resolves.toEqual([]);
  });
});

describe('removeLeftovers', () => {
  beforeEach(useFake);

  it('removes the empty directories under the mount directory that the mount table does not list, keeping mounted ones', async () => {
    const kept = await mount(paths, BOX_A);
    const leftover = mountPoint(paths, { ...BOX_A, path: '/srv/gone' });
    mkdirSync(leftover);
    await removeLeftovers(paths);
    expect(entries(mountDir(paths))).toEqual([kept.slice(mountDir(paths).length + 1)]);
  });

  it('never removes a directory that holds anything', async () => {
    const full = mountPoint(paths, { ...BOX_A, path: '/srv/full' });
    mkdirSync(full, { recursive: true });
    writeFileSync(join(full, 'file'), '');
    await expect(removeLeftovers(paths)).rejects.toThrow();
    expect(existsSync(join(full, 'file'))).toBe(true);
  });

  it('does nothing when the mount directory does not exist', async () => {
    await expect(removeLeftovers(paths)).resolves.toBeUndefined();
  });
});
