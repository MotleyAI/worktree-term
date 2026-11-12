import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitUntil } from '../../../test/support/daemon-host.js';
import {
  cgroupFile,
  cgroupOf,
  failUnit,
  fakeProgram,
  HOG,
  isFailed,
  NO_USER_MANAGER,
  resetFailed,
  SMALL,
  withUserManager,
} from '../../../test/support/scopes.js';
import {
  daemonUnit,
  editorUnit,
  enterScope,
  findUserManager,
  hostScopeRoots,
  hubUnit,
  lowerOomScoreAdj,
  outOfMemory,
  resetFailedScopes,
  SCOPE_SLICE,
  scopeCommand,
  terminalUnit,
  unitPrefix,
  type ScopeRoots,
} from './index.js';

const UID = 4242;
const USER = 'wtd-tester';
const MANAGED = `0::/user.slice/user-${String(UID)}.slice/user@${String(UID)}.service/app.slice/app-x.scope\n`;
const SESSION = `0::/user.slice/user-${String(UID)}.slice/session-3.scope\n`;
const PROBE = ['--user', '--scope', '--quiet', '--collect', '--slice=app-wtd.slice', '--', 'true'];
const NO_EXPAND_PROBE = ['--user', '--scope', '--quiet', '--collect', '--expand-environment=no', '--slice=app-wtd.slice', '--', 'true'];

let dir: string;
let roots: ScopeRoots;
let reported: unknown[];
const report = (error: unknown): void => {
  reported.push(error);
};
const children: ChildProcess[] = [];

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'wtd-scopes-')));
  roots = { cgroupFile: join(dir, 'cgroup'), lingerDir: join(dir, 'linger'), uid: UID, user: USER };
  mkdirSync(roots.lingerDir);
  writeFileSync(roots.cgroupFile, MANAGED);
  reported = [];
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const child of children.splice(0)) child.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
});

/** A fake program named `name` in the test directory. */
const fake = (name: string, body: string): ReturnType<typeof fakeProgram> => fakeProgram(join(dir, name), body);

/** Stubs the systemd-run command with a fake running `body`. */
const systemdRun = (body: string): ReturnType<typeof fakeProgram> => {
  const program = fake('systemd-run', body);
  vi.stubEnv('WTD_SYSTEMD_RUN', program.program);
  return program;
};

/** Stubs the systemctl command with a fake printing `show` for `show` and recording every call. */
const systemctl = (show: string, exit = 0): ReturnType<typeof fakeProgram> => {
  const program = fake('systemctl', `case " $* " in *" show "*) printf '${show}';; esac\nexit ${String(exit)}`);
  vi.stubEnv('WTD_SYSTEMCTL', program.program);
  return program;
};

const hash = (): string => createHash('sha256').update(dir).digest('hex').slice(0, 8);

