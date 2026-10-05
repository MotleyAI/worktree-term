import { chmodSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FLOW_HIGH, MAX_FRAME, type Layout, type Terminal } from '../../src/protocol/index.js';
import { replay, type DaemonClient, type Event, type RequestBody } from '../support/daemon-client.js';
import { addWorktree, alive, DaemonHost, git, makeRepo, sleep, waitUntil, type WtdProcess } from '../support/daemon-host.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

const ANY_REQ: unknown = expect.any(Number);

const KiB = 1024;
const MiB = 1024 * KiB;

let host: DaemonHost;
let daemon: WtdProcess;
let repo: string;
let wt: string;
let a: DaemonClient;
let b: DaemonClient;

beforeEach(async () => {
  host = DaemonHost.create();
  repo = makeRepo(join(host.dir, 'repo'));
  wt = addWorktree(repo, join(host.dir, 'wt'), 'wt');
  daemon = await host.start();
  a = await host.client();
  b = await host.client();
  await a.watch(repo);
  await b.watch(repo);
});

afterEach(async () => {
  await host.cleanup();
});

/**
 * Creates a terminal in `worktree` and attaches `client` to it; an interactive shell is waited for
 * until it has run a command and printed its prompt, so login start-up output is over.
 */
const started = async (
  client: DaemonClient,
  command: string | null,
  { worktree = wt, cols = 80, rows = 24 }: { worktree?: string; cols?: number; rows?: number } = {},
): Promise<Terminal> => {
  const term = await client.create(worktree, { command, cols, rows });
  await client.attach(term.termId);
  if (command === null) {
    client.sendInput(term.termId, 'echo READY-$((6*7))\r');
    await client.waitOutput(term.termId, 'READY-42\r\n', 10_000);
    await sleep(300);
  }
  return term;
};

/** Messages from index `from`, without activity flags, which login start-up output may raise at any time. */
const repliesFrom = (client: DaemonClient, from: number): Event[] => client.messages.slice(from).filter((m) => m.t !== 'activity');

/** Restarts the daemon with extra environment, re-watching from fresh clients. */
const restart = async (env: Record<string, string | undefined> = {}): Promise<void> => {
  a.send({ t: 'shutdown' });
  await daemon.exited;
  daemon = await host.start(env);
  a = await host.client();
  b = await host.client();
  await a.watch(repo);
  await b.watch(repo);
};

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

const stateFile = (): unknown => JSON.parse(readFileSync(host.statePath, 'utf8'));

const stateMentions = (path: string): boolean => existsSync(host.statePath) && JSON.stringify(stateFile()).includes(JSON.stringify(path));

