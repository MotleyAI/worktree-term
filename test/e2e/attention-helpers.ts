import type { Page } from '@playwright/test';
import type { DaemonClient } from '../support/daemon-client.js';
import { byTestId, type MARKS, TID } from './contract.js';
import { expect, LOCAL, markOf } from './fixture.js';
import type { WireRecorder } from './wire.js';

export type Mark = (typeof MARKS)[number];

/** Commands for terminals created through a DaemonClient. */
export const COMMANDS = {
  /** Prints a line every 0.3 s, so it never becomes idle. */
  ticker: 'while :; do echo TICK; sleep 0.3; done',
  /** Rings the bell once, well after start, then stays silent. */
  ring: "sleep 1.5; printf '\\a'; exec sleep 600",
  /** Prints one line, then stays silent. */
  oneLine: "echo ONE''-LINE; exec sleep 600",
  /** Prints nothing. */
  quiet: 'exec sleep 600',
  /** Exits with code 1 after a second. */
  fail: 'sleep 1; exit 1',
  /** Exits with code 0 after a second. */
  succeed: 'sleep 1; exit 0',
} as const;

/** Creates a terminal running `command` in `worktree` through `client`; returns its id. */
export const runIn = async (client: DaemonClient, worktree: string, command: string): Promise<number> =>
  (await client.create(worktree, { preset: 'probe', command })).termId;

/** Waits until the element `selector` finds shows `mark` (null: no mark). */
export const expectMark = async (page: Page, selector: string, mark: Mark | null, timeout = 10_000): Promise<void> => {
  await expect.poll(() => markOf(page, selector), { timeout }).toBe(mark);
};

/** The `title` of the mark inside the element `selector` finds; '' without one. */
export const markTitle = async (page: Page, selector: string): Promise<string> => {
  const mark = page.locator(selector).locator(byTestId(TID.mark));
  return (await mark.count()) === 0 ? '' : ((await mark.getAttribute('title')) ?? '');
};

/** Whether `title` names each mark of `counts` with its number, one mark per comma-, semicolon- or line-separated part. */
export const titleGives = (title: string, counts: Partial<Record<Mark, number>>): boolean => {
  const parts = title.split(/[,;\n]/);
  return Object.entries(counts).every(([mark, count]) =>
    parts.some((part) => part.includes(mark) && new RegExp(String.raw`(^|\D)${String(count)}(\D|$)`).test(part)),
  );
};

/** Waits until the mark inside the element `selector` finds gives `counts` on hover. */
export const expectCounts = async (
  page: Page,
  selector: string,
  counts: Partial<Record<Mark, number>>,
  timeout = 10_000,
): Promise<void> => {
  await expect.poll(async () => titleGives(await markTitle(page, selector), counts), { timeout }).toBe(true);
};

/** The terminal's latest `unseen` as `client` heard it; null when it heard nothing of the terminal. */
export const unseenOf = (client: DaemonClient, termId: number): boolean | null => {
  for (const message of [...client.messages].reverse()) {
    if (message.t === 'activity' && message.termId === termId) return message.unseen;
    if (message.t === 'termCreated' && message.term.termId === termId) return message.term.unseen;
    if (message.t === 'repoState') {
      const entry = message.terminals.find((t) => t.termId === termId);
      if (entry !== undefined) return entry.unseen;
    }
  }
  return null;
};

/** Waits until `client` heard that the terminal's `unseen` is `value`. */
export const expectUnseen = async (client: DaemonClient, termId: number, value: boolean, timeout = 10_000): Promise<void> => {
  await expect.poll(() => unseenOf(client, termId), { timeout }).toBe(value);
};

/** The sorted terminal ids of each `setVisible` the page sent to the local host since `from`. */
export const visibleSent = (wire: WireRecorder, from = 0): number[][] =>
  wire.sentToHost(LOCAL, from).flatMap((m) => (m.t === 'setVisible' ? [[...m.termIds].sort((a, b) => a - b)] : []));

/**
 * Makes the page report itself hidden or visible and fires `visibilitychange`.
 * Headless Chrome keeps every page visible (a second page brought to front hides nothing), so the state is overridden.
 */
export const setPageHidden = (page: Page, hidden: boolean): Promise<void> =>
  page.evaluate((isHidden) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (isHidden ? 'hidden' : 'visible') });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => isHidden });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
