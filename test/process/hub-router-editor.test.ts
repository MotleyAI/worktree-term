import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { addWorktree, alive, git, sleep, waitUntil } from '../support/daemon-host.js';
import type { HubClient } from '../support/hub-client.js';
import { errorMessage, openEditor } from '../support/hub-editor.js';
import { fx, restartHub, useHubRouterHost, watching } from '../support/hub-router.js';
import { cgroupOf, fakeProgram, NO_USER_MANAGER, scopePath, userManagerEnv, withUserManager } from '../support/scopes.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });
useHubRouterHost();

const launchSchema = z.strictObject({
  pid: z.number(),
  args: z.array(z.string()),
  cwd: z.string(),
  sid: z.number(),
  stdin: z.string(),
  stdout: z.string(),
});
type Launch = z.infer<typeof launchSchema>;

/** Stand-in editor: appends one JSON line describing its launch to `log`, then keeps running. */
const RECORDER = (log: string): string => String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const stat = fs.readFileSync('/proc/self/stat', 'utf8');
const sid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[3]);
const fd = (n) => { try { return fs.readlinkSync('/proc/self/fd/' + n); } catch { return 'closed'; } };
const launch = { pid: process.pid, args: process.argv.slice(2), cwd: fs.readlinkSync('/proc/self/cwd'), sid, stdin: fd(0), stdout: fd(1) };
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(launch) + '\n');
setTimeout(() => process.exit(0), 60000);
`;

const launched: number[] = [];

afterEach(() => {
  for (const pid of launched.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
});

/** A recording editor program named `name` in the stub directory; its path has a space. */
const recorder = (name = 'my editor'): { program: string; launches: () => Launch[] } => {
  const dir = join(fx.host.dir, 'editors');
  mkdirSync(dir, { recursive: true });
  const program = join(dir, name);
  const log = join(dir, `${name}.log`);
  writeFileSync(program, RECORDER(log));
  chmodSync(program, 0o755);
  return {
    program,
    launches: () => {
      if (!existsSync(log)) return [];
      const entries = readFileSync(log, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => launchSchema.parse(JSON.parse(line)));
      for (const entry of entries) if (!launched.includes(entry.pid)) launched.push(entry.pid);
      return entries;
    },
  };
};

/** `program` as one word of an editor command. */
const quoted = (program: string): string => `'${program}'`;

const useEditor = (command: string): void => {
  fx.host.writeConfig({ port: fx.host.port, repos: [fx.repo], editor: command });
};

const firstLaunch = async (launches: () => Launch[]): Promise<Launch> => {
  await waitUntil(() => launches().length > 0, 'the editor to record its launch');
  const [launch] = launches();
  if (launch === undefined) throw new Error('no launch');
  return launch;
};

const open = (client: HubClient, worktree: string): ReturnType<HubClient['hubRequest']> =>
  client.hubRequest({ t: 'openEditor', host: 0, worktree });

describe('opening a worktree in an editor', () => {
  it('answers done while the editor keeps running', async () => {
    const editor = recorder();
    useEditor(quoted(editor.program));
    const client = await watching();
    expect((await open(client, fx.repo)).m).toEqual({ t: 'done', req: 2 });
    const { pid } = await firstLaunch(editor.launches);
    expect(alive(pid)).toBe(true);
  });

  it('sends nothing when the editor exits, even with a failure', async () => {
    const program = join(fx.host.dir, 'quitter');
    const exited = join(fx.host.dir, 'quitter.exited');
    writeFileSync(program, `#!/bin/sh\nsleep 0.2\n: > '${exited}'\nexit 3\n`, { mode: 0o755 });
    useEditor(quoted(program));
    const client = await watching();
    expect((await open(client, fx.repo)).m).toEqual({ t: 'done', req: 2 });
    const from = client.mark();
    await waitUntil(() => existsSync(exited), 'the editor to exit');
    await sleep(500);
    expect(client.messages.slice(from).filter((m) => m.t !== 'host' && m.t !== 'hosts')).toEqual([]);
  });

  it('answers editor-missing for an absolute path to no program', async () => {
    const missing = join(fx.host.dir, 'no-such-editor');
    useEditor(missing);
    const client = await watching();
    const reply = await open(client, fx.repo);
    expect(reply).toMatchObject({ m: { t: 'error', code: 'editor-missing' } });
    expect(reply.m.t === 'error' ? reply.m.message : '').toContain(missing);
  });

  it('answers editor-failed, not editor-missing, when both the worktree and the program are missing', async () => {
    useEditor('kate-nope');
    const client = await watching();
    rmSync(fx.wt, { recursive: true, force: true });
    expect(await open(client, fx.wt)).toMatchObject({ m: { t: 'error', code: 'editor-failed' } });
  });

  it('runs the command another page set, once its session received it', async () => {
    const editor = recorder();
    const a = await fx.host.session();
    const b = await watching();
    const fromB = b.mark();
    expect((await a.hubRequest({ t: 'setEditor', command: `${quoted(editor.program)} {path}` })).m).toEqual({ t: 'done', req: 1 });
    await b.waitFor('editor', () => true, { from: fromB });
    expect((await open(b, fx.wt)).m).toEqual({ t: 'done', req: 2 });
    expect((await firstLaunch(editor.launches)).args).toEqual([fx.wt]);
  });

  it('runs the command the session was given, not one edited into the file by hand since', async () => {
    const first = recorder('first');
    const second = recorder('second');
    useEditor(quoted(first.program));
    const client = await watching();
    useEditor(quoted(second.program));
    expect((await open(client, fx.repo)).m).toEqual({ t: 'done', req: 2 });
    await firstLaunch(first.launches);
    expect(second.launches()).toEqual([]);
  });
});

