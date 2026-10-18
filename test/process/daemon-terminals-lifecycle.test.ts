import { chmodSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Layout } from '../../src/protocol/index.js';
import type { DaemonClient, Event, RequestBody } from '../support/daemon-client.js';
import { addWorktree, alive, git, sleep, waitUntil } from '../support/daemon-host.js';
import { fx, MiB, restart, started, useDaemonTerminalsHost } from '../support/daemon-terminals.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });
useDaemonTerminalsHost();

const ANY_REQ: unknown = expect.any(Number);

/** Messages from index `from`, without activity flags, which login start-up output may raise at any time. */
const repliesFrom = (client: DaemonClient, from: number): Event[] => client.messages.slice(from).filter((m) => m.t !== 'activity');

const pidIn = (dir: string, name: string): Promise<number> =>
  waitUntil(() => {
    const file = join(dir, name);
    if (!existsSync(file)) return undefined;
    const text = readFileSync(file, 'utf8');
    return text.endsWith('\n') ? Number(text) : undefined;
  }, `pid file ${name}`);

const countByte = (data: Uint8Array, byte: number): number => {
  let n = 0;
  for (const b of data) if (b === byte) n++;
  return n;
};

const stateFile = (): unknown => JSON.parse(readFileSync(fx.host.statePath, 'utf8'));

const stateMentions = (path: string): boolean =>
  existsSync(fx.host.statePath) && JSON.stringify(stateFile()).includes(JSON.stringify(path));

describe('terminal creation', () => {
  it('starts a login interactive shell in the worktree', async () => {
    const term = await started(fx.a, null);
    fx.a.sendInput(term.termId, 'pwd\r');
    await fx.a.waitOutput(term.termId, `${fx.wt}\r\n`);
    expect(fx.a.view(term.termId).text()).toContain(`${fx.wt}\r\n`);
  });

  it('runs a command in a login interactive shell with TERM and COLORTERM set', async () => {
    const command = `case $- in *i*) echo mode-interactive;; esac; shopt -q login_shell && echo mode-login; echo "env=$TERM/$COLORTERM"; exec sleep 60`;
    const term = await started(fx.a, command);
    await fx.a.waitOutput(term.termId, 'env=xterm-256color/truecolor');
    const text = fx.a.view(term.termId).text();
    expect(text).toContain('mode-interactive');
    expect(text).toContain('mode-login');
  });

  it.each([
    ['unset', undefined],
    ['relative', 'bash'],
  ])('uses /bin/sh when SHELL is %s', async (_name, shell) => {
    await restart({ SHELL: shell });
    const term = await started(fx.a, 'echo "shell=$0"; exec sleep 60');
    await fx.a.waitOutput(term.termId, 'shell=/bin/sh');
  });

  it('answers the requester with its req and every other watcher with req null', async () => {
    const outsider = await fx.host.client();
    const from = fx.b.mark();
    const reply = await fx.a.request({
      t: 'createTerm',
      worktree: fx.wt,
      preset: 'my-preset',
      command: 'exec sleep 60',
      cols: 100,
      rows: 30,
    });
    const term = { termId: 1, worktree: fx.wt, preset: 'my-preset', cols: 100, rows: 30, exit: null, unseen: false, state: 'idle' };
    expect(reply).toEqual({ t: 'termCreated', req: ANY_REQ, term });
    expect(await fx.b.waitFor('termCreated', () => true, { from })).toEqual({ t: 'termCreated', req: null, term });
    await outsider.expectNone('termCreated', () => true, 300);
  });

  it('counts terminal ids up from 1 without reusing them', async () => {
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await fx.a.create(fx.wt, { command: 'exec sleep 60' })).termId);
    expect(ids).toEqual([1, 2, 3]);
    await fx.a.ok({ t: 'closeTerm', termId: 3 });
    expect((await fx.a.create(fx.wt, { command: 'exec sleep 60' })).termId).toBe(4);
  });

  it('does not attach the creator', async () => {
    const term = await fx.a.create(fx.wt, { command: 'echo visible-output; exec sleep 60' });
    await sleep(500);
    expect(fx.a.received.filter((r) => r.kind !== 'message' && r.termId === term.termId)).toEqual([]);
  });

  it('fails with unknown-worktree for a worktree of a repo this connection does not watch', async () => {
    const outsider = await fx.host.client();
    expect(await outsider.fails({ t: 'createTerm', worktree: fx.wt, preset: 'shell', command: null, cols: 80, rows: 24 })).toBe(
      'unknown-worktree',
    );
  });

  it('fails with unknown-worktree for a path that is not in the list', async () => {
    expect(await fx.a.fails({ t: 'createTerm', worktree: join(fx.repo, 'sub'), preset: 'shell', command: null, cols: 80, rows: 24 })).toBe(
      'unknown-worktree',
    );
  });

  it('fails with spawn-failed when the worktree directory is gone', async () => {
    const gone = addWorktree(fx.repo, join(fx.host.dir, 'gone'), 'gone');
    await fx.a.waitFor('worktreesChanged', (m) => m.worktrees.some((w) => w.path === gone));
    rmSync(gone, { recursive: true });
    await fx.a.waitFor('worktreesChanged', (m) => m.worktrees.some((w) => w.path === gone && w.prunable));
    expect(await fx.a.fails({ t: 'createTerm', worktree: gone, preset: 'shell', command: null, cols: 80, rows: 24 })).toBe('spawn-failed');
  });

  it('fails with spawn-failed when the shell does not exist', async () => {
    await restart({ SHELL: join(fx.host.dir, 'no-such-shell') });
    expect(await fx.a.fails({ t: 'createTerm', worktree: fx.wt, preset: 'shell', command: null, cols: 80, rows: 24 })).toBe('spawn-failed');
  });
});

