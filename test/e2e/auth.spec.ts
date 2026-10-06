import { type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { waitUntil } from '../support/daemon-host.js';
import { REPO_ROOT } from '../support/exec.js';
import { byTestId, repoTab, TID } from './contract.js';
import { expect, makeRepoWith, openUi, runUi, stopHub, test } from './fixture.js';
import { skewedDist } from './skew.js';

const packageVersion = (): string => {
  const pkg: unknown = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  if (typeof pkg !== 'object' || pkg === null || !('version' in pkg) || typeof pkg.version !== 'string') throw new Error('no version');
  return pkg.version;
};

const storedValues = (page: Page): Promise<string> => page.evaluate(() => JSON.stringify(Object.entries(sessionStorage)));

test.describe('authentication', () => {
  test('a one-time code is exchanged for the token, and a reload connects without a code', async ({ hub, page, wire }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    let loads = 0;
    page.on('load', () => loads++);
    await openUi(hub, page);
    await expect(page.locator(repoTab(repo))).toBeVisible();
    expect(await page.evaluate(() => location.hash)).toBe('');
    expect(page.url()).not.toContain('code=');
    expect(page.url()).not.toContain(hub.token());
    expect(loads).toBe(1);
    expect(await storedValues(page)).toContain(hub.token());

    await page.reload();
    await expect(page.locator(repoTab(repo))).toBeVisible();
    await expect(page.locator(byTestId(TID.authMessage))).toHaveCount(0);
    expect(wire.sockets).toBe(2);
  });

  test('without a credential the page shows only the wtd ui message and opens no session', async ({ hub, page, wire }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await runUi(hub);
    await page.goto(`${hub.origin}/`);
    await expect(page.locator(byTestId(TID.authMessage))).toContainText('wtd ui');
    await page.waitForTimeout(1000);
    expect(wire.sockets).toBe(0);
    await expect(page.locator(byTestId(TID.repoTab))).toHaveCount(0);
  });

  test('a refused stored token is forgotten', async ({ hub, page }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    await expect(page.locator(repoTab(repo))).toBeVisible();
    const old = hub.token();
    expect(await storedValues(page)).toContain(old);

    await stopHub(hub);
    rmSync(hub.tokenPath);
    await hub.startHub();
    expect(hub.token()).not.toBe(old);
    await expect(page.locator(byTestId(TID.authMessage))).toContainText('wtd ui', { timeout: 15_000 });
    expect(await storedValues(page)).not.toContain(old);
    await page.reload();
    await expect(page.locator(byTestId(TID.authMessage))).toContainText('wtd ui');
  });
});

test.describe('stale bundle', () => {
  test('a hub of another version makes the page reload once and run the new bundle', async ({ hub, page }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    const version = packageVersion();
    const skew = skewedDist(version, `${version}-skew`);
    try {
      let loads = 0;
      page.on('load', () => loads++);
      await openUi(hub, page);
      await expect(page.locator(repoTab(repo))).toBeVisible();
      expect(loads).toBe(1);

      await stopHub(hub);
      const replacement = spawn(process.execPath, [join(skew, 'wtd.mjs'), 'hub'], { env: hub.env(), stdio: 'ignore' });
      try {
        await waitUntil(
          async () => (await hub.serving()) && (await hub.identity()).version === `${version}-skew`,
          'the skewed hub',
          15_000,
        );
        await expect.poll(() => loads, { timeout: 20_000 }).toBe(2);
        await expect(page.locator(repoTab(repo))).toBeVisible();
        const scripts = await page.evaluate(() => Array.from(document.scripts, (s) => s.src));
        expect(scripts.some((src) => src.includes('/assets/skew-'))).toBe(true);
        await page.waitForTimeout(2000);
        expect(loads).toBe(2);
        await expect(page.locator(byTestId(TID.outdatedUi))).toHaveCount(0);
      } finally {
        replacement.kill('SIGKILL');
      }
    } finally {
      rmSync(skew, { recursive: true, force: true });
    }
  });
});