describe('terminal creation', () => {
  it('starts a login interactive shell in the worktree', async () => {
    const term = await started(a, null);
    a.sendInput(term.termId, 'pwd\r');
    await a.waitOutput(term.termId, `${wt}\r\n`);
  });

  it('runs a command in a login interactive shell with TERM and COLORTERM set', async () => {
    const command = `case $- in *i*) echo mode-interactive;; esac; shopt -q login_shell && echo mode-login; echo "env=$TERM/$COLORTERM"; exec sleep 60`;
    const term = await started(a, command);
    await a.waitOutput(term.termId, 'env=xterm-256color/truecolor');
    const text = a.view(term.termId).text();
    expect(text).toContain('mode-interactive');
    expect(text).toContain('mode-login');
  });

  it.each([
    ['unset', undefined],
    ['relative', 'bash'],
  ])('uses /bin/sh when SHELL is %s', async (_name, shell) => {
    await restart({ SHELL: shell });
    const term = await started(a, 'echo "shell=$0"; exec sleep 60');
    await a.waitOutput(term.termId, 'shell=/bin/sh');
  });

  it('answers the requester with its req and every other watcher with req null', async () => {
    const outsider = await host.client();
    const from = b.mark();
    const reply = await a.request({ t: 'createTerm', worktree: wt, preset: 'my-preset', command: 'exec sleep 60', cols: 100, rows: 30 });
    const term = { termId: 1, worktree: wt, preset: 'my-preset', cols: 100, rows: 30, exit: null, unseen: false, bell: false };
    expect(reply).toEqual({ t: 'termCreated', req: ANY_REQ, term });
    expect(await b.waitFor('termCreated', () => true, { from })).toEqual({ t: 'termCreated', req: null, term });
    await outsider.expectNone('termCreated', () => true, 300);
  });

  it('counts terminal ids up from 1 without reusing them', async () => {
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await a.create(wt, { command: 'exec sleep 60' })).termId);
    expect(ids).toEqual([1, 2, 3]);
    await a.ok({ t: 'closeTerm', termId: 3 });
    expect((await a.create(wt, { command: 'exec sleep 60' })).termId).toBe(4);
  });

  it('does not attach the creator', async () => {
    const term = await a.create(wt, { command: 'echo visible-output; exec sleep 60' });
    await sleep(500);
    expect(a.received.filter((r) => r.kind !== 'message' && r.termId === term.termId)).toEqual([]);
  });

  it('fails with unknown-worktree for a worktree of a repo this connection does not watch', async () => {
    const outsider = await host.client();
    expect(await outsider.fails({ t: 'createTerm', worktree: wt, preset: 'shell', command: null, cols: 80, rows: 24 })).toBe(
      'unknown-worktree',
    );
  });

  it('fails with unknown-worktree for a path that is not in the list', async () => {
    expect(await a.fails({ t: 'createTerm', worktree: join(repo, 'sub'), preset: 'shell', command: null, cols: 80, rows: 24 })).toBe(
      'unknown-worktree',
    );
  });

  it('fails with spawn-failed when the worktree directory is gone', async () => {
    const gone = addWorktree(repo, join(host.dir, 'gone'), 'gone');
    await a.waitFor('worktreesChanged', (m) => m.worktrees.some((w) => w.path === gone));
    rmSync(gone, { recursive: true });
    await a.waitFor('worktreesChanged', (m) => m.worktrees.some((w) => w.path === gone && w.prunable));
    expect(await a.fails({ t: 'createTerm', worktree: gone, preset: 'shell', command: null, cols: 80, rows: 24 })).toBe('spawn-failed');
  });

  it('fails with spawn-failed when the shell does not exist', async () => {
    await restart({ SHELL: join(host.dir, 'no-such-shell') });
    expect(await a.fails({ t: 'createTerm', worktree: wt, preset: 'shell', command: null, cols: 80, rows: 24 })).toBe('spawn-failed');
  });
});