describe.skipIf(NO_USER_MANAGER !== null)(withUserManager('editor placement under the user manager'), () => {
  it('runs the editor in a transient scope of its own, not the hub’s', async () => {
    await restartHub(userManagerEnv());
    const editor = recorder();
    useEditor(quoted(editor.program));
    const client = await watching();
    expect((await open(client, fx.repo)).m).toEqual({ t: 'done', req: 2 });
    const { pid } = await firstLaunch(editor.launches);
    await waitUntil(() => scopePath(fx.host.stateDir, 'editor').test(cgroupOf(pid)), 'the editor to enter its scope');
    expect(cgroupOf(pid)).not.toBe(cgroupOf(fx.hub.pid));
  });

  it('reports a failure to move the editor into its scope and still answers done', async () => {
    const systemdRun = fakeProgram(join(fx.host.dir, 'systemd-run'), 'exit 0');
    const busctl = fakeProgram(join(fx.host.dir, 'busctl'), "echo 'Call failed: Access denied' >&2; exit 1");
    await restartHub({ ...userManagerEnv(), WTD_SYSTEMD_RUN: systemdRun.program, WTD_BUSCTL: busctl.program });
    const editor = recorder();
    useEditor(quoted(editor.program));
    const client = await watching();
    const before = fx.hub.stderr.length;
    expect((await open(client, fx.repo)).m).toEqual({ t: 'done', req: 2 });
    const { pid } = await firstLaunch(editor.launches);
    await waitUntil(() => busctl.calls().some((args) => args.includes(String(pid))), 'the editor’s scope move');
    expect(
      busctl
        .calls()
        .find((args) => args.includes(String(pid)))
        ?.some((arg) => /-editor-[0-9a-f]{8}\.scope$/.test(arg)),
    ).toBe(true);
    await waitUntil(() => fx.hub.stderr.slice(before).includes('Call failed: Access denied'), 'the reported failure');
    expect(alive(pid)).toBe(true);
  });
});

describe('editor placement without a lasting user manager', () => {
  it('starts the editor without trying to move it', async () => {
    const busctl = fakeProgram(join(fx.host.dir, 'busctl'), 'exit 1');
    const systemdRun = fakeProgram(join(fx.host.dir, 'systemd-run'), "echo 'Failed to connect to bus: No medium found' >&2\nexit 1");
    await restartHub({ ...userManagerEnv(), WTD_SYSTEMD_RUN: systemdRun.program, WTD_BUSCTL: busctl.program });
    const editor = recorder();
    useEditor(quoted(editor.program));
    const client = await watching();
    expect((await open(client, fx.repo)).m).toEqual({ t: 'done', req: 2 });
    await firstLaunch(editor.launches);
    expect(busctl.calls()).toEqual([]);
  });
});

