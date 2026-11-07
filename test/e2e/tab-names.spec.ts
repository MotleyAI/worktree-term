import type { Locator, Page } from '@playwright/test';
import { decodeWsData, type Layout } from '../../src/protocol/index.js';
import type { HubHost } from '../support/hub-host.js';
import { byTestId, pane, termTab, TID } from './contract.js';
import {
  activeTerm,
  confirmClose,
  expect,
  LOCAL,
  makeRepoWith,
  newTerminal,
  openPage,
  openUi,
  ready,
  splitPane,
  test,
  typeLine,
  watcher,
} from './fixture.js';
import { boxOf, createsSent, createTerms, layoutsSent, leaf, storeTabs, type Pane } from './panes.js';
import type { WireRecorder } from './wire.js';

const MAX_TABS = 64;

const holds = (root: Pane, termId: number): boolean =>
  'term' in root ? root.term === termId : holds(root.a, termId) || holds(root.b, termId);

/** The name of the stored tab holding `termId`; undefined without a name or such a tab. */
const nameIn = (layout: Layout | undefined, termId: number): string | undefined => layout?.tabs.find((t) => holds(t.root, termId))?.name;

/** Double-clicks the tab's label, away from its close button, and returns the name field it opens. */
const startRename = async (page: Page, termId: number): Promise<Locator> => {
  const tab = page.locator(termTab(termId));
  const box = await boxOf(tab);
  await tab.dblclick({ position: { x: 8, y: box.height / 2 } });
  const field = tab.locator(byTestId(TID.termTabName));
  await expect(field).toBeFocused();
  return field;
};

/** Renames the tab of `termId` to `name` with Enter and waits until the layout stored it. */
const rename = async (page: Page, wire: WireRecorder, termId: number, name: string): Promise<void> => {
  const field = await startRename(page, termId);
  await field.fill(name);
  await field.press('Enter');
  await expect(field).toHaveCount(0);
  await expect.poll(() => nameIn(layoutsSent(wire).at(-1), termId)).toBe(name.trim());
};

/** Input frames the page sent since `from`. */
const inputsSent = (wire: WireRecorder, from: number): number =>
  wire.sentBinary(from).filter((bytes) => decodeWsData(bytes).frame.kind === 'input').length;

/** A page showing one fresh shell tab in a new repo. */
const oneTab = async (hub: HubHost, page: Page): Promise<number> => {
  const { repo } = makeRepoWith(hub, 'app', []);
  hub.writeRepos([repo]);
  await openUi(hub, page);
  return newTerminal(page);
};

const settle = (page: Page): Promise<void> => page.waitForTimeout(300); // NOSONAR(S2925) — absence check: nothing to synchronise on

