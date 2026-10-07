import type { Locator, Page } from '@playwright/test';
import type { Layout } from '../../src/protocol/index.js';
import type { DaemonClient } from '../support/daemon-client.js';
import { byTestId, pane, terminalBox, termTab, TID } from './contract.js';
import { expect, LOCAL, paneIds, pickPreset, type PresetName } from './fixture.js';
import type { WireRecorder } from './wire.js';

export type Pane = Layout['tabs'][number]['root'];

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const leaf = (term: number): Pane => ({ term });

export const split = (dir: 'right' | 'down', a: Pane, b: Pane, ratio = 0.5): Pane => ({ split: dir, ratio, a, b });

/** Creates `count` shells in `worktree` through `client`; returns their ids in order. */
export const createTerms = async (client: DaemonClient, worktree: string, count: number): Promise<number[]> => {
  const ids: number[] = [];
  for (let i = 0; i < count; i++) ids.push((await client.create(worktree)).termId); // NOSONAR(S9382) — sequential setup
  return ids;
};

/** Stores `roots` as the tabs of `worktree`'s layout through `client`. */
export const storeTabs = (client: DaemonClient, worktree: string, roots: readonly Pane[], active = 0): Promise<void> =>
  client.ok({ t: 'setLayout', worktree, layout: { tabs: roots.map((root, i) => ({ id: `t${String(i)}`, root })), active } });

/** `terms` split in halves, alternating right and down; `terms` must not be empty. */
export const balanced = (terms: readonly number[], dir: 'right' | 'down' = 'right'): Pane => {
  const [only] = terms;
  if (terms.length === 1 && only !== undefined) return leaf(only);
  if (terms.length === 0) throw new Error('no terminals');
  const half = Math.ceil(terms.length / 2);
  const next = dir === 'right' ? 'down' : 'right';
  return split(dir, balanced(terms.slice(0, half), next), balanced(terms.slice(half), next));
};

/** Layouts the page sent with `setLayout` since `from`. */
export const layoutsSent = (wire: WireRecorder, from = 0): Layout[] =>
  wire.sentToHost(LOCAL, from).flatMap((m) => (m.t === 'setLayout' ? [m.layout] : []));

/** `createTerm` requests the page sent since `from`. */
export const createsSent = (wire: WireRecorder, from = 0): Extract<ReturnType<WireRecorder['sentToHost']>[number], { t: 'createTerm' }>[] =>
  wire.sentToHost(LOCAL, from).flatMap((m) => (m.t === 'createTerm' ? [m] : []));

/** The root of the layout's active tab. */
export const activeRoot = (layout: Layout | undefined): Pane | undefined => layout?.tabs[layout.active]?.root;

/** The id of the terminal created in reply to this page's own `createTerm` since `from`. */
export const createdTerm = async (wire: WireRecorder, from: number): Promise<number> => {
  let termId = 0;
  await expect
    .poll(() => {
      const created = wire.receivedFromHost(LOCAL, from).find((m) => m.t === 'termCreated' && m.req !== null);
      termId = created?.t === 'termCreated' ? created.term.termId : 0;
      return termId;
    })
    .toBeGreaterThan(0);
  return termId;
};

/** Waits for a pane holding a terminal not in `before` and returns its id once its container is visible. */
export const newPaneAfter = async (page: Page, before: readonly number[]): Promise<number> => {
  let termId = 0;
  await expect
    .poll(async () => {
      termId = (await paneIds(page)).find((id) => !before.includes(id)) ?? 0;
      return termId;
    })
    .toBeGreaterThan(0);
  await expect(page.locator(terminalBox(LOCAL, termId))).toBeVisible();
  return termId;
};

/** Presses Ctrl+Shift+D (right) or Ctrl+Shift+E (down), picks `preset`, and returns the new pane's id. */
export const splitByKey = async (page: Page, dir: 'right' | 'down', preset: PresetName = 'shell'): Promise<number> => {
  const before = await paneIds(page);
  await page.keyboard.press(dir === 'right' ? 'Control+Shift+KeyD' : 'Control+Shift+KeyE');
  await pickPreset(page, preset);
  return newPaneAfter(page, before);
};

/** The bounding box of the element `locator` finds; fails when it is not rendered. */
export const boxOf = async (locator: Locator): Promise<Box> => {
  const box = await locator.boundingBox();
  if (box === null) throw new Error('element is not rendered');
  return box;
};