describe('terminal access', () => {
  it.each([
    ['attach', { t: 'attach', termId: 99 }],
    ['detach', { t: 'detach', termId: 99 }],
    ['closeTerm', { t: 'closeTerm', termId: 99 }],
  ] as const)('fails %s of an unknown terminal with unknown-term', async (_name, body) => {
    expect(await fx.a.fails(body)).toBe('unknown-term');
  });

  it('answers resize and input for an unknown terminal with an uncorrelated unknown-term', async () => {
    let from = fx.a.mark();
    fx.a.send({ t: 'resize', termId: 99, cols: 80, rows: 24 });
    expect(await fx.a.waitFor('error', () => true, { from })).toMatchObject({ req: null, code: 'unknown-term' });
    from = fx.a.mark();
    fx.a.sendInput(99, 'x');
    expect(await fx.a.waitFor('error', () => true, { from })).toMatchObject({ req: null, code: 'unknown-term' });
  });

  it('fails requests for a terminal of a repo the connection does not watch with not-watched', async () => {
    const term = await fx.a.create(fx.wt, { command: 'exec sleep 60' });
    const outsider = await fx.host.client();
    expect(await outsider.fails({ t: 'attach', termId: term.termId })).toBe('not-watched');
    expect(await outsider.fails({ t: 'closeTerm', termId: term.termId })).toBe('not-watched');
    let from = outsider.mark();
    outsider.send({ t: 'resize', termId: term.termId, cols: 80, rows: 24 });
    expect(await outsider.waitFor('error', () => true, { from })).toMatchObject({ req: null, code: 'not-watched' });
    from = outsider.mark();
    outsider.sendInput(term.termId, 'x');
    expect(await outsider.waitFor('error', () => true, { from })).toMatchObject({ req: null, code: 'not-watched' });
  });
});