describe('terminal access', () => {
  it.each([
    ['attach', { t: 'attach', termId: 99 }],
    ['detach', { t: 'detach', termId: 99 }],
    ['closeTerm', { t: 'closeTerm', termId: 99 }],
  ] as const)('fails %s of an unknown terminal with unknown-term', async (_name, body) => {
    expect(await a.fails(body)).toBe('unknown-term');
  });

  it('answers resize and input for an unknown terminal with an uncorrelated unknown-term', async () => {
    let from = a.mark();
    a.send({ t: 'resize', termId: 99, cols: 80, rows: 24 });
    expect(await a.waitFor('error', () => true, { from })).toMatchObject({ req: null, code: 'unknown-term' });
    from = a.mark();
    a.sendInput(99, 'x');
    expect(await a.waitFor('error', () => true, { from })).toMatchObject({ req: null, code: 'unknown-term' });
  });

  it('fails requests for a terminal of a repo the connection does not watch with not-watched', async () => {
    const term = await a.create(wt, { command: 'exec sleep 60' });
    const outsider = await host.client();
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
    const term = await started(a, 'sleep 0.8; echo MARKER-AFTER-LEAVE; exec sleep 60');
    a.close();
    await sleep(1500);
    const c = await host.client();
    const state = await c.watch(repo);
    expect(state.terminals.find((t) => t.termId === term.termId)?.exit).toBeNull();
    const view = await c.attach(term.termId);
    expect(await view.screen.text()).toContain('MARKER-AFTER-LEAVE');
  });

  it('keeps running when its client unwatches the repo', async () => {
    const term = await started(a, 'exec sleep 60');
    await a.ok({ t: 'unwatchRepo', repo });
    await b.expectNone('termExited', () => true, 300);
    expect((await b.watch(repo)).terminals.map((t) => t.termId)).toEqual([term.termId]);
  });

  it('delivers a final burst before termExited', async () => {
    const term = await started(a, "read go; head -c 1048576 /dev/zero | tr '\\0' x; exit 0");
    a.sendInput(term.termId, 'go\r');
    await a.waitFor('termExited', (m) => m.termId === term.termId, { timeout: 30_000 });
    const exitedAt = a.received.findIndex((r) => r.kind === 'message' && r.message.t === 'termExited');
    const before = a.received
      .slice(0, exitedAt)
      .reduce((n, r) => n + (r.kind === 'output' && r.termId === term.termId ? countByte(r.data, 0x78) : 0), 0);
    expect(before).toBe(MiB);
  });

  it('reports the exit code to every watcher and keeps the terminal until closed', async () => {
    const term = await a.create(wt, { command: 'exit 3' });
    const expected = { t: 'termExited', termId: term.termId, code: 3, signal: null };
    expect(await a.waitFor('termExited')).toEqual(expected);
    expect(await b.waitFor('termExited')).toEqual(expected);
    const state = await (await host.client()).watch(repo);
    expect(state.terminals.find((t) => t.termId === term.termId)?.exit).toEqual({ code: 3, signal: null });
    await a.ok({ t: 'closeTerm', termId: term.termId });
  });

  it('reports the name of a fatal signal', async () => {
    const term = await a.create(wt, { command: 'kill -KILL $$' });
    expect(await a.waitFor('termExited', (m) => m.termId === term.termId)).toMatchObject({ signal: 'SIGKILL' });
  });

  it('ends the shell and its background job on close, then reports termClosed before done', async () => {
    const term = await a.create(wt, { command: 'sleep 600 & echo $! > bg.pid; echo $$ > sh.pid; wait' });
    const shell = await pidIn(wt, 'sh.pid');
    const job = await pidIn(wt, 'bg.pid');
    const from = a.mark();
    await a.ok({ t: 'closeTerm', termId: term.termId });
    expect(repliesFrom(a, from).map((m) => m.t)).toEqual(['termClosed', 'done']);
    expect(await b.waitFor('termClosed')).toEqual({ t: 'termClosed', termId: term.termId });
    await waitUntil(() => !alive(shell) && !alive(job), 'shell and job to end', 7000);
    expect((await b.watch(repo)).terminals).toEqual([]);
    expect(await a.fails({ t: 'closeTerm', termId: term.termId })).toBe('unknown-term');
  });

  it('kills a shell that ignores SIGHUP 5 s after close', async () => {
    const term = await a.create(wt, { command: "trap '' HUP; echo $$ > sh.pid; while :; do sleep 0.2; done" });
    const shell = await pidIn(wt, 'sh.pid');
    await a.ok({ t: 'closeTerm', termId: term.termId });
    await sleep(3000);
    expect(alive(shell)).toBe(true);
    await waitUntil(() => !alive(shell), 'the shell to be killed', 5000);
  });
});

