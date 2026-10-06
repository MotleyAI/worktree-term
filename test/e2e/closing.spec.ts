import type { Locator, Page } from '@playwright/test';
import { byTestId, pane, termTab, TID } from './contract.js';
import {
  confirmClose,
  expect,
  LOCAL,
  makeRepoWith,
  newTerminal,
  openPage,
  openUi,
  paneIds,
  ready,
  splitPane,
  test,
  typeLine,
  waitScreen,
  watcher,
} from './fixture.js';
import type { WireRecorder } from './wire.js';

/** Terminal ids of the `closeTerm` requests the page sent since `from`, sorted. */
const closesSent = (wire: WireRecorder, from: number): number[] =>
  wire
    .sentToHost(LOCAL, from)
    .flatMap((m) => (m.t === 'closeTerm' ? [m.termId] : []))
    .sort((a, b) => a - b);

/** Waits until the page heard that the terminal exited. */
const exited = async (wire: WireRecorder, termId: number): Promise<void> => {
  await expect.poll(() => wire.receivedFromHost(LOCAL).some((m) => m.t === 'termExited' && m.termId === termId)).toBe(true);
};

const dialogOf = (page: Page): Locator => page.locator(byTestId(TID.closeDialog));

/** A tab of a running shell `left` and a pane `right` split off it. */
const twoPanes = async (page: Page, preset: 'shell' | 'cat' = 'shell'): Promise<{ left: number; right: number }> => {
  const left = await newTerminal(page);
  await ready(page, left);
  const right = await splitPane(page, 'right', preset);
  return { left, right };
};

test.describe('closing terminals', () => {
  test('Ctrl+Shift+W on a running pane and then Escape closes nothing and the shell keeps running', async ({ hub, page, wire }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const term = await newTerminal(page);
    await ready(page, term);
    const mark = wire.markSent();

    await page.keyboard.press('Control+Shift+KeyW');
    await expect(dialogOf(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialogOf(page)).toHaveCount(0);
    await page.waitForTimeout(500); // NOSONAR(S2925) — absence check: nothing to synchronise on
    expect(closesSent(wire, mark)).toEqual([]);
    await typeLine(page, term, "echo STILL''-RUNNING");
    await waitScreen(page, term, 'STILL-RUNNING');
  });

  test('Ctrl+Shift+W and then Enter closes the focused pane', async ({ hub, page, wire }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const { left, right } = await twoPanes(page);
    const mark = wire.markSent();

    await page.keyboard.press('Control+Shift+KeyW');
    await expect(dialogOf(page)).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(dialogOf(page)).toHaveCount(0);
    await expect.poll(() => closesSent(wire, mark)).toEqual([right]);
    await expect.poll(() => paneIds(page)).toEqual([left]);
  });

  test('closing a tab of two running panes and confirming closes both, and the tab leaves every page', async ({
    hub,
    page,
    wire,
    context,
  }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const { left, right } = await twoPanes(page);
    const other = await openPage(hub, context);
    await expect(other.page.locator(termTab(left))).toBeVisible();
    const mark = wire.markSent();

    await page.locator(termTab(left)).locator(byTestId(TID.termTabClose)).click();
    await expect(dialogOf(page).locator(byTestId(TID.closeTarget))).toHaveCount(2);
    await confirmClose(page);
    await expect.poll(() => closesSent(wire, mark)).toEqual([left, right].sort((a, b) => a - b));
    for (const p of [page, other.page]) {
      await expect(p.locator(termTab(left))).toHaveCount(0);
      await expect(p.locator(byTestId(TID.pane))).toHaveCount(0);
    }
  });

  test('the dialog lists the running terminals by preset and id', async ({ hub, page }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const { left, right } = await twoPanes(page, 'cat');

    await page.locator(termTab(left)).locator(byTestId(TID.termTabClose)).click();
    const targets = dialogOf(page).locator(byTestId(TID.closeTarget));
    await expect(targets).toHaveCount(2);
    await expect(targets.nth(0)).toContainText('shell');
    await expect(targets.nth(0)).toContainText(String(left));
    await expect(targets.nth(1)).toContainText('cat');
    await expect(targets.nth(1)).toContainText(String(right));
    await dialogOf(page).locator(byTestId(TID.closeCancel)).click();
    await expect(dialogOf(page)).toHaveCount(0);
  });

  test('an exited pane closes without a dialog', async ({ hub, page, wire }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const { left, right } = await twoPanes(page);
    await typeLine(page, right, 'exit');
    await exited(wire, right);
    const mark = wire.markSent();

    await page.locator(pane(right)).locator(byTestId(TID.paneClose)).click();
    await expect.poll(() => closesSent(wire, mark)).toEqual([right]);
    await expect(dialogOf(page)).toHaveCount(0);
    await expect.poll(() => paneIds(page)).toEqual([left]);
  });

  test('cancelling the close of a tab holding an exited and a running pane closes nothing', async ({ hub, page, wire }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const { left, right } = await twoPanes(page);
    await typeLine(page, right, 'exit');
    await exited(wire, right);
    const mark = wire.markSent();

    await page.locator(termTab(left)).locator(byTestId(TID.termTabClose)).click();
    const targets = dialogOf(page).locator(byTestId(TID.closeTarget));
    await expect(targets).toHaveCount(1);
    await expect(targets).toContainText(String(left));
    await dialogOf(page).locator(byTestId(TID.closeCancel)).click();
    await expect(dialogOf(page)).toHaveCount(0);
    await page.waitForTimeout(500); // NOSONAR(S2925) — absence check: nothing to synchronise on
    expect(closesSent(wire, mark)).toEqual([]);
    expect(await paneIds(page)).toEqual([left, right]);
  });

  test('the dialog closes by itself when its terminals are closed elsewhere', async ({ hub, page, wire }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const client = await watcher(hub, repo);
    const { left, right } = await twoPanes(page);
    const mark = wire.markSent();

    await page.locator(termTab(left)).locator(byTestId(TID.termTabClose)).click();
    await expect(dialogOf(page)).toBeVisible();
    await client.ok({ t: 'closeTerm', termId: left });
    await client.ok({ t: 'closeTerm', termId: right });
    await expect(dialogOf(page)).toHaveCount(0);
    await page.waitForTimeout(500); // NOSONAR(S2925) — absence check: nothing to synchronise on
    expect(closesSent(wire, mark)).toEqual([]);
  });

  test('confirming after one target was closed elsewhere closes only the one still live', async ({ hub, page, wire }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const client = await watcher(hub, repo);
    const { left, right } = await twoPanes(page);
    const mark = wire.markSent();

    await page.locator(termTab(left)).locator(byTestId(TID.termTabClose)).click();
    await expect(dialogOf(page)).toBeVisible();
    await client.ok({ t: 'closeTerm', termId: right });
    await expect.poll(() => paneIds(page)).toEqual([left]);
    await confirmClose(page);
    await expect.poll(() => closesSent(wire, mark)).toEqual([left]);
    await page.waitForTimeout(500); // NOSONAR(S2925) — absence check: nothing to synchronise on
    expect(closesSent(wire, mark)).toEqual([left]);
    await expect(page.locator(termTab(left))).toHaveCount(0);
  });
});