describe('lasting user manager', () => {
  it('is found under the user manager when the scope probe succeeds, probing with the scope command, then for --expand-environment=no', async () => {
    const run = systemdRun('exit 0');
    expect(await findUserManager(roots)).toEqual({ lasting: true, noExpand: true });
    expect(run.calls()).toEqual([PROBE, NO_EXPAND_PROBE]);
  });

  it('finds --expand-environment=no unsupported when systemd-run, run in the C locale, rejects it as unrecognized', async () => {
    systemdRun(
      `case " $* " in *" --expand-environment=no "*) [ "$LC_ALL" = C ] || exit 3; echo "systemd-run: unrecognized option '--expand-environment=no'" >&2; exit 1;; esac`,
    );
    expect(await findUserManager(roots)).toEqual({ lasting: true, noExpand: false });
  });

  it('finds no lasting user manager when the --expand-environment=no probe fails otherwise, the reason naming the failure', async () => {
    systemdRun(`case " $* " in *" --expand-environment=no "*) echo 'Failed to connect to bus: Connection refused' >&2; exit 1;; esac`);
    const found = await findUserManager(roots);
    expect(found).toMatchObject({ lasting: false });
    expect(found.lasting ? '' : found.reason).toContain('Failed to connect to bus: Connection refused');
  });

  it('finds no lasting user manager when the --expand-environment=no probe hangs, the reason naming the timeout', async () => {
    systemdRun(`case " $* " in *" --expand-environment=no "*) exec sleep 30;; esac`);
    const found = await findUserManager(roots);
    expect(found).toMatchObject({ lasting: false });
    expect(found.lasting ? '' : found.reason).toContain('timed out after 2000 ms');
  });

  it('probes for --expand-environment=no only when the user manager is lasting', async () => {
    const run = systemdRun('exit 0');
    writeFileSync(roots.cgroupFile, SESSION);
    await findUserManager(roots);
    expect(run.calls()).toEqual([PROBE]);
  });

  it('is not found in a session scope without lingering, saying why', async () => {
    systemdRun('exit 0');
    writeFileSync(roots.cgroupFile, SESSION);
    expect(await findUserManager(roots)).toEqual({ lasting: false, reason: 'not under the user manager and not lingering' });
  });

  it('is found in a session scope when the user lingers', async () => {
    systemdRun('exit 0');
    writeFileSync(roots.cgroupFile, SESSION);
    writeFileSync(join(roots.lingerDir, USER), '');
    expect(await findUserManager(roots)).toEqual({ lasting: true, noExpand: true });
  });

  it("does not count another user's manager", async () => {
    systemdRun('exit 0');
    writeFileSync(roots.cgroupFile, '0::/user.slice/user-1.slice/user@1.service/app.slice/app-x.scope\n');
    expect(await findUserManager(roots)).toMatchObject({ lasting: false });
  });

  it('is not found when the probe exits non-zero, the reason naming the failure', async () => {
    systemdRun("echo 'Failed to connect to bus: No medium found' >&2; exit 1");
    const found = await findUserManager(roots);
    expect(found).toMatchObject({ lasting: false });
    expect(found.lasting ? '' : found.reason).toContain('Failed to connect to bus: No medium found');
    expect(found.lasting ? '' : found.reason).not.toContain('\n');
  });

  it('is not found when the probe cannot be started, the reason naming the program', async () => {
    vi.stubEnv('WTD_SYSTEMD_RUN', join(dir, 'missing-systemd-run'));
    const found = await findUserManager(roots);
    expect(found).toMatchObject({ lasting: false });
    expect(found.lasting ? '' : found.reason).toContain(join(dir, 'missing-systemd-run'));
  });

  it('names the probe failure first, outside the user manager too', async () => {
    systemdRun("echo 'Failed to connect to bus' >&2; exit 1");
    writeFileSync(roots.cgroupFile, SESSION);
    const found = await findUserManager(roots);
    expect(found.lasting ? '' : found.reason).toContain('Failed to connect to bus');
  });

  it('kills and reaps a probe still running after 2 s, the reason naming the timeout', async () => {
    const pidFile = join(dir, 'probe.pid');
    systemdRun(`echo $$ > '${pidFile}'; exec sleep 30`);
    const started = Date.now();
    const found = await findUserManager(roots);
    const took = Date.now() - started;
    expect(found).toMatchObject({ lasting: false });
    expect(found.lasting ? '' : found.reason).toMatch(/time/i);
    expect(took).toBeGreaterThanOrEqual(1900);
    expect(took).toBeLessThan(3500);
    const pid = readFileSync(pidFile, 'utf8').trim();
    expect(existsSync(`/proc/${pid}`)).toBe(false);
  });

  it('runs systemd-run from PATH when WTD_SYSTEMD_RUN is empty', async () => {
    const run = fake('systemd-run', 'exit 0');
    vi.stubEnv('WTD_SYSTEMD_RUN', '');
    vi.stubEnv('PATH', `${dir}:${process.env['PATH'] ?? ''}`);
    expect(await findUserManager(roots)).toEqual({ lasting: true, noExpand: true });
    expect(run.calls()).toEqual([PROBE, NO_EXPAND_PROBE]);
  });

  it('reads the real cgroup, linger directory and user of this process', () => {
    const real = hostScopeRoots();
    expect(real.cgroupFile).toBe('/proc/self/cgroup');
    expect(real.lingerDir).toBe('/var/lib/systemd/linger');
    expect(real.uid).toBe(process.getuid?.());
  });
});