export const paneBox = (page: Page, termId: number): Promise<Box> => boxOf(page.locator(pane(termId)));

const overlap = (from1: number, size1: number, from2: number, size2: number): number =>
  Math.min(from1 + size1, from2 + size2) - Math.max(from1, from2);

/** Whether `b` lies wholly right of (or below) `a` and overlaps it along the other axis. */
export const beyond = (a: Box, b: Box, dir: 'right' | 'down'): boolean =>
  dir === 'right'
    ? a.x + a.width <= b.x + 0.5 && overlap(a.y, a.height, b.y, b.height) > 0
    : a.y + a.height <= b.y + 0.5 && overlap(a.x, a.width, b.x, b.width) > 0;

/** Waits until `second`'s pane lies wholly right of (or below) `first`'s. */
export const expectPlacement = async (page: Page, first: number, second: number, dir: 'right' | 'down'): Promise<void> => {
  await expect
    .poll(async () => {
      const a = await page.locator(pane(first)).boundingBox();
      const b = await page.locator(pane(second)).boundingBox();
      return a !== null && b !== null && beyond(a, b, dir);
    })
    .toBe(true);
};

/** The share of two sibling panes' combined width (right) or height (down) that `first` takes. */
export const shareOf = async (page: Page, first: number, second: number, dir: 'right' | 'down'): Promise<number> => {
  const a = await paneBox(page, first);
  const b = await paneBox(page, second);
  return dir === 'right' ? a.width / (a.width + b.width) : a.height / (a.height + b.height);
};

/** The divider at `path` ("" for the tab root). */
export const divider = (page: Page, path: string): Locator => page.locator(`${byTestId(TID.divider)}[data-path="${path}"]`);

/** The pointer x (right) or y (down) at which a split of sibling panes `first` and `second` gets `ratio`. */
export const pointFor = async (page: Page, first: number, second: number, dir: 'right' | 'down', ratio: number): Promise<number> => {
  const a = await paneBox(page, first);
  const b = await paneBox(page, second);
  // The gap between the panes is the divider.
  const [from, gap, end] = dir === 'right' ? [a.x, b.x - a.x - a.width, b.x + b.width] : [a.y, b.y - a.y - a.height, b.y + b.height];
  return from + gap / 2 + ratio * (end - from - gap);
};

/** Presses the mouse on the divider's centre and moves it along the split to `to`; the button stays down. */
export const startDrag = async (page: Page, path: string, dir: 'right' | 'down', to: number): Promise<void> => {
  const box = await boxOf(divider(page, path));
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(dir === 'right' ? to : x, dir === 'right' ? y : to, { steps: 10 });
};

/** Whether the terminal's container and screen lie inside its pane and the container spans the pane's width. */
export const fitted = async (page: Page, termId: number): Promise<boolean> => {
  const frame = await page.locator(pane(termId)).boundingBox();
  const container = await page.locator(terminalBox(LOCAL, termId)).boundingBox();
  const screen = await page.locator(terminalBox(LOCAL, termId)).locator('.xterm-screen').boundingBox();
  if (frame === null || container === null || screen === null) return false;
  const inside = (b: Box): boolean =>
    b.x >= frame.x - 1 && b.y >= frame.y - 1 && b.x + b.width <= frame.x + frame.width + 1 && b.y + b.height <= frame.y + frame.height + 1;
  return inside(container) && inside(screen) && container.width >= 0.9 * frame.width;
};

/** Whether the terminal is a pane of the shown tab or has a tab of its own. */
export const reachable = async (page: Page, termId: number): Promise<boolean> =>
  (await paneIds(page)).includes(termId) || (await page.locator(termTab(termId)).count()) > 0;

/** Records on the page whether a preset picker is ever shown from now on. */
export const watchPicker = (page: Page): Promise<void> =>
  page.evaluate((selector) => {
    Reflect.set(window, '__pickerSeen', document.querySelector(selector) !== null);
    new MutationObserver(() => {
      if (document.querySelector(selector) !== null) Reflect.set(window, '__pickerSeen', true);
    }).observe(document.body, { childList: true, subtree: true, attributes: true });
  }, byTestId(TID.presetPicker));

export const pickerSeen = (page: Page): Promise<boolean> => page.evaluate(() => Reflect.get(window, '__pickerSeen') === true);
