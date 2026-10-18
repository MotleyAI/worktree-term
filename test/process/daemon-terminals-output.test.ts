import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FLOW_HIGH, MAX_FRAME } from '../../src/protocol/index.js';
import { replay } from '../support/daemon-client.js';
import { sleep, waitUntil } from '../support/daemon-host.js';
import { fx, KiB, MiB, started, useDaemonTerminalsHost } from '../support/daemon-terminals.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });
useDaemonTerminalsHost();

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
    writeFileSync(join(fx.wt, 'gen.sh'), GENERATOR);
    const term = await started(fx.a, 'bash ./gen.sh');
    fx.a.sendInput(term.termId, 'go\r');
    await fx.a.waitOutput(term.termId, 'PHASE-ONE', 20_000);
    await fx.b.attach(term.termId);
    fx.a.sendInput(term.termId, 'go\r');
    await fx.a.waitOutput(term.termId, 'DONE-MARK', 20_000);
    await fx.b.waitOutput(term.termId, 'DONE-MARK', 20_000);
    const seenByA = await fx.a.view(term.termId).screen.state();
    const seenByB = await fx.b.view(term.termId).screen.state();
    expect(seenByA.buffer).toBe('alternate');
    expect(seenByB).toEqual(seenByA);
  });

  it('continues output exactly at the snapshot offset however attaches interleave with output', async () => {
    const term = await started(fx.a, 'read go; seq 1 400000; echo SEQ-DONE; exec sleep 600');
    fx.a.sendInput(term.termId, 'go\r');
    for (let i = 0; i < 8; i++) {
      await fx.b.attach(term.termId, 20_000);
      await sleep(40);
    }
    await fx.a.waitOutput(term.termId, 'SEQ-DONE', 30_000);
    // B's last attach may come after the output ended, leaving SEQ-DONE in its snapshot.
    await waitUntil(async () => (await fx.b.view(term.termId).screen.text()).includes('SEQ-DONE'), 'SEQ-DONE on B', 30_000);
    const reference = fx.a.view(term.termId);
    const [first] = reference.attachments;
    if (first === undefined) throw new Error('A has no snapshot');
    const all = reference.bytes();
    const view = fx.b.view(term.termId);
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
    // The snapshot may cut a line: its tail starts B's output.
    const numbers = view
      .text()
      .split('\r\n')
      .slice(1)
      .filter((line) => /^\d+$/.test(line))
      .map(Number);
    expect(numbers.every((n, i) => i === 0 || n === (numbers[i - 1] ?? 0) + 1)).toBe(true);
  });

  it('shrinks the scrollback of a snapshot that would exceed MAX_FRAME', async () => {
    const awk = `awk 'BEGIN { for (l = 0; l < 5100; l++) { s = ""; for (c = 0; c < 500; c++) s = s "\\033[31ma\\033[32mb"; print s } }'; echo BIG-DONE`;
    const term = await fx.a.create(fx.wt, { command: awk, cols: 1000, rows: 50 });
    await fx.a.waitFor('termExited', (m) => m.termId === term.termId, { timeout: 90_000 });
    const view = await fx.a.attach(term.termId, 60_000);
    const snapshot = view.attachments[0]?.snapshot;
    if (snapshot === undefined) throw new Error('no snapshot');
    expect(snapshot.length).toBeGreaterThan(MiB);
    expect(snapshot.length + 12).toBeLessThanOrEqual(MAX_FRAME);
    expect(await view.screen.text()).toContain('BIG-DONE');
  }, 180_000);

  it('re-attaches with a new snapshot when attaching while attached', async () => {
    const term = await started(fx.a, 'echo hello; exec sleep 60');
    await fx.a.waitOutput(term.termId, 'hello');
    await fx.a.attach(term.termId);
    expect(fx.a.view(term.termId).attachments).toHaveLength(2);
    expect(await fx.a.view(term.termId).screen.text()).toContain('hello');
  });

  it('detaches whether or not attached, and stops output after detaching', async () => {
    const term = await fx.a.create(fx.wt, { command: null });
    await fx.a.ok({ t: 'detach', termId: term.termId });
    await fx.a.attach(term.termId);
    await fx.a.ok({ t: 'detach', termId: term.termId });
    const count = fx.a.received.length;
    fx.b.sendInput(term.termId, 'echo after-detach\r');
    await sleep(500);
    expect(fx.a.received.slice(count).filter((r) => r.kind !== 'message')).toEqual([]);
  });

  it('attaches to an exited terminal', async () => {
    const term = await fx.a.create(fx.wt, { command: 'echo bye-bye; exit 0' });
    await fx.a.waitFor('termExited', (m) => m.termId === term.termId);
    const view = await fx.a.attach(term.termId);
    expect(await view.screen.text()).toContain('bye-bye');
  });
});

