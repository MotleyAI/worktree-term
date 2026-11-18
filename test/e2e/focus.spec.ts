import type { Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HubHost } from '../support/hub-host.js';
import { byTestId, repoTab, terminalBox, termTab, TID, worktreeEntry } from './contract.js';
import {
  createShells,
  expect,
  focusBody,
  focusedTerminal,
  LOCAL,
  makeRepoWith,
  newTerminal,
  openUi,
  ready,
  screenOf,
  selectRepo,
  selectWorktree,
  test,
  typeLine,
  waitScreen,
  watcher,
  writeHubConfig,
} from './fixture.js';
import { balanced, createTerms, storeTabs } from './panes.js';

const KEYS_READY = 'KEYS-READY';

/** Puts the terminal in raw mode and prints each input chunk it receives as `[<hex>]`. */
const KEY_ECHO = `process.stdin.setRawMode(true);
process.stdout.write('KEYS' + '-READY\\n');
process.stdin.on('data', (d) => process.stdout.write('[' + d.toString('hex') + ']'));
`;

/** Starts the key echo in the terminal, clicking it first. */
const startKeyEcho = async (hub: HubHost, page: Page, termId: number): Promise<void> => {
  const script = join(hub.dir, 'key-echo.cjs');
  writeFileSync(script, KEY_ECHO);
  await typeLine(page, termId, `'${process.execPath}' '${script}'`);
  await waitScreen(page, termId, KEYS_READY);
};

/** The input the key echo of the terminal received, as `[<hex>]` chunks. */
const received = async (page: Page, termId: number): Promise<string> => {
  const screen = (await screenOf(page, termId)) ?? '';
  return screen.slice(screen.lastIndexOf(KEYS_READY) + KEYS_READY.length).replaceAll(/\s/g, '');
};

/** Checks that the key echo of the terminal received nothing, after a pause for stray input. */
const receivedNothing = async (page: Page, termId: number): Promise<void> => {
  await page.waitForTimeout(300); // NOSONAR(S2925) — absence check: nothing to synchronise on
  expect(await received(page, termId)).toBe('');
};

/** Types `echo <marker>` and Enter where the keyboard focus is, and waits for the terminal to print the marker. */
const echoReaches = async (page: Page, termId: number, marker: string): Promise<void> => {
  const [head = '', tail = ''] = marker.split('-');
  await page.keyboard.type(`echo ${head}''-${tail}`);
  await page.keyboard.press('Enter');
  await waitScreen(page, termId, marker);
  expect(await focusedTerminal(page)).toBe(termId);
};

/** One repo with one shell tab, ready for input. */
const oneShell = async (hub: HubHost, page: Page): Promise<{ repo: string; term: number }> => {
  const { repo } = makeRepoWith(hub, 'app', []);
  hub.writeRepos([repo]);
  await openUi(hub, page);
  const term = await newTerminal(page);
  await ready(page, term);
  return { repo, term };
};

/** Lets the page see the window lose the focus and regain it. */
const switchWindowAway = (page: Page): Promise<void> =>
  page.evaluate(() => {
    window.dispatchEvent(new Event('blur'));
    window.dispatchEvent(new Event('focus'));
  });

