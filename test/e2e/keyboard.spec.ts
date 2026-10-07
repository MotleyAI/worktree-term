import type { Page } from '@playwright/test';
import { byTestId, terminalBox, termTab, TID, worktreeEntry } from './contract.js';
import {
  activeTerm,
  expect,
  focusedPane,
  listedWorktrees,
  LOCAL,
  makeRepoWith,
  newTerminal,
  openUi,
  PRESETS,
  ready,
  screenOf,
  selectWorktree,
  splitPane,
  test,
  typeLine,
  waitScreen,
  watcher,
} from './fixture.js';
import { createsSent, createTerms, leaf, paneBox, split, storeTabs } from './panes.js';

const checkbox = (path: string): string => `${worktreeEntry(path)} input[type="checkbox"]`;

const selected = (page: Page, path: string): Promise<void> =>
  expect(page.locator(worktreeEntry(path))).toHaveAttribute('aria-selected', 'true');

/** Presses `key` and checks that the selected worktree stays `path`. */
const pressStays = async (page: Page, key: string, path: string): Promise<void> => {
  await page.keyboard.press(key);
  await page.waitForTimeout(300); // NOSONAR(S2925) — absence check: nothing to synchronise on
  await selected(page, path);
};

/** Three tabs in the repo's main worktree, the first one active. */
const threeTabs = async (page: Page): Promise<number[]> => {
  const tabs = [await newTerminal(page), await newTerminal(page), await newTerminal(page)];
  const [first = 0] = tabs;
  await page.locator(termTab(first)).click();
  await expect(page.locator(termTab(first))).toHaveAttribute('aria-selected', 'true');
  return tabs;
};

test.describe('worktree navigation', () => {
  test('Alt+Down and Alt+Up move through the worktrees listed under "checked only", stopping at either end', async ({ hub, page }) => {
    const { repo, worktrees } = makeRepoWith(hub, 'app', ['a', 'b', 'c']);
    const [a = '', b = '', c = ''] = worktrees;
    hub.writeRepos([repo]);
    await openUi(hub, page);
    await page.locator(checkbox(a)).check();
    await page.locator(checkbox(c)).check();
    await selectWorktree(page, a);
    await page.locator(byTestId(TID.filterChecked)).check();
    await expect.poll(() => listedWorktrees(page)).toEqual([a, c]);
    await expect(page.locator(worktreeEntry(b))).toHaveCount(0);

    await page.keyboard.press('Alt+ArrowDown');
    await selected(page, c);
    await pressStays(page, 'Alt+ArrowDown', c);
    await page.keyboard.press('Alt+ArrowUp');
    await selected(page, a);
    await pressStays(page, 'Alt+ArrowUp', a);
  });

  test('Alt+Down at the last listed worktree and Alt+Up at the first change nothing', async ({ hub, page }) => {
    const { repo } = makeRepoWith(hub, 'app', ['a', 'b']);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    await expect.poll(async () => (await listedWorktrees(page)).length).toBe(3);
    const listed = await listedWorktrees(page);
    const first = listed[0] ?? '';
    const last = listed.at(-1) ?? '';
    expect(listed).toHaveLength(3);

    await selectWorktree(page, last);
    await pressStays(page, 'Alt+ArrowDown', last);
    await selectWorktree(page, first);
    await pressStays(page, 'Alt+ArrowUp', first);
    await page.keyboard.press('Alt+ArrowDown');
    await selected(page, listed[1] ?? '');
  });
});