describe('attach and snapshot', () => {
  const GENERATOR = String.raw`
read go
i=0
while [ $i -lt 3000 ]; do printf 'line %05d 中文字符 😀 \033[3%dmcolour\033[0m\n' $i $((i % 7)); i=$((i+1)); done
echo PHASE-ONE
read go
while [ $i -lt 6000 ]; do printf 'line %05d ｗｉｄｅ \033[1;4;3%dmstyled\033[0m\n' $i $((i % 7)); i=$((i+1)); done
printf '\033[?1h\033[?2004h\033[?25l'
printf '\033[?1049h\033[2J\033[Halternate 中文\033[5;10Hplaced \033[1;31mred\033[0m'
printf '\033[3;4HDONE-MARK'
exec sleep 600
`;

  it('restores the same screen, cursor, modes and scrollback for a client attaching mid-output', async () => {
    writeFileSync(join(wt, 'gen.sh'), GENERATOR);
    const term = await started(a, 'bash ./gen.sh');
    a.sendInput(term.termId, 'go\r');
    await a.waitOutput(term.termId, 'PHASE-ONE', 20_000);
    await b.attach(term.termId);
    a.sendInput(term.termId, 'go\r');
    await a.waitOutput(term.termId, 'DONE-MARK', 20_000);
    await b.waitOutput(term.termId, 'DONE-MARK', 20_000);
    const seenByA = await a.view(term.termId).screen.state();
    const seenByB = await b.view(term.termId).screen.state();
    expect(seenByA.buffer).toBe('alternate');
    expect(seenByB).toEqual(seenByA);
  });

  it('continues output exactly at the snapshot offset however attaches interleave with output', async () => {
    const term = await started(a, 'read go; seq 1 400000; echo SEQ-DONE; exec sleep 600');
    a.sendInput(term.termId, 'go\r');
    for (let i = 0; i < 8; i++) {
      await b.attach(term.termId, 20_000);
      await sleep(40);
    }
    await a.waitOutput(term.termId, 'SEQ-DONE', 30_000);
    // B's last attach may come after the output ended, leaving SEQ-DONE in its snapshot.
    await waitUntil(async () => (await b.view(term.termId).screen.text()).includes('SEQ-DONE'), 'SEQ-DONE on B', 30_000);
    const reference = a.view(term.termId);
    const [first] = reference.attachments;
    if (first === undefined) throw new Error('A has no snapshot');
    const all = reference.bytes();
    const view = b.view(term.termId);
    expect(view.gaps).toEqual([]);
    expect(reference.gaps).toEqual([]);
    for (const attachment of view.attachments) {
      if (attachment.firstOutput !== null) expect(attachment.firstOutput).toBe(attachment.snapshotOffset);
      const upTo = all.subarray(0, attachment.snapshotOffset - first.snapshotOffset);
      expect(await replay(80, 24, attachment.snapshot)).toEqual(await replay(80, 24, first.snapshot, upTo));
    }
    const last = view.attachments.at(-1);
    if (last === undefined) throw new Error('B has no snapshot');
    expect(view.bytes().equals(all.subarray(last.snapshotOffset - first.snapshotOffset))).toBe(true);
    const numbers = view
      .text()
      .split('\r\n')
      .filter((line) => /^\d+$/.test(line))
      .map(Number);
    expect(numbers.every((n, i) => i === 0 || n === (numbers[i - 1] ?? 0) + 1)).toBe(true);
  });

  it('shrinks the scrollback of a snapshot that would exceed MAX_FRAME', async () => {
    const awk = `awk 'BEGIN { for (l = 0; l < 5100; l++) { s = ""; for (c = 0; c < 500; c++) s = s "\\033[31ma\\033[32mb"; print s } }'; echo BIG-DONE`;
    const term = await a.create(wt, { command: awk, cols: 1000, rows: 50 });
    await a.waitFor('termExited', (m) => m.termId === term.termId, { timeout: 90_000 });
    const view = await a.attach(term.termId, 60_000);
    const snapshot = view.attachments[0]?.snapshot;
    if (snapshot === undefined) throw new Error('no snapshot');
    expect(snapshot.length).toBeGreaterThan(MiB);
    expect(snapshot.length + 12).toBeLessThanOrEqual(MAX_FRAME);
    expect(await view.screen.text()).toContain('BIG-DONE');
  }, 180_000);

  it('re-attaches with a new snapshot when attaching while attached', async () => {
    const term = await started(a, 'echo hello; exec sleep 60');
    await a.waitOutput(term.termId, 'hello');
    await a.attach(term.termId);
    expect(a.view(term.termId).attachments).toHaveLength(2);
    expect(await a.view(term.termId).screen.text()).toContain('hello');
  });

  it('detaches whether or not attached, and stops output after detaching', async () => {
    const term = await a.create(wt, { command: null });
    await a.ok({ t: 'detach', termId: term.termId });
    await a.attach(term.termId);
    await a.ok({ t: 'detach', termId: term.termId });
    const count = a.received.length;
    b.sendInput(term.termId, 'echo after-detach\r');
    await sleep(500);
    expect(a.received.slice(count).filter((r) => r.kind !== 'message')).toEqual([]);
  });

  it('attaches to an exited terminal', async () => {
    const term = await a.create(wt, { command: 'echo bye-bye; exit 0' });
    await a.waitFor('termExited', (m) => m.termId === term.termId);
    const view = await a.attach(term.termId);
    expect(await view.screen.text()).toContain('bye-bye');
  });
});