describe('output flow control', () => {
  it('evicts a client that never acks while an acking client receives every byte', async () => {
    const term = await started(fx.b, 'read go; seq 1 1500000; echo FLOOD-DONE');
    fx.a.autoAck = false;
    await fx.a.attach(term.termId);
    const goAt = Date.now();
    fx.b.sendInput(term.termId, 'go\r');
    expect(await fx.a.waitFor('detached', () => true, { timeout: 20_000 })).toEqual({
      t: 'detached',
      termId: term.termId,
      reason: 'lagging',
    });
    expect(Date.now() - goAt).toBeGreaterThanOrEqual(1900);
    expect(fx.a.view(term.termId).bytes().length).toBeLessThan(FLOW_HIGH + 512 * KiB);
    await fx.b.waitFor('termExited', (m) => m.termId === term.termId, { timeout: 60_000 });
    const view = fx.b.view(term.termId);
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
    const term = await fx.a.create(fx.wt, { command: 'seq 1 2000000; echo NOBODY-DONE' });
    await fx.a.waitFor('termExited', (m) => m.termId === term.termId, { timeout: 60_000 });
    const text = await (await fx.a.attach(term.termId)).screen.text();
    expect(text).toContain('2000000');
    expect(text).toContain('NOBODY-DONE');
  });

  it('closes a connection that acks beyond the output sent to it, leaving the terminal running', async () => {
    const term = await started(fx.a, 'echo some-output; exec sleep 60');
    await fx.a.waitOutput(term.termId, 'some-output');
    fx.a.send({ t: 'ack', termId: term.termId, offset: fx.a.view(term.termId).position + MiB });
    expect(await fx.a.waitFor('error')).toMatchObject({ req: null, code: 'bad-message' });
    await fx.a.waitClosed();
    expect((await fx.b.watch(fx.repo)).terminals.find((t) => t.termId === term.termId)?.exit).toBeNull();
  });

  it('ignores an ack at or below the current ack position', async () => {
    const term = await started(fx.a, 'echo some-output; exec sleep 60');
    await fx.a.waitOutput(term.termId, 'some-output');
    const position = fx.a.view(term.termId).position;
    fx.a.send({ t: 'ack', termId: term.termId, offset: position });
    fx.a.send({ t: 'ack', termId: term.termId, offset: position });
    fx.a.send({ t: 'ack', termId: term.termId, offset: 0 });
    await fx.a.expectNone('error', () => true, 400);
    expect(fx.a.isClosed).toBe(false);
  });
});

describe('input', () => {
  it('echoes a command round trip', async () => {
    const term = await started(fx.a, null);
    fx.a.sendInput(term.termId, "echo h''i\r");
    await fx.a.waitOutput(term.termId, 'hi\r\n');
    expect(fx.a.view(term.termId).text()).toContain('hi\r\n');
  });

  it('writes input frames to the PTY in order', async () => {
    const term = await started(fx.a, 'stty -echo; cat > in.txt');
    const lines = Array.from({ length: 300 }, (_, i) => `line ${String(i)}`);
    for (const line of lines) fx.a.sendInput(term.termId, `${line}\n`);
    fx.a.sendInput(term.termId, '\x04');
    await fx.a.waitFor('termExited', (m) => m.termId === term.termId, { timeout: 10_000 });
    expect(readFileSync(join(fx.wt, 'in.txt'), 'utf8')).toBe(lines.map((l) => `${l}\n`).join(''));
  });

  it('discards input to an exited terminal without an error', async () => {
    const term = await fx.a.create(fx.wt, { command: 'exit 0' });
    await fx.a.waitFor('termExited', (m) => m.termId === term.termId);
    fx.a.sendInput(term.termId, 'ignored\r');
    await fx.a.expectNone('error', () => true, 400);
    expect(fx.a.isClosed).toBe(false);
  });

  it('answers input beyond 1 MiB unaccepted with busy while still processing acks', async () => {
    const stuck = await started(fx.a, 'stty raw -echo; echo READY; exec sleep 600');
    await fx.a.waitOutput(stuck.termId, 'READY');
    const flood = await started(fx.a, 'yes flood-line');
    const before = fx.a.view(flood.termId).position;
    const from = fx.a.mark();
    const frame = new Uint8Array(64 * KiB).fill(0x61);
    for (let i = 0; i < 24; i++) fx.a.sendInput(stuck.termId, frame);
    await fx.a.waitFor('error', (m) => m.code === 'busy', { from });
    await waitUntil(() => fx.a.view(flood.termId).position - before > 4 * FLOW_HIGH, 'flood output past the flow window', 10_000);
    const busy = fx.a.messages.slice(from).filter((m) => m.t === 'error');
    expect(busy.every((m) => m.req === null && m.code === 'busy')).toBe(true);
    expect(busy.length).toBeGreaterThanOrEqual(1);
    expect(busy.length).toBeLessThanOrEqual(8);
    expect(fx.a.isClosed).toBe(false);
  });
});

describe('resize', () => {
  it('sets the size the program sees, the last resize winning', async () => {
    const term = await started(fx.a, null);
    fx.a.resize(term.termId, 90, 20);
    fx.a.resize(term.termId, 100, 30);
    fx.a.sendInput(term.termId, 'stty size\r');
    await fx.a.waitOutput(term.termId, '30 100\r\n');
    const state = await (await fx.host.client()).watch(fx.repo);
    expect(state.terminals.find((t) => t.termId === term.termId)).toMatchObject({ cols: 100, rows: 30 });
  });

  it('resizes the mirror, so snapshots have the new size', async () => {
    const term = await started(fx.a, null);
    fx.a.resize(term.termId, 100, 30);
    fx.a.sendInput(term.termId, `printf '%099d|\\n' 7\r`);
    await fx.a.waitOutput(term.termId, '7|\r\n');
    const c = await fx.host.client();
    await c.watch(fx.repo);
    const view = await c.attach(term.termId);
    expect(await view.screen.text()).toContain(`${'0'.repeat(98)}7|`);
    expect(await view.screen.state()).toEqual(await fx.a.view(term.termId).screen.state());
  });
});
