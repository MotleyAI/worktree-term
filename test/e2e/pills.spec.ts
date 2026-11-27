import type { Locator, Page } from '@playwright/test';
import { join } from 'node:path';
import type { FakeSsh } from '../support/fake-ssh.js';
import type { HubHost } from '../support/hub-host.js';
import { byTestId, groupTab, TID, worktreeAt } from './contract.js';
import { expect, LOCAL, openPage, openUi, REMOTE, test, writeHubConfig } from './fixture.js';
import { cloneAt, dropLinks, installedRemote, listedRows, pillOf, plainPath, row, selectGroup, selectRow } from './origins.js';

const BOX = REMOTE;
const REMOTE_TIMEOUT = { timeout: 20_000 };
/** `--danger`, as computed. */
const DANGER = 'rgb(241, 76, 76)';

/** The pill's computed background, text and border colours. */
const coloursOf = (pill: Locator): Promise<string[]> =>
  pill.evaluate((el) => {
    const style = getComputedStyle(el);
    return [style.backgroundColor, style.color, style.borderTopColor];
  });

const opacityOf = (pill: Locator): Promise<number> => pill.evaluate((el) => Number(getComputedStyle(el).opacity));

const boxOf = async (locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> => {
  const box = await locator.boundingBox();
  if (box === null) throw new Error('the element is not shown');
  return box;
};

/** This machine lists `<hub>/r/app` (worktree `feat`) and box lists `<box home>/srv/app` (worktree `branch`), both of origin `app`; opens the page. */
const sharedApp = async (
  hub: HubHost,
  ssh: FakeSsh,
  page: Page,
  branch = 'fix',
): Promise<{ local: string; feat: string; boxApp: string; fix: string }> => {
  plainPath(hub);
  const remote = await installedRemote(hub, ssh, 'box');
  const local = cloneAt(join(hub.dir, 'r', 'app'), 'app', ['feat']);
  const boxApp = cloneAt(join(remote.home, 'srv', 'app'), 'app', [branch]);
  writeHubConfig(hub, { repos: [local.repo], hosts: [{ name: 'box', ssh: 'box', repos: [boxApp.repo] }] });
  await openUi(hub, page);
  const shared = { local: local.repo, feat: local.worktrees[0] ?? '', boxApp: boxApp.repo, fix: boxApp.worktrees[0] ?? '' };
  await expect(page.locator(worktreeAt(BOX, shared.boxApp))).toBeVisible(REMOTE_TIMEOUT);
  return shared;
};

test.describe('host and clone pills', () => {
  test('rows of box carry the pill box, rows of this machine none', async ({ hub, page, ssh }) => {
    test.setTimeout(120_000);
    const { local, feat, boxApp, fix } = await sharedApp(hub, ssh, page);
    await expect(pillOf(page, BOX, boxApp)).toHaveText('box');
    await expect(pillOf(page, BOX, fix)).toHaveText('box');
    await expect(pillOf(page, BOX, boxApp)).toHaveAttribute('title', 'box: connected');
    await expect(pillOf(page, LOCAL, local)).toHaveCount(0);
    await expect(pillOf(page, LOCAL, feat)).toHaveCount(0);
  });

  test('a single clone on this machine shows no pill', async ({ hub, page }) => {
    plainPath(hub);
    const { repo, worktrees } = cloneAt(join(hub.dir, 'r', 'app'), 'app', ['feat']);
    writeHubConfig(hub, { repos: [repo] });
    await openUi(hub, page);
    await expect(page.locator(worktreeAt(LOCAL, worktrees[0] ?? ''))).toBeVisible();
    await expect(page.locator(byTestId(TID.hostPill))).toHaveCount(0);
  });

  test('with several clones on one host, box’s pills name the clone and this machine’s show the clone alone', async ({
    hub,
    page,
    ssh,
  }) => {
    test.setTimeout(120_000);
    plainPath(hub);
    const remote = await installedRemote(hub, ssh, 'box');
    const root = join(hub.dir, 'r');
    const app = cloneAt(join(root, 'app'), 'app').repo;
    const app2 = cloneAt(join(root, 'app-2'), 'app').repo;
    const srvApp = cloneAt(join(remote.home, 'srv', 'app'), 'app').repo;
    const xApp = cloneAt(join(remote.home, 'srv', 'x', 'app'), 'app').repo;
    writeHubConfig(hub, { repos: [app], roots: [root], hosts: [{ name: 'box', ssh: 'box', repos: [srvApp] }] });
    await openUi(hub, page);
    await expect
      .poll(() => listedRows(page), REMOTE_TIMEOUT)
      .toEqual([row(LOCAL, app), row(LOCAL, app2), row(BOX, srvApp), row(BOX, xApp)]);
    await expect(pillOf(page, BOX, srvApp)).toHaveText('box · srv/app');
    await expect(pillOf(page, BOX, xApp)).toHaveText('box · x/app');
    await expect(pillOf(page, LOCAL, app)).toHaveText('app');
    await expect(pillOf(page, LOCAL, app2)).toHaveText('app-2');
  });

  test('box’s pills have one colour in every tab and every page', async ({ hub, page, ssh, context }) => {
    test.setTimeout(120_000);
    plainPath(hub);
    const remote = await installedRemote(hub, ssh, 'box');
    const app = cloneAt(join(hub.dir, 'r', 'app'), 'app').repo;
    const lib = cloneAt(join(hub.dir, 'r', 'lib'), 'lib').repo;
    const boxApp = cloneAt(join(remote.home, 'srv', 'app'), 'app').repo;
    const boxLib = cloneAt(join(remote.home, 'srv', 'lib'), 'lib').repo;
    writeHubConfig(hub, { repos: [app, lib], hosts: [{ name: 'box', ssh: 'box', repos: [boxApp, boxLib] }] });
    await openUi(hub, page);
    await expect(pillOf(page, BOX, boxApp)).toHaveText('box', REMOTE_TIMEOUT);
    const colours = await coloursOf(pillOf(page, BOX, boxApp));
    await selectGroup(page, lib);
    await expect(pillOf(page, BOX, boxLib)).toHaveText('box');
    expect(await coloursOf(pillOf(page, BOX, boxLib))).toEqual(colours);

    const other = await openPage(hub, context);
    await selectGroup(other.page, app);
    await expect(pillOf(other.page, BOX, boxApp)).toHaveText('box', REMOTE_TIMEOUT);
    expect(await coloursOf(pillOf(other.page, BOX, boxApp))).toEqual(colours);
  });

  test('box’s pills are dimmed while it reconnects and in the error colour once it is down, hovering saying box: down', async ({
    hub,
    page,
    ssh,
  }) => {
    test.setTimeout(120_000);
    const { boxApp } = await sharedApp(hub, ssh, page);
    const pill = pillOf(page, BOX, boxApp);
    await expect(pill).toHaveText('box');
    expect(await opacityOf(pill)).toBe(1);
    expect(await coloursOf(pill)).not.toContain(DANGER);

    ssh.holdHost('box');
    dropLinks(ssh, 'box');
    await expect(pill).toHaveAttribute('title', 'box: reconnecting', REMOTE_TIMEOUT);
    await expect.poll(() => opacityOf(pill)).toBeLessThan(1);

    ssh.failHost('box', 'ssh: Could not resolve hostname box');
    dropLinks(ssh, 'box');
    await expect(pill).toHaveAttribute('title', 'box: down', REMOTE_TIMEOUT);
    await expect.poll(() => coloursOf(pill)).toContain(DANGER);
  });

  test('box’s pills show needs-login in the error colour', async ({ hub, page, ssh }) => {
    test.setTimeout(120_000);
    const { fix } = await sharedApp(hub, ssh, page);
    const pill = pillOf(page, BOX, fix);
    await expect(pill).toHaveText('box');
    ssh.loginHost('box');
    dropLinks(ssh, 'box');
    await expect(pill).toHaveAttribute('title', 'box: needs login', REMOTE_TIMEOUT);
    await expect.poll(() => coloursOf(pill)).toContain(DANGER);
  });

  test('at the minimum sidebar width the pill stays wholly visible while a long label is truncated', async ({ hub, page, ssh }) => {
    test.setTimeout(120_000);
    const { fix } = await sharedApp(hub, ssh, page, 'a-branch-name-far-too-long-for-the-narrowest-sidebar');
    await page.evaluate(() => {
      localStorage.setItem('wtd.sidebarWidth', '160');
    });
    await page.reload();
    await expect(page.locator(byTestId(TID.sidebarResizer))).toHaveAttribute('aria-valuenow', '160');
    const pill = pillOf(page, BOX, fix);
    await expect(pill).toHaveText('box', REMOTE_TIMEOUT);
    const sidebar = await boxOf(page.getByRole('navigation'));
    const shown = await boxOf(pill);
    expect(shown.width).toBeGreaterThan(0);
    expect(shown.x).toBeGreaterThanOrEqual(sidebar.x);
    expect(shown.x + shown.width).toBeLessThanOrEqual(sidebar.x + sidebar.width);
    await expect(pill).toBeInViewport({ ratio: 1 });
    const label = page.locator(worktreeAt(BOX, fix)).locator(byTestId(TID.worktreeLabel));
    expect(await label.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  });

  test('the name search ignores pills', async ({ hub, page, ssh }) => {
    test.setTimeout(120_000);
    const { feat, boxApp } = await sharedApp(hub, ssh, page);
    await expect(pillOf(page, BOX, boxApp)).toHaveText('box');
    await selectRow(page, LOCAL, feat);
    await page.locator(byTestId(TID.worktreeSearch)).fill('box');
    await expect.poll(() => listedRows(page)).toEqual([row(LOCAL, feat)]);
    await expect(page.locator(groupTab(`box:${boxApp}`))).toHaveAttribute('aria-selected', 'true');
  });
});