describe('lowering oom_score_adj', () => {
  const OWN = '/proc/self/oom_score_adj';
  const own = (): number => Number(readFileSync(OWN, 'utf8').trim());

  it("lowers this process's adjustment to the lowest value the kernel permits it", async () => {
    const original = own();
    try {
      writeFileSync(OWN, '500');
      await lowerOomScoreAdj();
      const floor = own();
      expect(floor).toBeLessThan(500);
      if (floor > -1000) {
        const below = String(floor - 1);
        expect(() => {
          writeFileSync(OWN, below);
        }).toThrow(/EACCES/);
      }
    } finally {
      // Raising is always permitted, and later tests' children must not inherit the floor.
      writeFileSync(OWN, String(original));
    }
  });

  it('searches down to -1000 when every value is accepted', async () => {
    const file = join(dir, 'adj');
    writeFileSync(file, '500\n');
    await lowerOomScoreAdj(file);
    expect(readFileSync(file, 'utf8')).toBe('-1000');
  });

  it('does nothing without the file', async () => {
    await expect(lowerOomScoreAdj(join(dir, 'missing'))).resolves.toBeUndefined();
  });
});

describe('unit names', () => {
  it('begin with wtd- and the first 8 hex digits of the SHA-256 of the state directory', () => {
    expect(unitPrefix(dir)).toBe(`wtd-${hash()}-`);
    expect(unitPrefix(`${dir}/other`)).not.toBe(unitPrefix(dir));
  });

  it('name a daemon or hub scope with a random suffix', () => {
    expect(daemonUnit(dir)).toMatch(new RegExp(`^wtd-${hash()}-daemon-[0-9a-f]{8}\\.scope$`));
    expect(hubUnit(dir)).toMatch(new RegExp(`^wtd-${hash()}-hub-[0-9a-f]{8}\\.scope$`));
    expect(daemonUnit(dir)).not.toBe(daemonUnit(dir));
    expect(hubUnit(dir)).not.toBe(hubUnit(dir));
  });

  it('name an editor scope with a random suffix', () => {
    expect(editorUnit(dir)).toMatch(new RegExp(`^wtd-${hash()}-editor-[0-9a-f]{8}\\.scope$`));
    expect(editorUnit(dir).startsWith(unitPrefix(dir))).toBe(true);
    expect(editorUnit(dir)).not.toBe(editorUnit(dir));
  });

  it("name a terminal's scope by its daemon instance and terminal id", () => {
    expect(terminalUnit(dir, 'a1B2_c-3', 7)).toBe(`wtd-${hash()}-term-a1B2_c-3-7.scope`);
  });

  it('use the slice app-wtd.slice', () => {
    expect(SCOPE_SLICE).toBe('app-wtd.slice');
  });
});