test.describe('typing after a click reaches the current terminal', () => {
  test('clicking another worktree’s row focuses its terminal at once', async ({ hub, page }) => {
    const { repo, worktrees } = makeRepoWith(hub, 'app', ['b']);
    const [b = ''] = worktrees;
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const [[mainTerm = 0] = [], [bTerm = 0] = []] = await createShells(await watcher(hub, repo), [repo, b]);
    await selectWorktree(page, repo);
    await page.locator(terminalBox(LOCAL, mainTerm)).click();
    await expect.poll(() => focusedTerminal(page)).toBe(mainTerm);

    await page.locator(worktreeEntry(b)).click();
    await expect(page.locator(worktreeEntry(b))).toHaveAttribute('aria-selected', 'true');
    await expect.poll(() => focusedTerminal(page)).toBe(bTerm);
    await echoReaches(page, bTerm, 'ROW-B');
  });

  test('clicking another repo tab gives its terminal the typed text', async ({ hub, page }) => {
    const { repo: app } = makeRepoWith(hub, 'app', []);
    const { repo: lib } = makeRepoWith(hub, 'lib', []);
    hub.writeRepos([app, lib]);
    await openUi(hub, page);
    const [[appTerm = 0] = []] = await createShells(await watcher(hub, app), [app]);
    const [[libTerm = 0] = []] = await createShells(await watcher(hub, lib), [lib]);
    await selectRepo(page, app);
    await page.locator(terminalBox(LOCAL, appTerm)).click();

    await page.locator(repoTab(lib)).click();
    await expect(page.locator(repoTab(lib))).toHaveAttribute('aria-selected', 'true');
    await expect.poll(() => focusedTerminal(page)).toBe(libTerm);
    await echoReaches(page, libTerm, 'REPO-LIB');
  });

  test('clicking the selected worktree’s row', async ({ hub, page }) => {
    const { repo, term } = await oneShell(hub, page);
    await page.locator(worktreeEntry(repo)).click();
    await expect.poll(() => focusedTerminal(page)).toBe(term);
    await echoReaches(page, term, 'ROW-SAME');
  });

  test('clicking the active terminal tab', async ({ hub, page }) => {
    const { term } = await oneShell(hub, page);
    await page.locator(termTab(term)).click();
    await expect.poll(() => focusedTerminal(page)).toBe(term);
    await echoReaches(page, term, 'TAB-SAME');
  });

  test('clicking an empty part of the tab bar', async ({ hub, page }) => {
    const { term } = await oneShell(hub, page);
    const newTab = await page.locator(byTestId(TID.newTab)).boundingBox();
    const splitRight = await page.locator(byTestId(TID.splitRight)).boundingBox();
    if (newTab === null || splitRight === null) throw new Error('the tab bar controls are not shown');
    expect(splitRight.x - (newTab.x + newTab.width)).toBeGreaterThan(40);
    await page.mouse.click((newTab.x + newTab.width + splitRight.x) / 2, newTab.y + newTab.height / 2);
    await expect.poll(() => focusedTerminal(page)).toBe(term);
    await echoReaches(page, term, 'BAR-EMPTY');
  });

  test('clicking a disabled split control', async ({ hub, page }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const client = await watcher(hub, repo);
    const terms = await createTerms(client, repo, 8);
    await storeTabs(client, repo, [balanced(terms)]);
    const target = terms[3] ?? 0;
    await expect(page.locator(terminalBox(LOCAL, target))).toBeVisible();
    await page.locator(terminalBox(LOCAL, target)).click();
    const control = page.locator(byTestId(TID.splitRight));
    await expect(control).toBeDisabled();
    await focusBody(page);

    const box = await control.boundingBox();
    if (box === null) throw new Error('the split control is not shown');
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await echoReaches(page, target, 'DISABLED-OK');
  });

  test('dragging the sidebar edge', async ({ hub, page }) => {
    const { term } = await oneShell(hub, page);
    const resizer = page.locator(byTestId(TID.sidebarResizer));
    const box = await resizer.boundingBox();
    if (box === null) throw new Error('the sidebar resizer is not shown');
    const before = await resizer.getAttribute('aria-valuenow');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 80, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    await expect(resizer).not.toHaveAttribute('aria-valuenow', before ?? '');
    await echoReaches(page, term, 'DRAG-OK');
  });

  test('closing an exited tab with its close control', async ({ hub, page }) => {
    const { term: first } = await oneShell(hub, page);
    const second = await newTerminal(page);
    await ready(page, second);
    // A failed exit keeps the tab, marked exited; a clean one closes it.
    await typeLine(page, second, 'exit 1');
    await expect(page.locator(termTab(second))).toContainText('exited');

    await page.locator(termTab(second)).locator(byTestId(TID.termTabClose)).click();
    await expect(page.locator(termTab(second))).toHaveCount(0);
    await expect(page.locator(byTestId(TID.closeDialog))).toHaveCount(0);
    await expect.poll(() => focusedTerminal(page)).toBe(first);
    await echoReaches(page, first, 'CLOSED-OK');
  });
});