describe('opening a listed local worktree in an editor', () => {
  it('passes the listed worktree /tmp/a b/$x;y as one argument after --wait, in that directory', async () => {
    const editor = recorder();
    const odd = addWorktree(fx.repo, join(fx.host.dir, 'a b', '$x;y'), 'odd');
    useEditor(`${quoted(editor.program)} --wait {path}`);
    const client = await watching();
    expect(await openEditor(client, 0, odd)).toEqual({ from: 'hub', m: { t: 'done', req: 2 } });
    const launch = await firstLaunch(editor.launches);
    expect(launch.args).toEqual(['--wait', odd]);
    expect(launch.cwd).toBe(odd);
    expect(launch.sid).toBe(launch.pid);
    expect(launch.stdin).toBe('/dev/null');
    expect(launch.stdout).toBe('/dev/null');
  });

  it('appends the listed worktree’s path when the command has no placeholder', async () => {
    const editor = recorder();
    useEditor(`${quoted(editor.program)} -n`);
    const client = await watching();
    expect((await openEditor(client, 0, fx.wt)).m).toEqual({ t: 'done', req: 2 });
    expect((await firstLaunch(editor.launches)).args).toEqual(['-n', fx.wt]);
  });

  it('leaves the editor of a listed worktree running after the session closes', async () => {
    const editor = recorder();
    useEditor(quoted(editor.program));
    const client = await watching();
    expect((await openEditor(client, 0, fx.wt)).m).toEqual({ t: 'done', req: 2 });
    const { pid } = await firstLaunch(editor.launches);
    client.close();
    await fx.host.session();
    expect(alive(pid)).toBe(true);
  });

  it('answers editor-missing naming kate-nope for a listed worktree', async () => {
    useEditor('kate-nope {path}');
    const client = await watching();
    const reply = await openEditor(client, 0, fx.wt);
    expect(reply).toMatchObject({ from: 'hub', m: { t: 'error', req: 2, host: null, code: 'editor-missing' } });
    expect(errorMessage(reply)).toContain('kate-nope');
  });

  it('answers editor-failed naming the path, not editor-missing, for a listed worktree whose directory was deleted', async () => {
    const editor = recorder();
    useEditor(quoted(editor.program));
    const client = await watching();
    rmSync(fx.wt, { recursive: true, force: true });
    const reply = await openEditor(client, 0, fx.wt);
    expect(reply).toMatchObject({ from: 'hub', m: { t: 'error', req: 2, host: null, code: 'editor-failed' } });
    expect(errorMessage(reply)).toContain(fx.wt);
    expect(editor.launches()).toEqual([]);
  });

  it('answers editor-failed for a program without execute permission, opening a listed worktree', async () => {
    const program = join(fx.host.dir, 'not-executable');
    writeFileSync(program, '#!/bin/sh\n', { mode: 0o644 });
    useEditor(quoted(program));
    const client = await watching();
    expect(await openEditor(client, 0, fx.wt)).toMatchObject({ from: 'hub', m: { t: 'error', req: 2, host: null, code: 'editor-failed' } });
  });
});

describe('refusing an unlisted path', () => {
  it('answers not-a-worktree naming a directory that is no worktree of a watched repo, starting nothing', async () => {
    const editor = recorder();
    const plain = join(fx.host.dir, 'plain');
    mkdirSync(plain);
    useEditor(quoted(editor.program));
    const client = await watching();
    const reply = await openEditor(client, 0, plain);
    expect(reply).toMatchObject({ from: 'hub', m: { t: 'error', req: 2, host: null, code: 'not-a-worktree' } });
    expect(errorMessage(reply)).toContain(plain);
    await sleep(300);
    expect(editor.launches()).toEqual([]);
  });

  it('answers not-a-worktree for a worktree of a repo only another session watches', async () => {
    const editor = recorder();
    useEditor(quoted(editor.program));
    await watching();
    const other = await fx.host.session();
    await other.waitHost(0, (h) => h.status === 'connected');
    expect(await openEditor(other, 0, fx.wt)).toMatchObject({ from: 'hub', m: { t: 'error', req: 1, host: null, code: 'not-a-worktree' } });
    await sleep(300);
    expect(editor.launches()).toEqual([]);
  });

  it('answers not-a-worktree for a worktree missing from the latest list the daemon sent', async () => {
    const editor = recorder();
    useEditor(quoted(editor.program));
    const client = await watching();
    const from = client.mark();
    git(fx.repo, 'worktree', 'remove', fx.wt);
    await client.waitEvent(0, 'worktreesChanged', (m) => !m.worktrees.some((w) => w.path === fx.wt), { from, timeout: 10_000 });
    expect(await openEditor(client, 0, fx.wt)).toMatchObject({ m: { t: 'error', req: 2, host: null, code: 'not-a-worktree' } });
    expect(editor.launches()).toEqual([]);
  });

  it('answers not-a-worktree for an unknown host, starting nothing', async () => {
    const editor = recorder();
    useEditor(quoted(editor.program));
    const client = await watching();
    expect(await openEditor(client, 7, fx.wt)).toMatchObject({
      from: 'hub',
      m: { t: 'error', req: 2, host: null, code: 'not-a-worktree' },
    });
    await sleep(300);
    expect(editor.launches()).toEqual([]);
  });
});