describe('terminal lifetime', () => {
  it('keeps running when its only client disconnects, keeping the output meanwhile', async () => {
    const term = await started(fx.a, 'sleep 0.8; echo MARKER-AFTER-LEAVE; exec sleep 60');
    fx.a.close();
    await sleep(1500);
    const c = await fx.host.client();
    const state = await c.watch(fx.repo);
    expect(state.terminals.find((t) => t.termId === term.termId)?.exit).toBeNull();
    const view = await c.attach(term.termId);
    expect(await view.screen.text()).toContain('MARKER-AFTER-LEAVE');
  });

  it('keeps running when its client unwatches the repo', async () => {
    const term = await started(fx.a, 'exec sleep 60');
    await fx.a.ok({ t: 'unwatchRepo', repo: fx.repo });
    await fx.b.expectNone('termExited', () => true, 300);
    expect((await fx.b.watch(fx.repo)).terminals.map((t) => t.termId)).toEqual([term.termId]);
  });

  it('delivers a final burst before termExited', async () => {
    const term = await started(fx.a, "read go; head -c 1048576 /dev/zero | tr '\\0' x; exit 0");
    fx.a.sendInput(term.termId, 'go\r');
    await fx.a.waitFor('termExited', (m) => m.termId === term.termId, { timeout: 30_000 });
    const exitedAt = fx.a.received.findIndex((r) => r.kind === 'message' && r.message.t === 'termExited');
    const before = fx.a.received
      .slice(0, exitedAt)
      .reduce((n, r) => n + (r.kind === 'output' && r.termId === term.termId ? countByte(r.data, 0x78) : 0), 0);
    expect(before).toBe(MiB);
  });

  it('reports the exit code to every watcher and keeps the terminal until closed', async () => {
    const term = await fx.a.create(fx.wt, { command: 'exit 3' });
    const expected = { t: 'termExited', termId: term.termId, code: 3, signal: null };
    expect(await fx.a.waitFor('termExited')).toEqual(expected);
    expect(await fx.b.waitFor('termExited')).toEqual(expected);
    const state = await (await fx.host.client()).watch(fx.repo);
    expect(state.terminals.find((t) => t.termId === term.termId)?.exit).toEqual({ code: 3, signal: null });
    await fx.a.ok({ t: 'closeTerm', termId: term.termId });
  });

  it('reports the name of a fatal signal', async () => {
    const term = await fx.a.create(fx.wt, { command: 'kill -KILL $$' });
    expect(await fx.a.waitFor('termExited', (m) => m.termId === term.termId)).toMatchObject({ signal: 'SIGKILL' });
  });

  it('ends the shell and its background job on close, then reports termClosed before done', async () => {
    const term = await fx.a.create(fx.wt, { command: 'sleep 600 & echo $! > bg.pid; echo $$ > sh.pid; wait' });
    const shell = await pidIn(fx.wt, 'sh.pid');
    const job = await pidIn(fx.wt, 'bg.pid');
    const from = fx.a.mark();
    await fx.a.ok({ t: 'closeTerm', termId: term.termId });
    expect(repliesFrom(fx.a, from).map((m) => m.t)).toEqual(['termClosed', 'done']);
    expect(await fx.b.waitFor('termClosed')).toEqual({ t: 'termClosed', termId: term.termId });
    await waitUntil(() => !alive(shell) && !alive(job), 'shell and job to end', 7000);
    expect((await fx.b.watch(fx.repo)).terminals).toEqual([]);
    expect(await fx.a.fails({ t: 'closeTerm', termId: term.termId })).toBe('unknown-term');
  });

  it('kills a shell that ignores SIGHUP 5 s after close', async () => {
    const term = await fx.a.create(fx.wt, { command: "trap '' HUP; echo $$ > sh.pid; while :; do sleep 0.2; done" });
    const shell = await pidIn(fx.wt, 'sh.pid');
    await fx.a.ok({ t: 'closeTerm', termId: term.termId });
    await sleep(3000);
    expect(alive(shell)).toBe(true);
    await waitUntil(() => !alive(shell), 'the shell to be killed', 5000);
  });
});

