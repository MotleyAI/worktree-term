import { expect, test } from '@playwright/test';
import { groupTab, TID } from './contract.js';

const TABS = [
  ['plain', '/r/app'],
  ['spaced', '/tmp/my repos/app\nbox:/srv/app'],
  ['longer', '/r/app copy'],
  ['quoted', `/r/it's "q"`],
] as const;

test.beforeEach(async ({ page }) => {
  await page.setContent('<div id="tabs"></div>');
  await page.evaluate(
    ({ tabs, id }) => {
      const root = document.getElementById('tabs');
      for (const [name, title] of tabs) {
        const tab = document.createElement('div');
        tab.dataset['testid'] = id;
        tab.dataset['name'] = name;
        tab.title = title;
        root?.append(tab);
      }
    },
    { tabs: TABS, id: TID.repoTab },
  );
});

test.describe('groupTab', () => {
  for (const [entry, name] of [
    ['/r/app', 'plain'],
    ['/tmp/my repos/app', 'spaced'],
    ['box:/srv/app', 'spaced'],
    ['/r/app copy', 'longer'],
    [`/r/it's "q"`, 'quoted'],
  ] as const) {
    test(`matches the tab holding ${entry} as a whole title line`, async ({ page }) => {
      await expect(page.locator(groupTab(entry))).toHaveAttribute('data-name', name);
    });
  }

  test('matches no tab for part of a title line', async ({ page }) => {
    await expect(page.locator(groupTab('/r'))).toHaveCount(0);
  });
});