test.describe('keys pressed while nothing holds the keyboard', () => {
  test('the first key reaches the terminal exactly once, for every kind of key', async ({ hub, page }) => {
    const { term } = await oneShell(hub, page);
    await startKeyEcho(hub, page, term);

    let expected = '';
    for (const [key, hex] of [
      ['KeyA', '61'],
      ['Shift+KeyA', '41'],
      ['ArrowUp', '1b5b41'],
      ['Backspace', '7f'],
      ['Enter', '0d'],
      ['Control+KeyC', '03'],
    ] as const) {
      await focusBody(page);
      await page.keyboard.press(key);
      expected += `[${hex}]`;
      await expect.poll(() => received(page, term), { message: key }).toBe(expected);
      expect(await focusedTerminal(page)).toBe(term);
    }
    await page.waitForTimeout(300); // NOSONAR(S2925) — absence check: a duplicate would arrive late
    expect(await received(page, term)).toBe(expected);
  });

  test('a shortcut acts and reaches no program', async ({ hub, page }) => {
    const { repo, worktrees } = makeRepoWith(hub, 'app', ['b']);
    const [b = ''] = worktrees;
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const [[mainTerm = 0] = [], [bTerm = 0] = []] = await createShells(await watcher(hub, repo), [repo, b]);
    await selectWorktree(page, b);
    await startKeyEcho(hub, page, bTerm);
    await selectWorktree(page, repo);
    await startKeyEcho(hub, page, mainTerm);
    const listed = await page.locator(byTestId(TID.worktree)).evaluateAll((all) => all.map((e) => e.getAttribute('data-path')));
    expect(listed).toEqual([repo, b]);

    await focusBody(page);
    await page.keyboard.press('Alt+ArrowDown');
    await expect(page.locator(worktreeEntry(b))).toHaveAttribute('aria-selected', 'true');
    await expect.poll(() => focusedTerminal(page)).toBe(bTerm);
    await receivedNothing(page, mainTerm);
    expect(await received(page, bTerm)).toBe('');
  });
});

test.describe('the window regaining the focus', () => {
  test('gives the current terminal the focus when nothing held it', async ({ hub, page }) => {
    const { term } = await oneShell(hub, page);
    await focusBody(page);
    await switchWindowAway(page);
    await expect.poll(() => focusedTerminal(page)).toBe(term);
    await echoReaches(page, term, 'WINDOW-OK');
  });

  test('leaves a control focused by the page', async ({ hub, page }) => {
    const { term } = await oneShell(hub, page);
    const tab = page.locator(termTab(term));
    await tab.focus();
    await switchWindowAway(page);
    await page.waitForTimeout(300); // NOSONAR(S2925) — absence check: nothing to synchronise on
    await expect(tab).toBeFocused();
    expect(await focusedTerminal(page)).toBeNull();
  });
});