test.describe('tab and pane navigation', () => {
  test('Alt+Right twice from the first of three tabs shows the third, and stops there', async ({ hub, page }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const [, second = 0, third = 0] = await threeTabs(page);

    await page.keyboard.press('Alt+ArrowRight');
    await page.keyboard.press('Alt+ArrowRight');
    await expect(page.locator(termTab(third))).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator(terminalBox(LOCAL, third))).toBeVisible();
    await page.keyboard.press('Alt+ArrowRight');
    await page.waitForTimeout(300); // NOSONAR(S2925) — absence check: nothing to synchronise on
    expect(await activeTerm(page)).toBe(third);
    await page.keyboard.press('Alt+ArrowLeft');
    await expect(page.locator(termTab(second))).toHaveAttribute('aria-selected', 'true');
  });

  test('Alt+Shift+arrows focus the pane in that direction, preferring the most overlapping one', async ({ hub, page }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const client = await watcher(hub, repo);
    const [left = 0, topRight = 0, bottomRight = 0] = await createTerms(client, repo, 3);
    await storeTabs(client, repo, [split('right', leaf(left), split('down', leaf(topRight), leaf(bottomRight), 0.3))]);
    await expect(page.locator(terminalBox(LOCAL, bottomRight))).toBeVisible();
    // The right side is split at 30%: the bottom-right pane overlaps the left one most.
    expect((await paneBox(page, topRight)).height).toBeLessThan((await paneBox(page, bottomRight)).height);
    await page.locator(terminalBox(LOCAL, topRight)).click();
    await expect.poll(() => focusedPane(page)).toBe(topRight);

    await page.keyboard.press('Alt+Shift+ArrowLeft');
    await expect.poll(() => focusedPane(page)).toBe(left);
    await page.keyboard.press('Alt+Shift+ArrowRight');
    await expect.poll(() => focusedPane(page)).toBe(bottomRight);
    await page.keyboard.press('Alt+Shift+ArrowRight');
    await page.waitForTimeout(300); // NOSONAR(S2925) — absence check: nothing to synchronise on
    expect(await focusedPane(page)).toBe(bottomRight);

    // The focused pane holds the keyboard focus.
    await page.keyboard.type("echo NAV''-OK");
    await page.keyboard.press('Enter');
    await waitScreen(page, bottomRight, 'NAV-OK');
    await page.keyboard.press('Alt+Shift+ArrowUp');
    await expect.poll(() => focusedPane(page)).toBe(topRight);
  });

  test('shortcuts act with the keyboard focus outside the terminals', async ({ hub, page }) => {
    const { repo, worktrees } = makeRepoWith(hub, 'app', ['empty']);
    const [empty = ''] = worktrees;
    hub.writeRepos([repo]);
    await openUi(hub, page);
    await selectWorktree(page, repo);
    const first = await newTerminal(page);
    const second = await newTerminal(page);
    await page.locator(byTestId(TID.filterChecked)).focus();
    await page.keyboard.press('Alt+ArrowLeft');
    await expect(page.locator(termTab(first))).toHaveAttribute('aria-selected', 'true');
    await page.locator(byTestId(TID.filterChecked)).focus();
    await page.keyboard.press('Control+Shift+KeyT');
    await expect(page.locator(byTestId(TID.presetPicker))).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator(byTestId(TID.presetPicker))).toHaveCount(0);

    // A worktree without terminals has no terminal to hold the focus.
    expect((await listedWorktrees(page)).indexOf(empty)).toBe((await listedWorktrees(page)).indexOf(repo) + 1);
    await selectWorktree(page, empty);
    await page.keyboard.press('Alt+ArrowUp');
    await selected(page, repo);
    await expect(page.locator(terminalBox(LOCAL, first))).toBeVisible();
    await expect(page.locator(terminalBox(LOCAL, second))).toBeHidden();
  });
});

