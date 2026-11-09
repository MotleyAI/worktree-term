import { byTestId, TID } from './contract.js';
import { expect, makeRepoWith, openUi, test, watcher } from './fixture.js';
import { boxOf, leaf, storeTabs } from './panes.js';

const MAX_TABS = 64;

// Headless Chrome hides scrollbars by default, which would hide the strip's scrollbar from these checks.
test.use({ launchOptions: { args: ['--enable-gpu', '--use-angle=vulkan'], ignoreDefaultArgs: ['--hide-scrollbars'] } });

test('with scrollbars shown, overflowing tabs keep the tab bar height and clip no tab', async ({ hub, page }) => {
  const { repo } = makeRepoWith(hub, 'app', []);
  hub.writeRepos([repo]);
  await openUi(hub, page);
  const client = await watcher(hub, repo);
  const terms: number[] = [];
  const create = async (): Promise<void> => {
    terms.push((await client.create(repo, { command: 'exec sleep 600' })).termId);
  };
  await create();
  await storeTabs(client, repo, terms.map(leaf));
  await expect(page.locator(byTestId(TID.termTab))).toHaveCount(1);
  const height = (await boxOf(page.locator('.term-tabs'))).height;

  for (let i = 1; i < MAX_TABS - 1; i++) await create(); // NOSONAR(S9382) — sequential setup
  await storeTabs(client, repo, terms.map(leaf));
  await expect(page.locator(byTestId(TID.termTab))).toHaveCount(MAX_TABS - 1);
  const strip = await page.locator('.term-tab-strip').evaluate((el: HTMLElement) => ({
    scrollbar: el.offsetHeight - el.clientHeight,
    clipped: el.scrollHeight > el.clientHeight,
    overflows: el.scrollWidth > el.clientWidth,
  }));
  expect(strip).toMatchObject({ clipped: false, overflows: true });
  expect(strip.scrollbar).toBeGreaterThan(0);
  expect((await boxOf(page.locator('.term-tabs'))).height).toBe(height);
});