describe('scope command', () => {
  const unit = 'wtd-01234567-term-i-1.scope';
  const head = ['--user', '--scope', '--quiet', `--unit=${unit}`, '--slice=app-wtd.slice', '-p', 'OOMPolicy=kill'];

  it('runs the command through systemd-run with each limit given as a property', () => {
    vi.stubEnv('WTD_SYSTEMD_RUN', '/opt/fake run');
    expect(scopeCommand(unit, { high: '8G', max: '16G', swapMax: '0' }, ['/bin/sh', '-c', 'x'], false)).toEqual([
      '/opt/fake run',
      ...head,
      '-p',
      'MemoryHigh=8G',
      '-p',
      'MemoryMax=16G',
      '-p',
      'MemorySwapMax=0',
      '--',
      '/bin/sh',
      '-c',
      'x',
    ]);
  });

  it('gives no memory property without limits', () => {
    vi.stubEnv('WTD_SYSTEMD_RUN', undefined);
    expect(scopeCommand(unit, {}, ['bash'], false)).toEqual(['systemd-run', ...head, '--', 'bash']);
  });

  it('gives only the limits given', () => {
    vi.stubEnv('WTD_SYSTEMD_RUN', '');
    expect(scopeCommand(unit, { max: '50%' }, ['bash'], false)).toEqual(['systemd-run', ...head, '-p', 'MemoryMax=50%', '--', 'bash']);
  });

  it('turns off argument expansion when systemd-run supports it, before the limits', () => {
    vi.stubEnv('WTD_SYSTEMD_RUN', undefined);
    const off = ['--expand-environment=no'];
    expect(scopeCommand(unit, { max: '1G' }, ['bash'], true)).toEqual(['systemd-run', ...head, ...off, '-p', 'MemoryMax=1G', '--', 'bash']);
  });

  it('leaves argument expansion alone when systemd-run does not support turning it off', () => {
    vi.stubEnv('WTD_SYSTEMD_RUN', undefined);
    expect(scopeCommand(unit, {}, ['bash'], false)).toEqual(['systemd-run', ...head, '--', 'bash']);
  });
});

describe('entering a scope', () => {
  it('asks the user manager through busctl to start the transient scope with the pid as its only member, in the slice', async () => {
    const busctl = fake('busctl', 'echo \'o "/org/freedesktop/systemd1/job/1"\'');
    vi.stubEnv('WTD_BUSCTL', busctl.program);
    systemctl('ActiveState=active\\nResult=success\\n');
    await enterScope('wtd-01234567-hub-89abcdef.scope', 4321);
    const [call] = busctl.calls();
    expect(call).toEqual(
      expect.arrayContaining([
        '--user',
        'call',
        'org.freedesktop.systemd1',
        '/org/freedesktop/systemd1',
        'org.freedesktop.systemd1.Manager',
        'StartTransientUnit',
        'wtd-01234567-hub-89abcdef.scope',
        'PIDs',
        'au',
        '1',
        '4321',
        'Slice',
        's',
        'app-wtd.slice',
      ]),
    );
  });

  it('rejects naming busctl’s failure', async () => {
    const busctl = fake('busctl', "echo 'Call failed: Unit wtd-x.scope already exists.' >&2; exit 1");
    vi.stubEnv('WTD_BUSCTL', busctl.program);
    await expect(enterScope('wtd-x.scope', 4321)).rejects.toThrow('Unit wtd-x.scope already exists.');
  });

  it('rejects naming a busctl that cannot be started', async () => {
    vi.stubEnv('WTD_BUSCTL', join(dir, 'missing-busctl'));
    await expect(enterScope('wtd-x.scope', 4321)).rejects.toThrow(join(dir, 'missing-busctl'));
  });

  it('rejects with the timeout when busctl exits at once but a descendant holds its output past 2 s', async () => {
    vi.stubEnv('WTD_BUSCTL', fake('busctl', 'sleep 30 & exit 0').program);
    const started = Date.now();
    await expect(enterScope('wtd-x.scope', 4321)).rejects.toThrow('timed out after 2000 ms');
    expect(Date.now() - started).toBeLessThan(3500);
  });

  it('kills a busctl still running after 2 s, rejecting with the timeout though a descendant holds its output', async () => {
    const pidFile = join(dir, 'busctl.pid');
    vi.stubEnv('WTD_BUSCTL', fake('busctl', `echo $$ > '${pidFile}'; sleep 30 & exec sleep 30`).program);
    const started = Date.now();
    await expect(enterScope('wtd-x.scope', 4321)).rejects.toThrow('timed out after 2000 ms');
    expect(Date.now() - started).toBeLessThan(3500);
    expect(existsSync(`/proc/${readFileSync(pidFile, 'utf8').trim()}`)).toBe(false);
  });
});

