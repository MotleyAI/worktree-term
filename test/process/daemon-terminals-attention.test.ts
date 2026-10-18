import { describe, expect, it, vi } from 'vitest';
import type { Terminal } from '../../src/protocol/index.js';
import type { DaemonClient, EventOf } from '../support/daemon-client.js';
import { sleep, waitUntil } from '../support/daemon-host.js';
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

  it('sets input on a bell, also in the terminal entry', async () => {
    const term = await a.create(wt, { command: String.raw`sleep 0.3; printf '\a'; exec sleep 60` });
    expect(await a.waitFor('activity', isInput(term.termId))).toEqual({ t: 'activity', termId: term.termId, unseen: true, state: 'input' });
    expect(await entryOf(term.termId)).toMatchObject({ unseen: true, state: 'input' });
  });

  it.each([
    ['OSC 9', String.raw`printf '\033]9;done\a'`],
    ['OSC 777', String.raw`printf '\033]777;notify;t;b\a'`],
    ['OSC 99', String.raw`printf '\033]99;;hi\033\\'`],
  ])('sets input on an %s notification', async (_name, print) => {
    const term = await a.create(wt, { command: `sleep 0.3; ${print}; exec sleep 60` });
    expect(await b.waitFor('activity', isInput(term.termId))).toMatchObject({ state: 'input' });
  });

  it('does not set input on a ConEmu progress report', async () => {
    const from = b.mark();
    const term = await started(a, String.raw`printf '\033]9;4;1;50\a'; sleep 0.3; printf progress-done; exec sleep 60`);
    await a.waitOutput(term.termId, 'progress-done');
    await sleep(700);
    expect(activityOf(b, term.termId, from).filter((m) => m.state === 'input')).toEqual([]);
  });

  it('sets input once for an OSC 777 notification split across output chunks', async () => {
    const from = b.mark();
    const term = await started(
      a,
      String.raw`printf '\033]777;noti'; sleep 0.3; printf 'fy;t;b\a'; sleep 0.3; printf split-done; exec sleep 60`,
    );
    await a.waitOutput(term.termId, 'split-done');
    await sleep(500);
    expect(a.view(term.termId).chunks.some((c) => Buffer.from(c).toString().endsWith('\x1b]777;noti'))).toBe(true);
    expect(activityOf(b, term.termId, from).filter((m) => m.state === 'input')).toHaveLength(1);
  });

  it('ignores a bell answering a tab within 1 s and honours one after', async () => {
    const from = b.mark();
    const term = await started(
      a,
      String.raw`printf 'ready\n'; IFS= read -r -n1 _; printf '\a'; printf rang; sleep 1.5; printf '\a'; exec sleep 60`,
    );
    await a.waitOutput(term.termId, 'ready');
    await sleep(1200);
    a.sendInput(term.termId, '\t');
    await a.waitOutput(term.termId, 'rang');
    await sleep(500);
    expect(activityOf(b, term.termId, from).filter((m) => m.state === 'input')).toEqual([]);
    await b.waitFor('activity', isInput(term.termId), { from });
  });

  it('clears input when a key is typed', async () => {
    const term = await a.create(wt, { command: String.raw`stty -echo; sleep 0.3; printf '\a'; exec sleep 60` });
    await b.waitFor('activity', isInput(term.termId));
    const from = b.mark();
    a.sendInput(term.termId, 'y');
    expect(await b.waitFor('activity', (m) => m.termId === term.termId, { from })).toEqual({
      t: 'activity',
      termId: term.termId,
      unseen: true,
      state: 'working',
    });
  });

  it('keeps input on focus reports and passes them to the program', async () => {
    const term = await a.create(wt, { command: String.raw`stty -echo -icanon; sleep 0.3; printf '\a'; exec cat -v` });
    await a.attach(term.termId);
    await b.waitFor('activity', isInput(term.termId));
    const from = b.mark();
    a.sendInput(term.termId, '\x1b[O\x1b[I');
    await a.waitOutput(term.termId, '^[[O^[[I');
    await sleep(500);
    expect(activityOf(b, term.termId, from)).toEqual([]);
    expect(await entryOf(term.termId)).toMatchObject({ state: 'input' });
  });

  it('keeps input when the program answers a focus report 5 s after the signal at once', async () => {
    const term = await a.create(wt, {
      command: String.raw`stty -echo -icanon; sleep 0.3; printf '\a'; head -c 3 >/dev/null; printf '\033(B\017'; exec sleep 60`,
    });
    await a.attach(term.termId);
    await b.waitFor('activity', isInput(term.termId));
    await sleep(5000);
    const from = b.mark();
    a.sendInput(term.termId, '\x1b[I');
    await waitUntil(() => a.view(term.termId).bytes().includes('\x1b(B\x0f'), 'the reply to the focus report');
    await sleep(500);
    expect(activityOf(b, term.termId, from)).toEqual([]);
    expect(await entryOf(term.termId)).toMatchObject({ state: 'input' });
  });

  it('clears input on output 1.5 s after the signal', async () => {
    const term = await a.create(wt, { command: String.raw`sleep 0.3; printf '\a'; sleep 1.5; printf later; exec sleep 60` });
    await b.waitFor('activity', isInput(term.termId));
    const from = b.mark();
    expect(await b.waitFor('activity', (m) => m.termId === term.termId, { from })).toEqual({
      t: 'activity',
      termId: term.termId,
      unseen: true,
      state: 'working',
    });
  });

  it('keeps input on output 0.5 s after the signal', async () => {
    const term = await started(a, String.raw`sleep 1.3; printf '\a'; sleep 0.5; printf soon; exec sleep 60`);
    await b.waitFor('activity', isInput(term.termId));
    const from = b.mark();
    await a.waitOutput(term.termId, 'soon');
    await sleep(1000);
    expect(activityOf(b, term.termId, from)).toEqual([]);
    expect(await entryOf(term.termId)).toMatchObject({ state: 'input' });
  });
});