describe('checked state and layouts', () => {
  const twoPanes = (one: number, two: number): Layout => ({
    tabs: [{ id: 'main', root: { split: 'right', ratio: 0.5, a: { term: one }, b: { term: two } } }],
    active: 0,
  });

  it('broadcasts a checkbox change to every watcher before answering done', async () => {
    const from = fx.a.mark();
    const fromB = fx.b.mark();
    await fx.a.ok({ t: 'setChecked', worktree: fx.wt, checked: true });
    expect(fx.a.messages.slice(from)).toEqual([
      { t: 'checkedChanged', worktree: fx.wt, checked: true },
      { t: 'done', req: ANY_REQ },
    ]);
    expect(await fx.b.waitFor('checkedChanged', () => true, { from: fromB })).toEqual({
      t: 'checkedChanged',
      worktree: fx.wt,
      checked: true,
    });
    expect((await (await fx.host.client()).watch(fx.repo)).checked).toEqual([fx.wt]);
    expect(stateMentions(fx.wt)).toBe(true);
    expect(statSync(fx.host.statePath).mode & 0o777).toBe(0o600);
  });

  it.each<[string, (worktree: string) => RequestBody]>([
    ['setChecked', (worktree) => ({ t: 'setChecked', worktree, checked: true })],
    ['setLayout', (worktree) => ({ t: 'setLayout', worktree, layout: { tabs: [], active: 0 } })],
  ])('fails %s for a worktree not in a watched list with unknown-worktree', async (_name, body) => {
    const outsider = await fx.host.client();
    expect(await outsider.fails(body(fx.wt))).toBe('unknown-worktree');
    expect(await fx.a.fails(body(join(fx.repo, 'sub')))).toBe('unknown-worktree');
  });

  it('broadcasts a layout of the worktree terminals and reports it in repoState', async () => {
    const one = await fx.a.create(fx.wt, { command: 'exec sleep 60' });
    const two = await fx.a.create(fx.wt, { command: 'exec sleep 60' });
    const layout = twoPanes(one.termId, two.termId);
    const from = fx.a.mark();
    await fx.a.ok({ t: 'setLayout', worktree: fx.wt, layout });
    expect(repliesFrom(fx.a, from)).toEqual([
      { t: 'layoutChanged', worktree: fx.wt, layout },
      { t: 'done', req: ANY_REQ },
    ]);
    await fx.b.waitFor('layoutChanged', (m) => m.worktree === fx.wt);
    expect((await (await fx.host.client()).watch(fx.repo)).layouts).toEqual([{ worktree: fx.wt, layout }]);
  });

  it('rejects a layout holding a terminal of another worktree, keeping the stored one', async () => {
    const own = await fx.a.create(fx.wt, { command: 'exec sleep 60' });
    const other = await fx.a.create(fx.repo, { command: 'exec sleep 60' });
    const kept: Layout = { tabs: [{ id: 'only', root: { term: own.termId } }], active: 0 };
    await fx.a.ok({ t: 'setLayout', worktree: fx.wt, layout: kept });
    expect(await fx.a.fails({ t: 'setLayout', worktree: fx.wt, layout: twoPanes(own.termId, other.termId) })).toBe('unknown-term');
    expect(await fx.a.fails({ t: 'setLayout', worktree: fx.wt, layout: twoPanes(own.termId, 999) })).toBe('unknown-term');
    expect((await (await fx.host.client()).watch(fx.repo)).layouts).toEqual([{ worktree: fx.wt, layout: kept }]);
  });

  it('replaces a split by its other half when a terminal in it is closed', async () => {
    const one = await fx.a.create(fx.wt, { command: 'exec sleep 60' });
    const two = await fx.a.create(fx.wt, { command: 'exec sleep 60' });
    const fromSet = fx.b.mark();
    await fx.a.ok({ t: 'setLayout', worktree: fx.wt, layout: twoPanes(one.termId, two.termId) });
    await fx.b.waitFor('layoutChanged', () => true, { from: fromSet });
    const from = fx.b.mark();
    await fx.a.ok({ t: 'closeTerm', termId: one.termId });
    expect(await fx.b.waitFor('layoutChanged', () => true, { from })).toEqual({
      t: 'layoutChanged',
      worktree: fx.wt,
      layout: { tabs: [{ id: 'main', root: { term: two.termId } }], active: 0 },
    });
  });

  it('removes a tab left empty when its last terminal is closed', async () => {
    const one = await fx.a.create(fx.wt, { command: 'exec sleep 60' });
    const fromSet = fx.b.mark();
    await fx.a.ok({ t: 'setLayout', worktree: fx.wt, layout: { tabs: [{ id: 'solo', root: { term: one.termId } }], active: 0 } });
    await fx.b.waitFor('layoutChanged', () => true, { from: fromSet });
    const from = fx.b.mark();
    await fx.a.ok({ t: 'closeTerm', termId: one.termId });
    expect(await fx.b.waitFor('layoutChanged', () => true, { from })).toEqual({
      t: 'layoutChanged',
      worktree: fx.wt,
      layout: { tabs: [], active: 0 },
    });
  });

  it.skipIf(process.getuid?.() === 0)(
    'answers internal for a change that cannot be persisted, keeping state and broadcasting nothing',
    async () => {
      const one = await fx.a.create(fx.wt, { command: 'exec sleep 60' });
      await fx.a.ok({ t: 'setChecked', worktree: fx.repo, checked: true });
      const before = await (await fx.host.client()).watch(fx.repo);
      chmodSync(fx.host.stateDir, 0o500);
      try {
        const fromB = fx.b.mark();
        expect(await fx.a.fails({ t: 'setChecked', worktree: fx.wt, checked: true })).toBe('internal');
        const layout: Layout = { tabs: [{ id: 'solo', root: { term: one.termId } }], active: 0 };
        expect(await fx.a.fails({ t: 'setLayout', worktree: fx.wt, layout })).toBe('internal');
        await sleep(300);
        expect(fx.b.messages.slice(fromB).filter((m) => m.t === 'checkedChanged' || m.t === 'layoutChanged')).toEqual([]);
        const after = await (await fx.host.client()).watch(fx.repo);
        expect({ checked: after.checked, layouts: after.layouts }).toEqual({ checked: before.checked, layouts: before.layouts });
      } finally {
        chmodSync(fx.host.stateDir, 0o700);
      }
    },
  );
});