describe('scope outcome', () => {
  const unit = 'wtd-01234567-term-i-1.scope';

  it('is out of memory when the scope failed with Result oom-kill, and the unit is then reset', async () => {
    const ctl = systemctl('ActiveState=failed\\nResult=oom-kill\\n');
    expect(await outOfMemory(unit, report)).toBe(true);
    const calls = ctl.calls();
    expect(calls[0]).toEqual(expect.arrayContaining(['--user', 'show', unit]));
    expect(calls).toContainEqual(expect.arrayContaining(['--user', 'reset-failed', unit]));
    expect(reported).toEqual([]);
  });

  it('polls until the scope is no longer active', async () => {
    const count = join(dir, 'count');
    const ctl = fake(
      'systemctl',
      `case " $* " in *" show "*) n=$(cat '${count}' 2>/dev/null || echo 0); echo $((n+1)) > '${count}'
        if [ "$n" -lt 3 ]; then printf 'ActiveState=deactivating\\nResult=success\\n'; else printf 'Result=oom-kill\\nActiveState=failed\\n'; fi;; esac`,
    );
    vi.stubEnv('WTD_SYSTEMCTL', ctl.program);
    expect(await outOfMemory(unit, report)).toBe(true);
    expect(ctl.calls().filter((c) => c.includes('show'))).toHaveLength(4);
  });

  it('is not out of memory for a scope that ended inactive, which is not reset', async () => {
    const ctl = systemctl('ActiveState=inactive\\nResult=success\\n');
    expect(await outOfMemory(unit, report)).toBe(false);
    expect(ctl.calls().some((c) => c.includes('reset-failed'))).toBe(false);
  });

  it('is not out of memory for a scope failed otherwise, which is reset', async () => {
    const ctl = systemctl('ActiveState=failed\\nResult=exit-code\\n');
    expect(await outOfMemory(unit, report)).toBe(false);
    expect(ctl.calls()).toContainEqual(expect.arrayContaining(['reset-failed', unit]));
  });

  it('gives up after 2 s on a scope still active, as not out of memory', async () => {
    systemctl('ActiveState=active\\nResult=success\\n');
    const started = Date.now();
    expect(await outOfMemory(unit, report)).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
    expect(Date.now() - started).toBeLessThan(3500);
  });

  it('counts output that does not parse as not out of memory, and reports it', async () => {
    systemctl('garbage\\n');
    expect(await outOfMemory(unit, report)).toBe(false);
    expect(reported).toHaveLength(1);
  });

  it('counts a failing query as not out of memory, and reports it', async () => {
    systemctl('', 1);
    expect(await outOfMemory(unit, report)).toBe(false);
    expect(reported).toHaveLength(1);
  });

  it('counts a systemctl that cannot be started as not out of memory, and reports it', async () => {
    vi.stubEnv('WTD_SYSTEMCTL', join(dir, 'missing-systemctl'));
    expect(await outOfMemory(unit, report)).toBe(false);
    expect(reported).toHaveLength(1);
  });

  it('kills a query still running after 2 s, counting it as not out of memory and reporting the timeout', async () => {
    vi.stubEnv('WTD_SYSTEMCTL', fake('systemctl', 'sleep 30 & exec sleep 30').program);
    const started = Date.now();
    expect(await outOfMemory(unit, report)).toBe(false);
    expect(Date.now() - started).toBeLessThan(3500);
    expect(String(reported[0])).toContain('timed out after 2000 ms');
  });
});