describe('output flow control', () => {
  it('evicts a client that never acks while an acking client receives every byte', async () => {
    const term = await started(b, 'read go; seq 1 1500000; echo FLOOD-DONE');
    a.autoAck = false;
    await a.attach(term.termId);
    const goAt = Date.now();
    b.sendInput(term.termId, 'go\r');
    expect(await a.waitFor('detached', () => true, { timeout: 20_000 })).toEqual({ t: 'detached', termId: term.termId, reason: 'lagging' });
    expect(Date.now() - goAt).toBeGreaterThanOrEqual(1900);
    expect(a.view(term.termId).bytes().length).toBeLessThan(FLOW_HIGH + 512 * KiB);
    await b.waitFor('termExited', (m) => m.termId === term.termId, { timeout: 60_000 });
    const view = b.view(term.termId);
    expect(view.gaps).toEqual([]);
    const numbers = view
      .text()
      .split('\r\n')
      .filter((line) => /^\d+$/.test(line));
    expect(numbers).toHaveLength(1_500_000);
    expect(numbers.every((n, i) => Number(n) === i + 1)).toBe(true);
    expect(view.text()).toContain('FLOOD-DONE');
  });

  it('lets an unwatched flood complete and shows its final screen to a later attach', async () => {
    const term = await a.create(wt, { command: 'seq 1 2000000; echo NOBODY-DONE' });
    await a.waitFor('termExited', (m) => m.termId === term.termId, { timeout: 60_000 });
    const text = await (await a.attach(term.termId)).screen.text();
    expect(text).toContain('2000000');
    expect(text).toContain('NOBODY-DONE');
  });

  it('closes a connection that acks beyond the output sent to it, leaving the terminal running', async () => {
    const term = await started(a, 'echo some-output; exec sleep 60');
    await a.waitOutput(term.termId, 'some-output');
    a.send({ t: 'ack', termId: term.termId, offset: a.view(term.termId).position + MiB });
    expect(await a.waitFor('error')).toMatchObject({ req: null, code: 'bad-message' });
    await a.waitClosed();
    expect((await b.watch(repo)).terminals.find((t) => t.termId === term.termId)?.exit).toBeNull();
  });

  it('ignores an ack at or below the current ack position', async () => {
    const term = await started(a, 'echo some-output; exec sleep 60');
    await a.waitOutput(term.termId, 'some-output');
    const position = a.view(term.termId).position;
    a.send({ t: 'ack', termId: term.termId, offset: position });
    a.send({ t: 'ack', termId: term.termId, offset: position });
    a.send({ t: 'ack', termId: term.termId, offset: 0 });
    await a.expectNone('error', () => true, 400);
    expect(a.isClosed).toBe(false);
  });
});

describe('input', () => {
  it('echoes a command round trip', async () => {
    const term = await started(a, null);
    a.sendInput(term.termId, "echo h''i\r");
    await a.waitOutput(term.termId, 'hi\r\n');
  });

  it('writes input frames to the PTY in order', async () => {
    const term = await started(a, 'stty -echo; cat > in.txt');
    const lines = Array.from({ length: 300 }, (_, i) => `line ${String(i)}`);
    for (const line of lines) a.sendInput(term.termId, `${line}\n`);
    a.sendInput(term.termId, '\x04');
    await a.waitFor('termExited', (m) => m.termId === term.termId, { timeout: 10_000 });
    expect(readFileSync(join(wt, 'in.txt'), 'utf8')).toBe(lines.map((l) => `${l}\n`).join(''));
  });

  it('discards input to an exited terminal without an error', async () => {
    const term = await a.create(wt, { command: 'exit 0' });
    await a.waitFor('termExited', (m) => m.termId === term.termId);
    a.sendInput(term.termId, 'ignored\r');
    await a.expectNone('error', () => true, 400);
    expect(a.isClosed).toBe(false);
  });

  it('answers input beyond 1 MiB unaccepted with busy while still processing acks', async () => {
    const stuck = await started(a, 'stty raw -echo; echo READY; exec sleep 600');
    await a.waitOutput(stuck.termId, 'READY');
    const flood = await started(a, 'yes flood-line');
    const before = a.view(flood.termId).position;
    const from = a.mark();
    const frame = new Uint8Array(64 * KiB).fill(0x61);
    for (let i = 0; i < 24; i++) a.sendInput(stuck.termId, frame);
    await a.waitFor('error', (m) => m.code === 'busy', { from });
    await sleep(1000);
    const busy = a.messages.slice(from).filter((m) => m.t === 'error');
    expect(busy.every((m) => m.req === null && m.code === 'busy')).toBe(true);
    expect(busy.length).toBeGreaterThanOrEqual(1);
    expect(busy.length).toBeLessThanOrEqual(8);
    expect(a.view(flood.termId).position - before).toBeGreaterThan(4 * FLOW_HIGH);
    expect(a.isClosed).toBe(false);
  });
});