test.describe('shortcuts and the terminal program', () => {
  test('no shortcut reaches a focused cat -v', async ({ hub, page }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const term = await newTerminal(page, 'cat');
    await waitScreen(page, term, 'PRESET-CAT');
    await page.locator(terminalBox(LOCAL, term)).click();

    // Each does nothing here: one worktree, one tab, one pane, no selection.
    for (const key of [
      'Alt+ArrowUp',
      'Alt+ArrowDown',
      'Alt+ArrowLeft',
      'Alt+ArrowRight',
      'Alt+Shift+ArrowLeft',
      'Alt+Shift+ArrowRight',
      'Alt+Shift+ArrowUp',
      'Alt+Shift+ArrowDown',
      'Control+Shift+KeyC',
    ]) {
      await page.keyboard.press(key);
    }
    for (const key of ['Control+Shift+KeyT', 'Control+Shift+KeyD', 'Control+Shift+KeyE']) {
      await page.keyboard.press(key);
      await expect(page.locator(byTestId(TID.presetPicker))).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.locator(byTestId(TID.presetPicker))).toHaveCount(0);
    }
    await page.keyboard.press('Control+Shift+KeyW');
    await expect(page.locator(byTestId(TID.closeDialog))).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator(byTestId(TID.closeDialog))).toHaveCount(0);

    // The tty echoes typed text and cat repeats it; a leaked key would show as ^[ or have stopped cat.
    await typeLine(page, term, 'END');
    const screen = await waitScreen(page, term, 'END\nEND');
    expect(screen.slice(screen.indexOf('PRESET-CAT'))).toBe('PRESET-CAT\nEND\nEND');
  });

  test('Ctrl+Shift+C copies the selection and Ctrl+Shift+V types it into another terminal', async ({ hub, page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: hub.origin });
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const left = await newTerminal(page);
    await ready(page, left);
    const right = await splitPane(page, 'right');
    await ready(page, right);

    await typeLine(page, left, "clear; echo COPY''-ME-42");
    await expect.poll(async () => ((await screenOf(page, left)) ?? '').split('\n')[0]).toBe('COPY-ME-42');
    // The word starts the first row; a point a few pixels in is on it.
    await page
      .locator(terminalBox(LOCAL, left))
      .locator('.xterm-screen')
      .dblclick({ position: { x: 12, y: 6 } });
    await page.keyboard.press('Control+Shift+KeyC');
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('COPY-ME-42');

    await page.locator(terminalBox(LOCAL, right)).click();
    await page.keyboard.press('Control+Shift+KeyV');
    await page.keyboard.press('Enter');
    const screen = await waitScreen(page, right, 'COPY-ME-42: command not found');
    expect(screen).toMatch(/(^|\s)COPY-ME-42: command not found/);
    expect(screen).not.toContain('COPY-ME-42COPY-ME-42');
  });

  test('a failed copy is reported on the page', async ({ hub, page }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const term = await newTerminal(page);
    await ready(page, term);
    await typeLine(page, term, "clear; echo COPY''-ME-42");
    await expect.poll(async () => ((await screenOf(page, term)) ?? '').split('\n')[0]).toBe('COPY-ME-42');
    await page.evaluate(() => {
      Object.defineProperty(navigator.clipboard, 'writeText', {
        configurable: true,
        value: () => Promise.reject(new DOMException('denied', 'NotAllowedError')),
      });
    });
    await expect(page.locator(byTestId(TID.notice))).toBeHidden();

    await page
      .locator(terminalBox(LOCAL, term))
      .locator('.xterm-screen')
      .dblclick({ position: { x: 12, y: 6 } });
    await page.keyboard.press('Control+Shift+KeyC');
    await expect(page.locator(byTestId(TID.notice))).toBeVisible();
  });
});