// Real scopes and memory hogs outlast the unit default timeout on a loaded host.
describe.skipIf(NO_USER_MANAGER !== null)(withUserManager('scopes of the real user manager'), { timeout: 30_000 }, () => {
  let noExpand = false;

  beforeAll(async () => {
    const found = await findUserManager(hostScopeRoots());
    if (found.lasting) noExpand = found.noExpand;
  });

  it('finds a lasting user manager for this process, whose systemd-run says whether it takes --expand-environment=no', async () => {
    const anyBoolean: unknown = expect.any(Boolean);
    expect(await findUserManager(hostScopeRoots())).toEqual({ lasting: true, noExpand: anyBoolean });
  });

  it('passes a command its arguments as given', () => {
    const unit = terminalUnit(dir, 'verbatim', 1);
    const [file = '', ...args] = scopeCommand(unit, {}, ['sh', '-c', 'printf "%s|%s" "$1" "$2"', 'sh', '$$', '${HOME}'], noExpand);
    expect(spawnSync(file, args, { encoding: 'utf8' }).stdout).toBe('$$|${HOME}');
  });

  it('starts a command in a terminal scope with its own pid, limits and whole-scope OOM kills', async () => {
    const unit = terminalUnit(dir, 'started', 1);
    const [file = '', ...args] = scopeCommand(unit, SMALL, ['sh', '-c', 'echo $$; exec sleep 30'], noExpand);
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'inherit'] });
    children.push(child);
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    const printed = await waitUntil(() => /^(\d+)\n/.exec(out)?.[1], 'the pid it prints', 15_000).catch((error: unknown) => {
      throw new Error(`no pid in its output ${JSON.stringify(out)}`, { cause: error });
    });
    const pid = Number(printed);
    expect(pid).toBe(child.pid);
    const path = cgroupOf(pid);
    expect(path.endsWith(`/app-wtd.slice/${unit}`)).toBe(true);
    expect(cgroupFile(path, 'memory.max')).toBe('67108864');
    expect(cgroupFile(path, 'memory.swap.max')).toBe('0');
    expect(cgroupFile(path, 'memory.oom.group')).toBe('1');
  });

  it('moves a running process into a hub scope of its own', async () => {
    const child = spawn('sleep', ['30'], { stdio: 'ignore' });
    children.push(child);
    const unit = hubUnit(dir);
    await enterScope(unit, child.pid ?? 0);
    expect(cgroupOf(child.pid ?? 0)).toMatch(new RegExp(`/app-wtd\\.slice/wtd-${hash()}-hub-[0-9a-f]{8}\\.scope$`));
    expect(cgroupOf(child.pid ?? 0).endsWith(`/${unit}`)).toBe(true);
  });

  it('reads the outcome of a scope killed for exceeding its memory.max as out of memory, then resets it', async () => {
    const unit = terminalUnit(dir, 'hog', 1);
    const [file = '', ...args] = scopeCommand(unit, SMALL, ['bash', '-c', HOG], noExpand);
    expect(spawnSync(file, args, { stdio: 'ignore' }).signal).toBe('SIGKILL');
    expect(await outOfMemory(unit, report)).toBe(true);
    expect(isFailed(unit)).toBe(false);
    expect(reported).toEqual([]);
  });

  it('reads the outcome of a scope whose only process exits with code 1 as not out of memory', async () => {
    const unit = terminalUnit(dir, 'fails', 1);
    const [file = '', ...args] = scopeCommand(unit, {}, ['sh', '-c', 'exit 1'], noExpand);
    expect(spawnSync(file, args, { stdio: 'ignore' }).status).toBe(1);
    expect(await outOfMemory(unit, report)).toBe(false);
  });

  it('resets the failed units with a prefix, and only those', async () => {
    const ours = `${unitPrefix(dir)}term-old-1.scope`;
    const theirs = `${unitPrefix(`${dir}/other`)}term-old-1.scope`;
    failUnit(ours);
    failUnit(theirs);
    try {
      await resetFailedScopes(`${unitPrefix(dir)}term-`, report);
      expect(isFailed(ours)).toBe(false);
      expect(isFailed(theirs)).toBe(true);
      expect(reported).toEqual([]);
    } finally {
      resetFailed(ours);
      resetFailed(theirs);
    }
  });
});