describe('resize', () => {
  it('sets the size the program sees, the last resize winning', async () => {
    const term = await started(a, null);
    a.resize(term.termId, 90, 20);
    a.resize(term.termId, 100, 30);
    a.sendInput(term.termId, 'stty size\r');
    await a.waitOutput(term.termId, '30 100\r\n');
    const state = await (await host.client()).watch(repo);
    expect(state.terminals.find((t) => t.termId === term.termId)).toMatchObject({ cols: 100, rows: 30 });
  });

  it('resizes the mirror, so snapshots have the new size', async () => {
    const term = await started(a, null);
    a.resize(term.termId, 100, 30);
    a.sendInput(term.termId, `printf '%099d|\\n' 7\r`);
    await a.waitOutput(term.termId, '7|\r\n');
    const c = await host.client();
    await c.watch(repo);
    const view = await c.attach(term.termId);
    expect(await view.screen.text()).toContain(`${'0'.repeat(98)}7|`);
    expect(await view.screen.state()).toEqual(await a.view(term.termId).screen.state());
  });
});

describe('activity', () => {
  it('flags output while hidden as unseen to every watcher', async () => {
    const term = await a.create(wt, { command: 'sleep 0.3; echo out; exec sleep 60' });
    for (const client of [a, b]) {
      expect(await client.waitFor('activity', (m) => m.termId === term.termId)).toEqual({
        t: 'activity',
        termId: term.termId,
        unseen: true,
        bell: false,
      });
    }
  });

  it('flags a bell while hidden', async () => {
    const term = await a.create(wt, { command: "sleep 0.3; printf '\\a'; exec sleep 60" });
    await a.waitFor('activity', (m) => m.termId === term.termId && m.bell);
  });

  it('clears both flags when shown and sends only changes', async () => {
    const term = await started(a, null);
    a.sendInput(term.termId, "printf '\\a'\r");
    await b.waitFor('activity', (m) => m.unseen && m.bell);
    let from = b.mark();
    a.send({ t: 'setVisible', termIds: [term.termId] });
    expect(await b.waitFor('activity', () => true, { from })).toEqual({ t: 'activity', termId: term.termId, unseen: false, bell: false });
    a.sendInput(term.termId, 'echo while-visible\r');
    await a.waitOutput(term.termId, 'while-visible\r\n');
    await b.expectNone('activity', () => true, 400);
    a.send({ t: 'setVisible', termIds: [] });
    from = b.mark();
    a.sendInput(term.termId, 'echo hidden-again\r');
    await b.waitFor('activity', (m) => m.unseen, { from });
    a.sendInput(term.termId, 'echo more\r');
    await b.expectNone('activity', () => true, 400);
  });

  it('withdraws visibility when the showing client disconnects', async () => {
    const term = await started(b, null);
    await b.waitFor('activity', (m) => m.termId === term.termId && m.unseen);
    const c = await host.client();
    await c.watch(repo);
    let from = b.mark();
    c.send({ t: 'setVisible', termIds: [term.termId] });
    await b.waitFor('activity', (m) => !m.unseen, { from });
    c.close();
    await c.waitClosed();
    await sleep(200);
    from = b.mark();
    b.sendInput(term.termId, 'echo after-leave\r');
    await b.waitFor('activity', (m) => m.unseen, { from });
  });

  it('withdraws visibility when the showing client unwatches the repo', async () => {
    const term = await started(b, null);
    await b.waitFor('activity', (m) => m.termId === term.termId && m.unseen);
    let from = b.mark();
    a.send({ t: 'setVisible', termIds: [term.termId] });
    await b.waitFor('activity', (m) => !m.unseen, { from });
    await a.ok({ t: 'unwatchRepo', repo });
    from = b.mark();
    b.sendInput(term.termId, 'echo after-unwatch\r');
    await b.waitFor('activity', (m) => m.unseen, { from });
  });

  it('ignores visibility from a connection that does not watch the repo, and unknown ids', async () => {
    const term = await started(b, null);
    await b.waitFor('activity', (m) => m.termId === term.termId && m.unseen);
    const from = b.mark();
    b.send({ t: 'setVisible', termIds: [term.termId] });
    await b.waitFor('activity', (m) => !m.unseen, { from });
    b.send({ t: 'setVisible', termIds: [] });
    const outsider = await host.client();
    outsider.send({ t: 'setVisible', termIds: [term.termId, 9999] });
    await sleep(200);
    const later = b.mark();
    b.sendInput(term.termId, 'echo hidden\r');
    await b.waitFor('activity', (m) => m.unseen, { from: later });
    await outsider.expectNone('error', () => true, 200);
  });
});

