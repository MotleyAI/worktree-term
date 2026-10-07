import type { Page } from '@playwright/test';
import type { DaemonClient } from '../support/daemon-client.js';
import type { HubHost } from '../support/hub-host.js';
import { COMMANDS, expectUnseen, runIn, setPageHidden, unseenOf, visibleSent } from './attention-helpers.js';
import { byTestId, pane, terminalBox, TID } from './contract.js';
import { expect, LOCAL, makeRepoWith, openUi, stopHub, test, watcher } from './fixture.js';
import { leaf, split, storeTabs } from './panes.js';

/** Opens the UI on a repo whose only tab is one ticking terminal, shown and seen; returns the watching client and the terminal. */
const shownTicker = async (hub: HubHost, page: Page): Promise<{ client: DaemonClient; term: number }> => {
  const { repo } = makeRepoWith(hub, 'app', []);
  hub.writeRepos([repo]);
  await openUi(hub, page);
  const client = await watcher(hub, repo);
  const term = await runIn(client, repo, COMMANDS.ticker);
  await storeTabs(client, repo, [leaf(term)]);
  await expect(page.locator(terminalBox(LOCAL, term))).toBeVisible();
  await expectUnseen(client, term, false);
  return { client, term };
};

test.describe('page visibility', () => {
  test('a hidden page tells the host it shows nothing, so a shown terminal printing output becomes unseen', async ({ hub, page, wire }) => {
    const { client, term } = await shownTicker(hub, page);
    const mark = wire.markSent();
    await setPageHidden(page, true);
    await expect.poll(() => visibleSent(wire, mark)).toContainEqual([]);
    expect(visibleSent(wire, mark).at(-1)).toEqual([]);
    await expectUnseen(client, term, true);
  });

  test('a page visible again sends the terminals it shows and their unseen becomes false', async ({ hub, page, wire }) => {
    const { client, term } = await shownTicker(hub, page);
    await setPageHidden(page, true);
    await expectUnseen(client, term, true);

    const mark = wire.markSent();
    await setPageHidden(page, false);
    await expect.poll(() => visibleSent(wire, mark).at(-1)).toEqual([term]);
    await expectUnseen(client, term, false);
  });

  test('pagehide sends setVisible with no terminals', async ({ hub, page, wire }) => {
    const { client, term } = await shownTicker(hub, page);
    const mark = wire.markSent();
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })));
    await expect.poll(() => visibleSent(wire, mark)).toContainEqual([]);
    await expectUnseen(client, term, true);
  });

  test('leaving the page withdraws its terminals from the host', async ({ hub, page }) => {
    const { client, term } = await shownTicker(hub, page);
    await page.goto('about:blank');
    await expectUnseen(client, term, true);
  });

  test('after a hub restart the daemon counts both panes of the shown tab as visible again', async ({ hub, page, wire }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const client = await watcher(hub, repo);
    const left = await runIn(client, repo, COMMANDS.ticker);
    const right = await runIn(client, repo, COMMANDS.ticker);
    await storeTabs(client, repo, [split('right', leaf(left), leaf(right))]);
    await expect(page.locator(pane(left))).toBeVisible();
    await expect(page.locator(pane(right))).toBeVisible();
    for (const term of [left, right]) await expectUnseen(client, term, false);

    // The hub's link closing withdraws its visibility, so both ticking terminals become unseen.
    await stopHub(hub);
    for (const term of [left, right]) await expectUnseen(client, term, true);
    await expect(page.locator(byTestId(TID.reconnecting))).toBeVisible();
    const mark = wire.markSent();
    await hub.startHub();
    await expect(page.locator(byTestId(TID.reconnecting))).toBeHidden({ timeout: 15_000 });
    await expect.poll(() => visibleSent(wire, mark).at(-1), { timeout: 15_000 }).toEqual([left, right].sort((a, b) => a - b));
    for (const term of [left, right]) await expectUnseen(client, term, false, 15_000);
    await client.expectNone('activity', (m) => (m.termId === left || m.termId === right) && m.unseen, 1500);
    expect([unseenOf(client, left), unseenOf(client, right)]).toEqual([false, false]);
  });
});