test.describe('shortcuts while a picker or dialog is open', () => {
  /** Two tabs in the first listed worktree, the first one active; returns that worktree and the tabs. */
  const twoTabsInFirst = async (page: Page): Promise<{ worktree: string; first: number }> => {
    await expect.poll(async () => (await listedWorktrees(page)).length).toBe(2);
    const [worktree = ''] = await listedWorktrees(page);
    await selectWorktree(page, worktree);
    const first = await newTerminal(page);
    await newTerminal(page);
    await page.locator(termTab(first)).click();
    await expect(page.locator(termTab(first))).toHaveAttribute('aria-selected', 'true');
    return { worktree, first };
  };

  test('navigation shortcuts do nothing while the picker is open', async ({ hub, page }) => {
    const { repo } = makeRepoWith(hub, 'app', ['b']);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const { worktree, first } = await twoTabsInFirst(page);

    await page.keyboard.press('Control+Shift+KeyT');
    const picker = page.locator(byTestId(TID.presetPicker));
    await expect(picker).toBeVisible();
    await page.keyboard.press('Alt+ArrowDown');
    await page.keyboard.press('Alt+ArrowRight');
    await page.waitForTimeout(300); // NOSONAR(S2925) — absence check: nothing to synchronise on
    await selected(page, worktree);
    expect(await activeTerm(page)).toBe(first);
    await expect(picker).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(picker).toHaveCount(0);
  });

  test('shortcuts do nothing while the close dialog is open', async ({ hub, page, wire }) => {
    const { repo } = makeRepoWith(hub, 'app', ['b']);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const { worktree, first } = await twoTabsInFirst(page);
    await ready(page, first);

    await page.keyboard.press('Control+Shift+KeyW');
    const dialog = page.locator(byTestId(TID.closeDialog));
    await expect(dialog).toBeVisible();
    const mark = wire.markSent();
    await page.keyboard.press('Alt+ArrowDown');
    await page.keyboard.press('Alt+ArrowRight');
    await page.keyboard.press('Control+Shift+KeyT');
    await page.waitForTimeout(500); // NOSONAR(S2925) — absence check: nothing to synchronise on
    await selected(page, worktree);
    expect(await activeTerm(page)).toBe(first);
    await expect(page.locator(byTestId(TID.presetPicker))).toHaveCount(0);
    expect(createsSent(wire, mark)).toEqual([]);
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });
});

test.describe('held shortcuts', () => {
  test('a held navigation shortcut repeats', async ({ hub, page }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const [, , third = 0] = await threeTabs(page);

    await page.keyboard.down('Alt');
    await page.keyboard.down('ArrowRight');
    // A second keydown of a held key is an auto-repeat.
    await page.keyboard.down('ArrowRight');
    await page.keyboard.up('ArrowRight');
    await page.keyboard.up('Alt');
    await expect(page.locator(termTab(third))).toHaveAttribute('aria-selected', 'true');
  });

  test('a held Ctrl+Shift+T opens one picker', async ({ hub, page, wire }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    await newTerminal(page);
    const mark = wire.markSent();

    await page.keyboard.down('Control');
    await page.keyboard.down('Shift');
    for (let i = 0; i < 3; i++) await page.keyboard.down('KeyT');
    await page.keyboard.up('KeyT');
    await page.keyboard.up('Shift');
    await page.keyboard.up('Control');
    await expect(page.locator(byTestId(TID.presetPicker))).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(page.locator(byTestId(TID.presetPicker))).toHaveCount(0);
    await page.waitForTimeout(500); // NOSONAR(S2925) — absence check: nothing to synchronise on
    await expect(page.locator(byTestId(TID.presetPicker))).toHaveCount(0);
    expect(createsSent(wire, mark)).toEqual([]);
  });

  test('with a single preset, held Ctrl+Shift+T and Ctrl+Shift+D each create one terminal', async ({ hub, page, wire }) => {
    hub.presets = PRESETS.slice(0, 1);
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    await expect(page.locator(byTestId(TID.newTab))).toBeEnabled();

    for (const [key, total] of [
      ['KeyT', 1],
      ['KeyD', 2],
    ] as const) {
      const mark = wire.markSent();
      await page.keyboard.down('Control');
      await page.keyboard.down('Shift');
      for (let i = 0; i < 3; i++) await page.keyboard.down(key);
      await page.keyboard.up(key);
      await page.keyboard.up('Shift');
      await page.keyboard.up('Control');
      await expect.poll(() => createsSent(wire, mark).length).toBe(1);
      await expect.poll(async () => await page.locator(byTestId(TID.pane)).count()).toBe(total);
      await page.waitForTimeout(500); // NOSONAR(S2925) — absence check: nothing to synchronise on
      expect(createsSent(wire, mark)).toHaveLength(1);
    }
  });
});