describe('checked state and layouts', () => {
  const twoPanes = (one: number, two: number): Layout => ({
    tabs: [{ id: 'main', root: { split: 'right', ratio: 0.5, a: { term: one }, b: { term: two } } }],
    active: 0,
  });

  it('broadcasts a checkbox change to every watcher before answering done', async () => {
    const from = a.mark();
    const fromB = b.mark();
    await a.ok({ t: 'setChecked', worktree: wt, checked: true });
    expect(a.messages.slice(from)).toEqual([
      { t: 'checkedChanged', worktree: wt, checked: true },
      { t: 'done', req: ANY_REQ },
    ]);
    expect(await b.waitFor('checkedChanged', () => true, { from: fromB })).toEqual({ t: 'checkedChanged', worktree: wt, checked: true });
    expect((await (await host.client()).watch(repo)).checked).toEqual([wt]);
    expect(stateMentions(wt)).toBe(true);
    expect(statSync(host.statePath).mode & 0o777).toBe(0o600);
  });

  it.each<[string, (worktree: string) => RequestBody]>([
    ['setChecked', (worktree) => ({ t: 'setChecked', worktree, checked: true })],
    ['setLayout', (worktree) => ({ t: 'setLayout', worktree, layout: { tabs: [], active: 0 } })],
  ])('fails %s for a worktree not in a watched list with unknown-worktree', async (_name, body) => {
    const outsider = await host.client();
    expect(await outsider.fails(body(wt))).toBe('unknown-worktree');
    expect(await a.fails(body(join(repo, 'sub')))).toBe('unknown-worktree');
  });

  it('broadcasts a layout of the worktree terminals and reports it in repoState', async () => {
    const one = await a.create(wt, { command: 'exec sleep 60' });
    const two = await a.create(wt, { command: 'exec sleep 60' });
    const layout = twoPanes(one.termId, two.termId);
    const from = a.mark();
    await a.ok({ t: 'setLayout', worktree: wt, layout });
    expect(repliesFrom(a, from)).toEqual([
      { t: 'layoutChanged', worktree: wt, layout },
      { t: 'done', req: ANY_REQ },
    ]);
    await b.waitFor('layoutChanged', (m) => m.worktree === wt);
    expect((await (await host.client()).watch(repo)).layouts).toEqual([{ worktree: wt, layout }]);
  });

  it('rejects a layout holding a terminal of another worktree, keeping the stored one', async () => {
    const own = await a.create(wt, { command: 'exec sleep 60' });
    const other = await a.create(repo, { command: 'exec sleep 60' });
    const kept: Layout = { tabs: [{ id: 'only', root: { term: own.termId } }], active: 0 };
    await a.ok({ t: 'setLayout', worktree: wt, layout: kept });
    expect(await a.fails({ t: 'setLayout', worktree: wt, layout: twoPanes(own.termId, other.termId) })).toBe('unknown-term');
    expect(await a.fails({ t: 'setLayout', worktree: wt, layout: twoPanes(own.termId, 999) })).toBe('unknown-term');
    expect((await (await host.client()).watch(repo)).layouts).toEqual([{ worktree: wt, layout: kept }]);
  });

  it('replaces a split by its other half when a terminal in it is closed', async () => {
    const one = await a.create(wt, { command: 'exec sleep 60' });
    const two = await a.create(wt, { command: 'exec sleep 60' });
    const fromSet = b.mark();
    await a.ok({ t: 'setLayout', worktree: wt, layout: twoPanes(one.termId, two.termId) });
    await b.waitFor('layoutChanged', () => true, { from: fromSet });
    const from = b.mark();
    await a.ok({ t: 'closeTerm', termId: one.termId });
    expect(await b.waitFor('layoutChanged', () => true, { from })).toEqual({
      t: 'layoutChanged',
      worktree: wt,
      layout: { tabs: [{ id: 'main', root: { term: two.termId } }], active: 0 },
    });
  });

  it('removes a tab left empty when its last terminal is closed', async () => {
    const one = await a.create(wt, { command: 'exec sleep 60' });
    const fromSet = b.mark();
    await a.ok({ t: 'setLayout', worktree: wt, layout: { tabs: [{ id: 'solo', root: { term: one.termId } }], active: 0 } });
    await b.waitFor('layoutChanged', () => true, { from: fromSet });
    const from = b.mark();
    await a.ok({ t: 'closeTerm', termId: one.termId });
    expect(await b.waitFor('layoutChanged', () => true, { from })).toEqual({
      t: 'layoutChanged',
      worktree: wt,
      layout: { tabs: [], active: 0 },
    });
  });

  it.skipIf(process.getuid?.() === 0)(
    'answers internal for a change that cannot be persisted, keeping state and broadcasting nothing',
    async () => {
      const one = await a.create(wt, { command: 'exec sleep 60' });
      await a.ok({ t: 'setChecked', worktree: repo, checked: true });
      const before = await (await host.client()).watch(repo);
      chmodSync(host.stateDir, 0o500);
      try {
        const fromB = b.mark();
        expect(await a.fails({ t: 'setChecked', worktree: wt, checked: true })).toBe('internal');
        const layout: Layout = { tabs: [{ id: 'solo', root: { term: one.termId } }], active: 0 };
        expect(await a.fails({ t: 'setLayout', worktree: wt, layout })).toBe('internal');
        await sleep(300);
        expect(b.messages.slice(fromB).filter((m) => m.t === 'checkedChanged' || m.t === 'layoutChanged')).toEqual([]);
        const after = await (await host.client()).watch(repo);
        expect({ checked: after.checked, layouts: after.layouts }).toEqual({ checked: before.checked, layouts: before.layouts });
      } finally {
        chmodSync(host.stateDir, 0o700);
      }
    },
  );
});