describe('persistence and pruning', () => {
  it('keeps checked worktrees across a restart and drops layout terminals', async () => {
    const term = await fx.a.create(fx.wt, { command: 'exec sleep 60' });
    await fx.a.ok({ t: 'setChecked', worktree: fx.wt, checked: true });
    await fx.a.ok({ t: 'setLayout', worktree: fx.wt, layout: { tabs: [{ id: 'x', root: { term: term.termId } }], active: 0 } });
    await restart();
    const state = await (await fx.host.client()).watch(fx.repo);
    expect(state.checked).toEqual([fx.wt]);
    expect(state.layouts.find((l) => l.worktree === fx.wt)?.layout.tabs ?? []).toEqual([]);
    expect(state.terminals).toEqual([]);
  });

  it('prunes a removed worktree without terminals', async () => {
    const gone = addWorktree(fx.repo, join(fx.host.dir, 'gone'), 'gone');
    await fx.a.waitFor('worktreesChanged', (m) => m.worktrees.some((w) => w.path === gone));
    await fx.a.ok({ t: 'setChecked', worktree: gone, checked: true });
    expect(stateMentions(gone)).toBe(true);
    git(fx.repo, 'worktree', 'remove', gone);
    await fx.a.waitFor('worktreesChanged', (m) => !m.worktrees.some((w) => w.path === gone));
    await waitUntil(() => !stateMentions(gone), 'the entry to be pruned', 2000);
    expect((await (await fx.host.client()).watch(fx.repo)).checked).toEqual([]);
  });

  it('keeps a removed worktree with a live terminal until the terminal is closed', async () => {
    const gone = addWorktree(fx.repo, join(fx.host.dir, 'gone'), 'gone');
    await fx.a.waitFor('worktreesChanged', (m) => m.worktrees.some((w) => w.path === gone));
    const term = await fx.a.create(gone, { command: 'exec sleep 600' });
    await fx.a.ok({ t: 'setChecked', worktree: gone, checked: true });
    git(fx.repo, 'worktree', 'remove', '--force', gone);
    await fx.a.waitFor('worktreesChanged', (m) => !m.worktrees.some((w) => w.path === gone));
    await sleep(500);
    expect(stateMentions(gone)).toBe(true);
    const state = await (await fx.host.client()).watch(fx.repo);
    expect(state.terminals.map((t) => t.worktree)).toEqual([gone]);
    await fx.a.ok({ t: 'closeTerm', termId: term.termId });
    await waitUntil(() => !stateMentions(gone), 'the entry to be pruned', 2000);
  });

  it('moves a corrupt state file aside and starts with no checked worktrees', async () => {
    await fx.a.ok({ t: 'setChecked', worktree: fx.wt, checked: true });
    fx.a.send({ t: 'shutdown' });
    await fx.daemon.exited;
    writeFileSync(fx.host.statePath, '{"version":1,"repos":[');
    await fx.host.start();
    // The socket answers before the state is loaded; connections wait for it.
    const names = await waitUntil(() => {
      const moved = readdirSync(fx.host.stateDir).filter((n) => n.startsWith('state.json.corrupt-'));
      return moved.length > 0 && moved;
    }, 'the corrupt state file moved aside');
    expect(names).toHaveLength(1);
    expect((await (await fx.host.client()).watch(fx.repo)).checked).toEqual([]);
  });
});