test.describe('fields, menus and focused controls keep their keys', () => {
  test('the worktree search', async ({ hub, page }) => {
    const { term } = await oneShell(hub, page);
    await startKeyEcho(hub, page, term);
    const search = page.locator(byTestId(TID.worktreeSearch));
    await search.click();
    await page.keyboard.type('zqx');
    await expect(search).toHaveValue('zqx');
    await expect(search).toBeFocused();
    await receivedNothing(page, term);
  });

  test('the add form of the preset picker', async ({ hub, page }) => {
    const { term } = await oneShell(hub, page);
    await startKeyEcho(hub, page, term);
    await page.locator(byTestId(TID.newTab)).click();
    const picker = page.locator(byTestId(TID.presetPicker));
    await picker.locator(byTestId(TID.presetAdd)).click();
    const name = picker.locator(byTestId(TID.presetName));
    await expect(name).toBeFocused();
    await page.keyboard.type('nm');
    await expect(name).toHaveValue('nm');
    await receivedNothing(page, term);
  });

  test('the rename field of a terminal tab', async ({ hub, page }) => {
    const { term } = await oneShell(hub, page);
    await startKeyEcho(hub, page, term);
    const tab = page.locator(termTab(term));
    const box = await tab.boundingBox();
    if (box === null) throw new Error('the tab is not shown');
    await tab.dblclick({ position: { x: 8, y: box.height / 2 } });
    const field = tab.locator(byTestId(TID.termTabName));
    await expect(field).toBeFocused();
    expect(
      await field.evaluate(
        (el) => el instanceof HTMLInputElement && el.value !== '' && el.selectionStart === 0 && el.selectionEnd === el.value.length,
      ),
    ).toBe(true);
    await page.keyboard.type('zz');
    await expect(field).toHaveValue('zz');
    await expect(field).toBeFocused();
    await receivedNothing(page, term);
  });

  test('the open Hubs menu', async ({ hub, page, ssh }) => {
    ssh.failHost('box', 'ssh: Could not resolve hostname box: Name or service not known');
    const { repo } = makeRepoWith(hub, 'app', []);
    writeHubConfig(hub, { repos: [repo], hosts: [{ name: 'box', ssh: 'box' }] });
    await openUi(hub, page);
    const term = await newTerminal(page);
    await ready(page, term);
    await startKeyEcho(hub, page, term);

    await page.locator(byTestId(TID.hubsMenu)).click();
    const list = page.locator(byTestId(TID.hubsList));
    await expect(list).toBeVisible();
    await page.keyboard.press('KeyQ');
    await receivedNothing(page, term);
    await expect(list).toBeVisible();
  });

  test('a terminal tab focused from the keyboard takes Enter', async ({ hub, page }) => {
    const { term: first } = await oneShell(hub, page);
    const second = await newTerminal(page);
    await ready(page, second);
    await startKeyEcho(hub, page, second);

    await page.locator(termTab(first)).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator(termTab(first))).toHaveAttribute('aria-selected', 'true');
    await expect.poll(() => focusedTerminal(page)).toBe(first);
    await receivedNothing(page, second);
  });

  test('selected page text: Ctrl+C copies it, a plain key reaches the terminal', async ({ hub, page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: hub.origin });
    const { repo, term } = await oneShell(hub, page);
    await startKeyEcho(hub, page, term);

    // From just right of the checkbox to the end of the label: a pointer selection of the worktree's name.
    const checkbox = await page.locator(`${worktreeEntry(repo)} input[type="checkbox"]`).boundingBox();
    const label = await page.locator(worktreeEntry(repo)).locator(byTestId(TID.worktreeLabel)).boundingBox();
    if (checkbox === null || label === null) throw new Error('the worktree entry is not shown');
    const y = label.y + label.height / 2;
    await page.mouse.move(checkbox.x + checkbox.width + 3, y);
    await page.mouse.down();
    await page.mouse.move(label.x + label.width - 2, y, { steps: 8 });
    await page.mouse.up();
    const selected = await page.evaluate(() => getSelection()?.toString() ?? '');
    expect(selected).not.toBe('');
    await page.waitForTimeout(300); // NOSONAR(S2925) — absence check: a claim after the click would clear the selection
    expect(await page.evaluate(() => getSelection()?.toString() ?? '')).toBe(selected);

    await page.keyboard.press('Control+KeyC');
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(selected);
    await receivedNothing(page, term);
    await page.keyboard.press('KeyX');
    await expect.poll(() => received(page, term)).toBe('[78]');
  });

  test('without a current terminal, a click in the terminal area focuses no terminal', async ({ hub, page }) => {
    const { repo, worktrees } = makeRepoWith(hub, 'app', ['empty']);
    const [empty = ''] = worktrees;
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const [[term = 0] = []] = await createShells(await watcher(hub, repo), [repo]);
    await selectWorktree(page, repo);
    await page.locator(terminalBox(LOCAL, term)).click();
    await expect.poll(() => focusedTerminal(page)).toBe(term);

    await selectWorktree(page, empty);
    const choices = await page.locator(byTestId(TID.presetChoices)).boundingBox();
    if (choices === null) throw new Error('the preset choices are not shown');
    await page.mouse.click(choices.x + choices.width / 2, choices.y + choices.height + 60);
    await page.waitForTimeout(300); // NOSONAR(S2925) — absence check: nothing to synchronise on
    expect(await focusedTerminal(page)).toBeNull();
  });
});
