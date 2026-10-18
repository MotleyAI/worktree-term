import { describe, expect, it, vi } from 'vitest';
import type { Terminal } from '../../src/protocol/index.js';
import type { DaemonClient, EventOf } from '../support/daemon-client.js';
import { sleep } from '../support/daemon-host.js';
import { a, b, host, repo, started, useDaemonTerminalsHost, wt } from '../support/daemon-terminals.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });
useDaemonTerminalsHost();

describe('activity', () => {
  /** Activity messages about `termId` that `client` received from index `from`. */
  const activityOf = (client: DaemonClient, termId: number, from: number): EventOf<'activity'>[] =>
    client.messages.slice(from).filter((m): m is EventOf<'activity'> => m.t === 'activity' && m.termId === termId);

  const isInput =
    (termId: number): ((m: EventOf<'activity'>) => boolean) =>
    (m) =>
      m.termId === termId && m.state === 'input';

  /** The terminal entry a fresh watcher of the repo receives. */
  const entryOf = async (termId: number): Promise<Terminal | undefined> =>
    (await (await host.client()).watch(repo)).terminals.find((t) => t.termId === termId);

  it('flags output while hidden as unseen and working to every watcher', async () => {
    const term = await a.create(wt, { command: 'sleep 0.3; echo out; exec sleep 60' });
    for (const client of [a, b]) {
      expect(await client.waitFor('activity', (m) => m.termId === term.termId && m.unseen && m.state === 'working')).toEqual({
        t: 'activity',
        termId: term.termId,
        unseen: true,
        state: 'working',
      });
    }
  });

  it('keeps unseen false while one of two clients shows the terminal', async () => {
    const term = await a.create(wt, { command: 'read -r _; echo shown-output; exec sleep 60' });
    a.send({ t: 'setVisible', termIds: [term.termId] });
    await a.attach(term.termId);
    const from = b.mark();
    a.sendInput(term.termId, '\r');
    await a.waitOutput(term.termId, 'shown-output');
    await sleep(300);
    expect(activityOf(b, term.termId, from).filter((m) => m.unseen)).toEqual([]);
    expect(await entryOf(term.termId)).toMatchObject({ unseen: false, state: 'working' });
  });

  it('clears unseen when shown, keeps the state, and sends only changes', async () => {
    const term = await started(a, null);
    a.sendInput(term.termId, "sleep 1.2; printf '\\a'\r");
    await b.waitFor('activity', (m) => isInput(term.termId)(m) && m.unseen, { timeout: 10_000 });
    let from = b.mark();
    a.send({ t: 'setVisible', termIds: [term.termId] });
    expect(await b.waitFor('activity', () => true, { from })).toEqual({
      t: 'activity',
      termId: term.termId,
      unseen: false,
      state: 'input',
    });
    from = b.mark();
    a.sendInput(term.termId, 'echo while-visible\r');
    await a.waitOutput(term.termId, 'while-visible\r\n');
    await sleep(400);
    expect(activityOf(b, term.termId, from)).toEqual([{ t: 'activity', termId: term.termId, unseen: false, state: 'working' }]);
    a.send({ t: 'setVisible', termIds: [] });
    from = b.mark();
    a.sendInput(term.termId, 'echo hidden-again\r');
    expect(await b.waitFor('activity', (m) => m.unseen, { from })).toEqual({
      t: 'activity',
      termId: term.termId,
      unseen: true,
      state: 'working',
    });
    a.sendInput(term.termId, 'echo more\r');
    await b.expectNone('activity', () => true, 400);
  });

  it('flags an exit while hidden as unseen', async () => {
    const term = await a.create(wt, { command: 'read -r _; exec sleep 1' });
    a.send({ t: 'setVisible', termIds: [term.termId] });
    await a.attach(term.termId);
    a.sendInput(term.termId, '\r');
    await sleep(400);
    a.send({ t: 'setVisible', termIds: [] });
    const from = b.mark();
    const position = a.view(term.termId).position;
    await b.waitFor('termExited', (m) => m.termId === term.termId, { from });
    expect(await b.waitFor('activity', (m) => m.termId === term.termId && m.unseen, { from })).toEqual({
      t: 'activity',
      termId: term.termId,
      unseen: true,
      state: 'working',
    });
    expect(a.view(term.termId).position).toBe(position);
  });

  it('reports working, then idle 3 s after the last output', async () => {
    const from = b.mark();
    const term = await started(a, 'echo quiet-line; exec sleep 60');
    await a.waitOutput(term.termId, 'quiet-line');
    const outputAt = Date.now();
    await b.waitFor('activity', (m) => m.termId === term.termId && m.state === 'idle', { from, timeout: 8000 });
    const idleAt = Date.now();
    expect(idleAt - outputAt).toBeGreaterThanOrEqual(2800);
    expect(idleAt - outputAt).toBeLessThanOrEqual(4500);
    const states = activityOf(b, term.termId, from)
      .map((m) => m.state)
      .filter((state, i, all) => i === 0 || state !== all[i - 1]);
    expect(states.slice(-2)).toEqual(['working', 'idle']);
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
    expect(await b.waitFor('activity', (m) => m.unseen, { from })).toMatchObject({ termId: term.termId, unseen: true });
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
    expect(await b.waitFor('activity', (m) => m.unseen, { from })).toMatchObject({ termId: term.termId, unseen: true });
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
    expect(await b.waitFor('activity', (m) => m.unseen, { from: later })).toMatchObject({ termId: term.termId, unseen: true });
    await outsider.expectNone('error', () => true, 200);
  });
});