describe('persistence and pruning', () => {
  it('keeps checked worktrees across a restart and drops layout terminals', async () => {
    const term = await a.create(wt, { command: 'exec sleep 60' });
    await a.ok({ t: 'setChecked', worktree: wt, checked: true });
    await a.ok({ t: 'setLayout', worktree: wt, layout: { tabs: [{ id: 'x', root: { term: term.termId } }], active: 0 } });
    await restart();
    const state = await (await host.client()).watch(repo);
    expect(state.checked).toEqual([wt]);
    expect(state.layouts.find((l) => l.worktree === wt)?.layout.tabs ?? []).toEqual([]);
    expect(state.terminals).toEqual([]);
  });

  it('prunes a removed worktree without terminals', async () => {
    const gone = addWorktree(repo, join(host.dir, 'gone'), 'gone');
    await a.waitFor('worktreesChanged', (m) => m.worktrees.some((w) => w.path === gone));
    await a.ok({ t: 'setChecked', worktree: gone, checked: true });
    expect(stateMentions(gone)).toBe(true);
    git(repo, 'worktree', 'remove', gone);
    await a.waitFor('worktreesChanged', (m) => !m.worktrees.some((w) => w.path === gone));
    await waitUntil(() => !stateMentions(gone), 'the entry to be pruned', 2000);
    expect((await (await host.client()).watch(repo)).checked).toEqual([]);
  });

  it('keeps a removed worktree with a live terminal until the terminal is closed', async () => {
    const gone = addWorktree(repo, join(host.dir, 'gone'), 'gone');
    await a.waitFor('worktreesChanged', (m) => m.worktrees.some((w) => w.path === gone));
    const term = await a.create(gone, { command: 'exec sleep 600' });
    await a.ok({ t: 'setChecked', worktree: gone, checked: true });
    git(repo, 'worktree', 'remove', '--force', gone);
    await a.waitFor('worktreesChanged', (m) => !m.worktrees.some((w) => w.path === gone));
    await sleep(500);
    expect(stateMentions(gone)).toBe(true);
    const state = await (await host.client()).watch(repo);
    expect(state.terminals.map((t) => t.worktree)).toEqual([gone]);
    await a.ok({ t: 'closeTerm', termId: term.termId });
    await waitUntil(() => !stateMentions(gone), 'the entry to be pruned', 2000);
  });

  it('moves a corrupt state file aside and starts with no checked worktrees', async () => {
    await a.ok({ t: 'setChecked', worktree: wt, checked: true });
    a.send({ t: 'shutdown' });
    await daemon.exited;
    writeFileSync(host.statePath, '{"version":1,"repos":[');
    daemon = await host.start();
    const names = readdirSync(host.stateDir).filter((n) => n.startsWith('state.json.corrupt-'));
    expect(names).toHaveLength(1);
    expect((await (await host.client()).watch(repo)).checked).toEqual([]);
  });
});