test.describe('tab names', () => {
  test('a double-click opens the label for editing, and Enter stores the name once, shown on every page and after a reload', async ({
    hub,
    page,
    wire,
    context,
  }) => {
    const term = await oneTab(hub, page);
    const other = await openPage(hub, context);
    await expect(other.page.locator(termTab(term))).toBeVisible();

    await page.locator(termTab(term)).click();
    await expect(page.locator(byTestId(TID.termTabName))).toHaveCount(0);

    const field = await startRename(page, term);
    await expect(field).toHaveValue(`shell ${String(term)}`);
    await expect(field).toHaveAttribute('maxlength', '64');
    expect(await field.evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd])).toEqual([
      0,
      `shell ${String(term)}`.length,
    ]);
    const mark = wire.markSent();
    await page.keyboard.type('build server');
    await page.keyboard.press('Enter');
    await expect(field).toHaveCount(0);
    await expect(page.locator(termTab(term))).toContainText('build server');
    await settle(page);
    expect(layoutsSent(wire, mark).map((l) => nameIn(l, term))).toEqual(['build server']);

    await expect(other.page.locator(termTab(term))).toContainText('build server');
    await expect(other.page.locator(termTab(term))).not.toContainText(`shell ${String(term)}`);
    await page.reload();
    await expect(page.locator(termTab(term))).toContainText('build server');
  });

  test('leaving the field stores the trimmed name', async ({ hub, page, wire }) => {
    const term = await oneTab(hub, page);
    const field = await startRename(page, term);
    await page.keyboard.type('  logs  ');
    await page.locator(byTestId(TID.worktreeSearch)).click();
    await expect(field).toHaveCount(0);
    await expect(page.locator(termTab(term))).toContainText('logs');
    await expect.poll(() => nameIn(layoutsSent(wire).at(-1), term)).toBe('logs');
  });

  test('a name is stored at most 64 characters long', async ({ hub, page, wire }) => {
    const term = await oneTab(hub, page);
    await startRename(page, term);
    await page.keyboard.type('n'.repeat(70));
    await page.keyboard.press('Enter');
    await expect.poll(() => nameIn(layoutsSent(wire).at(-1), term)).toBe('n'.repeat(64));
  });

  test('Escape keeps the name and stores nothing, also when the field then loses focus', async ({ hub, page, wire, context }) => {
    const term = await oneTab(hub, page);
    await rename(page, wire, term, 'logs');
    const other = await openPage(hub, context);
    await expect(other.page.locator(termTab(term))).toContainText('logs');

    const field = await startRename(page, term);
    const mark = wire.markSent();
    await page.keyboard.type('other');
    await page.keyboard.press('Escape');
    await expect(field).toHaveCount(0);
    await page.locator(byTestId(TID.worktreeSearch)).click();
    await settle(page);
    expect(layoutsSent(wire, mark)).toEqual([]);
    for (const p of [page, other.page]) await expect(p.locator(termTab(term))).toContainText('logs');
  });

  test('Enter on the unchanged label of an exited terminal stores no name and keeps the exit note', async ({ hub, page, wire }) => {
    const term = await oneTab(hub, page);
    await ready(page, term);
    await typeLine(page, term, 'exit 1');
    await expect(page.locator(termTab(term))).toContainText('exited');

    const field = await startRename(page, term);
    await expect(field).toHaveValue(`shell ${String(term)}`);
    const mark = wire.markSent();
    await page.keyboard.press('Enter');
    await expect(field).toHaveCount(0);
    await settle(page);
    expect(layoutsSent(wire, mark)).toEqual([]);
    await expect(page.locator(termTab(term))).toContainText(`shell ${String(term)}`);
    await expect(page.locator(termTab(term))).toContainText('exited');
  });

  test('clearing the name labels the tab by its terminal again and stores no name', async ({ hub, page, wire }) => {
    const term = await oneTab(hub, page);
    await rename(page, wire, term, 'logs');
    const field = await startRename(page, term);
    await expect(field).toHaveValue('logs');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Enter');
    await expect(field).toHaveCount(0);
    await expect(page.locator(termTab(term))).toContainText(`shell ${String(term)}`);
    await expect
      .poll(() =>
        layoutsSent(wire)
          .at(-1)
          ?.tabs.find((t) => holds(t.root, term)),
      )
      .not.toHaveProperty('name');
  });

  test('keys typed in the field reach only the field', async ({ hub, page, wire }) => {
    const first = await oneTab(hub, page);
    await ready(page, first);
    const second = await newTerminal(page);
    await ready(page, second);
    const field = await startRename(page, second);
    const mark = wire.markSent();

    await page.keyboard.press('End');
    await page.keyboard.press('Space');
    await page.keyboard.press('Control+Shift+KeyT');
    await page.keyboard.type('xyz');
    await expect(field).toHaveValue(`shell ${String(second)} xyz`);
    await settle(page);
    await expect(page.locator(byTestId(TID.presetPicker))).toHaveCount(0);
    expect(createsSent(wire, mark)).toEqual([]);
    expect(layoutsSent(wire, mark)).toEqual([]);
    expect(inputsSent(wire, mark)).toBe(0);
    expect(await activeTerm(page)).toBe(second);
    await page.keyboard.press('Escape');
  });

  test('renaming a tab missing from the layout adds it to the layout with that name', async ({ hub, page, wire }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const client = await watcher(hub, repo);
    const [stored = 0, outside = 0] = await createTerms(client, repo, 2);
    await storeTabs(client, repo, [leaf(stored)]);
    await expect(page.locator(byTestId(TID.termTab))).toHaveCount(2);

    await rename(page, wire, outside, 'build');
    expect(layoutsSent(wire).at(-1)?.tabs).toEqual([
      { id: expect.any(String), root: leaf(stored) },
      { id: expect.any(String), name: 'build', root: leaf(outside) },
    ]);
  });

  test('a tab a full layout misses cannot be renamed', async ({ hub, page, wire }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const client = await watcher(hub, repo);
    const terms: number[] = [];
    for (let i = 0; i <= MAX_TABS; i++) terms.push((await client.create(repo, { command: 'exec sleep 600' })).termId); // NOSONAR(S9382) — sequential setup
    const outside = terms.at(-1) ?? 0;
    await storeTabs(client, repo, terms.slice(0, MAX_TABS).map(leaf));
    await expect(page.locator(byTestId(TID.termTab))).toHaveCount(MAX_TABS + 1);
    const mark = wire.markSent();

    const tab = page.locator(termTab(outside));
    await tab.scrollIntoViewIfNeeded();
    const box = await boxOf(tab);
    await tab.dblclick({ position: { x: 8, y: box.height / 2 } });
    await settle(page);
    await expect(page.locator(byTestId(TID.termTabName))).toHaveCount(0);
    expect(layoutsSent(wire, mark)).toEqual([]);
  });

  test('a split tab keeps its name when one of its panes closes', async ({ hub, page, wire }) => {
    const left = await oneTab(hub, page);
    await ready(page, left);
    const right = await splitPane(page, 'right');
    await rename(page, wire, left, 'build');

    await page.locator(pane(right)).locator(byTestId(TID.paneClose)).click();
    await confirmClose(page);
    await expect(page.locator(pane(right))).toHaveCount(0);
    await expect(page.locator(termTab(left))).toContainText('build');
    await expect
      .poll(() =>
        wire
          .receivedFromHost(LOCAL)
          .filter((m) => m.t === 'layoutChanged')
          .at(-1),
      )
      .toMatchObject({ layout: { tabs: [{ name: 'build', root: leaf(left) }] } });
  });
});
