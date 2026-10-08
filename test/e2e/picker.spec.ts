import { readFileSync } from 'node:fs';
import type { Locator, Page } from '@playwright/test';
import { decodeMessage } from '../../src/protocol/index.js';
import { byTestId, terminalBox, termTab, TID, worktreeEntry } from './contract.js';
import {
  activeTerm,
  expect,
  LOCAL,
  makeRepoWith,
  newTerminal,
  openPage,
  openUi,
  presetRequests,
  PRESETS,
  ready,
  selectWorktree,
  test,
  waitScreen,
  watcher,
} from './fixture.js';
import { boxOf, createsSent, pickerSeen, watchPicker } from './panes.js';

const [SHELL, CAT] = PRESETS;

interface Session {
  /** Closes both sides of the session. */
  cut: () => void;
  /** Whether the session holds back the hub's messages. */
  holding: () => boolean;
  /** Delivers the held messages in order and passes later ones through. */
  release: () => void;
}

interface HeldPresets {
  /** WebSocket sessions the page opened. */
  sessions: () => number;
  /** The latest session. */
  current: () => Session;
  /** `createTerm` requests the page sent over every session. */
  creates: () => number;
}

/** Routes the page's WebSockets through the test; every session after the first holds back `presets` and every later hub message. */
const holdPresets = async (page: Page): Promise<HeldPresets> => {
  let sessions = 0;
  let creates = 0;
  let current: Session | null = null;
  await page.routeWebSocket(
    (url) => url.pathname === '/ws',
    (ws) => {
      sessions++;
      const later = sessions > 1;
      const server = ws.connectToServer();
      let held: (string | Buffer)[] | null = null;
      let released = false;
      current = {
        cut: () => {
          void ws.close();
          void server.close();
        },
        holding: () => held !== null,
        release: () => {
          released = true;
          for (const message of held ?? []) ws.send(message);
          held = null;
        },
      };
      ws.onMessage((message) => {
        if (typeof message === 'string') {
          const m = decodeMessage('browserToHub', message);
          if (m.t === 'host' && m.m.t === 'createTerm') creates++;
        }
        server.send(message);
      });
      server.onMessage((message) => {
        // `presets` precedes `hosts`: holding it and everything after keeps the hub's order.
        if (later && !released && held === null && typeof message === 'string' && decodeMessage('hubToBrowser', message).t === 'presets') {
          held = [];
        }
        if (held === null) ws.send(message);
        else held.push(message);
      });
    },
  );
  return {
    sessions: () => sessions,
    current: () => {
      if (current === null) throw new Error('no WebSocket session');
      return current;
    },
    creates: () => creates,
  };
};

test.describe('preset picker', () => {
  test('the tab-bar controls name their shortcuts', async ({ hub, page }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    await newTerminal(page);
    await expect(page.locator(byTestId(TID.newTab))).toHaveAttribute('title', /Ctrl\+Shift\+T/);
    await expect(page.locator(byTestId(TID.splitRight))).toHaveAttribute('title', /Ctrl\+Shift\+D/);
    await expect(page.locator(byTestId(TID.splitDown))).toHaveAttribute('title', /Ctrl\+Shift\+E/);
  });

  test('Ctrl+Shift+T and then 2 opens the second preset as the new active tab', async ({ hub, page, wire }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const first = await newTerminal(page);
    await ready(page, first);
    const mark = wire.markSent();

    await page.keyboard.press('Control+Shift+KeyT');
    const picker = page.locator(byTestId(TID.presetPicker));
    await expect(picker).toBeVisible();
    await expect(picker.locator(byTestId(TID.presetOption))).toHaveText(PRESETS.map((p) => p.name));
    await page.keyboard.press('2');
    await expect(picker).toHaveCount(0);

    await expect.poll(() => activeTerm(page)).not.toBe(first);
    const term = await activeTerm(page);
    await expect(page.locator(terminalBox(LOCAL, term))).toBeVisible();
    await waitScreen(page, term, 'PRESET-CAT');
    expect(createsSent(wire, mark)).toEqual([expect.objectContaining({ worktree: repo, preset: CAT.name, command: CAT.command })]);
  });

  test('arrow keys and Enter choose a preset', async ({ hub, page, wire }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const first = await newTerminal(page);
    await ready(page, first);
    const mark = wire.markSent();

    await page.keyboard.press('Control+Shift+KeyT');
    const options = page.locator(byTestId(TID.presetPicker)).locator(byTestId(TID.presetOption));
    await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowDown');
    await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowDown');
    await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Enter');
    await expect(page.locator(byTestId(TID.presetPicker))).toHaveCount(0);
    await expect.poll(() => createsSent(wire, mark).map((m) => m.preset)).toEqual([CAT.name]);
  });

  test('with a single preset Ctrl+Shift+T opens a terminal without a picker', async ({ hub, page, wire }) => {
    const only = { name: 'only', command: 'echo ONLY-PRESET; exec cat -v' };
    hub.presets = [only];
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    await expect(page.locator(byTestId(TID.newTab))).toBeEnabled();
    await watchPicker(page);
    const mark = wire.markSent();

    await page.keyboard.press('Control+Shift+KeyT');
    const term = await activeTerm(page);
    await expect(page.locator(terminalBox(LOCAL, term))).toBeVisible();
    await waitScreen(page, term, 'ONLY-PRESET');
    expect(createsSent(wire, mark)).toEqual([expect.objectContaining({ preset: only.name, command: only.command })]);
    expect(await pickerSeen(page)).toBe(false);
  });

  test('Escape closes the picker without creating a terminal', async ({ hub, page, wire }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const first = await newTerminal(page);
    await ready(page, first);
    const mark = wire.markSent();

    await page.keyboard.press('Control+Shift+KeyT');
    await expect(page.locator(byTestId(TID.presetPicker))).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator(byTestId(TID.presetPicker))).toHaveCount(0);
    await page.waitForTimeout(500); // NOSONAR(S2925) — absence check: nothing to synchronise on
    expect(createsSent(wire, mark)).toEqual([]);
    await expect(page.locator(byTestId(TID.termTab))).toHaveCount(1);
  });

  test('a click outside closes the picker without creating a terminal', async ({ hub, page, wire }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const first = await newTerminal(page);
    const mark = wire.markSent();

    await page.locator(byTestId(TID.newTab)).click();
    const picker = page.locator(byTestId(TID.presetPicker));
    const box = await boxOf(picker);
    const area = await boxOf(page.locator(terminalBox(LOCAL, first)));
    const point = { x: area.x + 5, y: area.y + area.height - 5 };
    const inside = point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height;
    expect(inside).toBe(false);
    await page.mouse.click(point.x, point.y);
    await expect(picker).toHaveCount(0);
    await page.waitForTimeout(500); // NOSONAR(S2925) — absence check: nothing to synchronise on
    expect(createsSent(wire, mark)).toEqual([]);
  });

  test('selecting another worktree closes the picker without creating a terminal', async ({ hub, page, wire }) => {
    const { repo, worktrees } = makeRepoWith(hub, 'app', ['a', 'b']);
    const [a = '', b = ''] = worktrees;
    hub.writeRepos([repo]);
    await openUi(hub, page);
    await selectWorktree(page, a);
    const mark = wire.markSent();

    await page.locator(byTestId(TID.newTab)).click();
    await expect(page.locator(byTestId(TID.presetPicker))).toBeVisible();
    await selectWorktree(page, b);
    await expect(page.locator(byTestId(TID.presetPicker))).toHaveCount(0);
    await page.waitForTimeout(500); // NOSONAR(S2925) — absence check: nothing to synchronise on
    expect(createsSent(wire, mark)).toEqual([]);
    await expect(page.locator(worktreeEntry(b))).toHaveAttribute('aria-selected', 'true');
  });

  test('closing the pane a split picker targets closes the picker without creating a terminal', async ({ hub, page, wire }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const client = await watcher(hub, repo);
    const first = await newTerminal(page);
    await newTerminal(page);
    await page.locator(termTab(first)).click();
    await expect(page.locator(terminalBox(LOCAL, first))).toBeVisible();
    const mark = wire.markSent();

    await page.locator(byTestId(TID.splitRight)).click();
    await expect(page.locator(byTestId(TID.presetPicker))).toBeVisible();
    await client.ok({ t: 'closeTerm', termId: first });
    await expect(page.locator(byTestId(TID.presetPicker))).toHaveCount(0);
    await page.waitForTimeout(500); // NOSONAR(S2925) — absence check: nothing to synchronise on
    expect(createsSent(wire, mark)).toEqual([]);
  });
});

test.describe('presets of the session', () => {
  test('the creation controls stay disabled until the session has received its presets', async ({ hub, page }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    const route = await holdPresets(page);
    await openUi(hub, page);
    const first = await newTerminal(page);
    await ready(page, first);
    const controls = [TID.newTab, TID.splitRight, TID.splitDown].map((id) => page.locator(byTestId(id)));
    for (const control of controls) await expect(control).toBeEnabled();

    // The next session forgets the presets and holds the hub's back.
    route.current().cut();
    await expect.poll(() => route.sessions(), { timeout: 15_000 }).toBe(2);
    await expect.poll(() => route.current().holding(), { timeout: 15_000 }).toBe(true);
    await expect(page.locator(byTestId(TID.reconnecting))).toBeHidden();
    for (const control of controls) await expect(control).toBeDisabled();
    await watchPicker(page);
    const creates = route.creates();
    await page.keyboard.press('Control+Shift+KeyT');
    await page.waitForTimeout(500); // NOSONAR(S2925) — absence check: nothing to synchronise on
    expect(await pickerSeen(page)).toBe(false);
    expect(route.creates()).toBe(creates);

    route.current().release();
    await expect(page.locator(byTestId(TID.newTab))).toBeEnabled();
  });
});

test.describe('preset choices of a worktree without terminals', () => {
  test('a click on a choice runs that preset as the active tab', async ({ hub, page, wire }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const choices = page.locator(byTestId(TID.presetChoices));
    await expect(choices.locator(byTestId(TID.presetOption))).toHaveText(PRESETS.map((p) => p.name));
    const mark = wire.markSent();

    await choices.locator(byTestId(TID.presetOption), { hasText: 'cat' }).click();
    const term = await activeTerm(page);
    await waitScreen(page, term, 'PRESET-CAT');
    expect(createsSent(wire, mark)).toEqual([expect.objectContaining({ preset: CAT.name, command: CAT.command })]);
    await expect(choices).toHaveCount(0);
  });

  test('a digit chooses the preset at that position', async ({ hub, page, wire }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const options = page.locator(byTestId(TID.presetChoices)).locator(byTestId(TID.presetOption));
    await options.first().focus();
    const mark = wire.markSent();

    await page.keyboard.press('2');
    await expect.poll(() => createsSent(wire, mark).map((m) => [m.preset, m.command])).toEqual([[CAT.name, CAT.command]]);
    await waitScreen(page, await activeTerm(page), 'PRESET-CAT');
  });

  test('arrow keys and Enter choose a preset', async ({ hub, page, wire }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const options = page.locator(byTestId(TID.presetChoices)).locator(byTestId(TID.presetOption));
    await options.first().focus();
    const mark = wire.markSent();

    await page.keyboard.press('ArrowDown');
    await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowUp');
    await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Enter');
    await expect.poll(() => createsSent(wire, mark).map((m) => [m.preset, m.command])).toEqual([[SHELL.name, SHELL.command]]);
  });
});

test.describe('editing presets', () => {
  const NEW = { name: 'echo', command: 'echo PRESET-NEW; exec cat -v' };

  /** The configured presets in `config.json`. */
  const configured = (path: string): unknown => {
    const config: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return typeof config === 'object' && config !== null && 'presets' in config ? config.presets : undefined;
  };

  /** Opens the add form in `list` and submits `name` and `command`. */
  const addPreset = async (list: Locator, name: string, command: string): Promise<void> => {
    await list.locator(byTestId(TID.presetAdd)).click();
    const form = list.locator(byTestId(TID.presetForm));
    await expect(form.locator(byTestId(TID.presetName))).toBeFocused();
    await form.locator(byTestId(TID.presetName)).fill(name);
    await form.locator(byTestId(TID.presetCommand)).fill(command);
    await form.locator(byTestId(TID.presetSubmit)).click();
  };

  test('a preset added from the choices is saved, shown in every page, and runs its command', async ({ hub, page, wire, context }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const other = await openPage(hub, context);
    const choices = page.locator(byTestId(TID.presetChoices));
    const mark = wire.markSent();

    await addPreset(choices, `  ${NEW.name} `, NEW.command);
    expect(presetRequests(wire, mark)).toEqual([{ t: 'addPreset', preset: NEW }]);
    await expect(choices.locator(byTestId(TID.presetForm))).toHaveCount(0);
    const names = [...PRESETS.map((p) => p.name), NEW.name];
    await expect(choices.locator(byTestId(TID.presetOption))).toHaveText(names);
    await expect(other.page.locator(byTestId(TID.presetChoices)).locator(byTestId(TID.presetOption))).toHaveText(names);
    expect(configured(hub.configPath)).toEqual([...PRESETS, NEW]);

    await choices.locator(byTestId(TID.presetOption), { hasText: NEW.name }).click();
    await waitScreen(page, await activeTerm(page), 'PRESET-NEW');
  });

  test('× removes a preset from every page and config.json, and the last preset offers none', async ({ hub, page, wire, context }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const other = await openPage(hub, context);
    const choices = page.locator(byTestId(TID.presetChoices));
    const mark = wire.markSent();

    await choices.locator(byTestId(TID.presetOption), { hasText: CAT.name }).locator('..').locator(byTestId(TID.presetRemove)).click();
    expect(presetRequests(wire, mark)).toEqual([{ t: 'removePreset', name: CAT.name }]);
    await expect(choices.locator(byTestId(TID.presetOption))).toHaveText([SHELL.name]);
    await expect(other.page.locator(byTestId(TID.presetChoices)).locator(byTestId(TID.presetOption))).toHaveText([SHELL.name]);
    expect(configured(hub.configPath)).toEqual([SHELL]);
    await expect(choices.locator(byTestId(TID.presetRemove))).toHaveCount(0);
  });

  test('the add form refuses a taken name without sending, and Escape closes it', async ({ hub, page, wire }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const choices = page.locator(byTestId(TID.presetChoices));
    const mark = wire.markSent();

    await addPreset(choices, CAT.name, 'anything');
    await expect(choices.locator(byTestId(TID.presetError))).toHaveText(`A preset named ${CAT.name} exists`);
    await choices.locator(byTestId(TID.presetName)).fill('  ');
    await choices.locator(byTestId(TID.presetName)).press('Enter');
    await expect(choices.locator(byTestId(TID.presetError))).toHaveText('Give the preset a name');
    await choices.locator(byTestId(TID.presetName)).press('Escape');
    await expect(choices.locator(byTestId(TID.presetForm))).toHaveCount(0);
    await expect(choices.locator(byTestId(TID.presetAdd))).toBeVisible();
    expect(presetRequests(wire, mark)).toEqual([]);
    expect(configured(hub.configPath)).toEqual(PRESETS);
  });

  test('a preset added in the new-tab picker keeps the picker open and can be chosen there', async ({ hub, page, wire }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    await newTerminal(page);
    await page.locator(byTestId(TID.newTab)).click();
    const picker = page.locator(byTestId(TID.presetPicker));
    await expect(picker).toBeVisible();

    await addPreset(picker, NEW.name, NEW.command);
    await expect(picker.locator(byTestId(TID.presetOption))).toHaveText([...PRESETS.map((p) => p.name), NEW.name]);
    await expect(picker).toBeVisible();
    const before = await activeTerm(page);
    const mark = wire.markSent();
    await picker.locator(byTestId(TID.presetOption), { hasText: NEW.name }).click();
    await expect.poll(() => createsSent(wire, mark).map((m) => [m.preset, m.command])).toEqual([[NEW.name, NEW.command]]);
    await expect.poll(() => activeTerm(page)).not.toBe(before);
    await waitScreen(page, await activeTerm(page), 'PRESET-NEW');
  });

  test('dragging a preset reorders the presets in every page and in config.json', async ({ hub, page, wire, context }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    const other = await openPage(hub, context);
    const choices = page.locator(byTestId(TID.presetChoices));
    const row = (name: string): Locator => choices.locator(byTestId(TID.presetRow), { hasText: name });
    const mark = wire.markSent();

    await row(CAT.name).dragTo(row(SHELL.name), { targetPosition: { x: 20, y: 2 } });
    await expect.poll(() => presetRequests(wire, mark)).toEqual([{ t: 'movePreset', name: CAT.name, to: 0 }]);
    await expect(choices.locator(byTestId(TID.presetOption))).toHaveText([CAT.name, SHELL.name]);
    await expect(other.page.locator(byTestId(TID.presetChoices)).locator(byTestId(TID.presetOption))).toHaveText([CAT.name, SHELL.name]);
    expect(configured(hub.configPath)).toEqual([CAT, SHELL]);
  });

  test('Alt+Up moves the highlighted preset up in the picker, which keeps it highlighted', async ({ hub, page, wire }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    await newTerminal(page);
    await page.locator(byTestId(TID.newTab)).click();
    const picker = page.locator(byTestId(TID.presetPicker));
    const options = picker.locator(byTestId(TID.presetOption));
    await page.keyboard.press('ArrowDown');
    await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');

    await page.keyboard.press('Alt+ArrowUp');
    await expect(options).toHaveText([CAT.name, SHELL.name]);
    await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
    await expect(options.nth(0)).toBeFocused();
    expect(configured(hub.configPath)).toEqual([CAT, SHELL]);

    const mark = wire.markSent();
    await page.keyboard.press('Enter');
    await expect.poll(() => createsSent(wire, mark).map((m) => m.preset)).toEqual([CAT.name]);
  });

  test('two quick Alt+Down presses only ever move the highlighted preset', async ({ hub, page }) => {
    const third = { name: 'third', command: 'echo THIRD' };
    hub.presets = [...PRESETS, third];
    const { repo } = makeRepoWith(hub, 'app', []);
    hub.writeRepos([repo]);
    await openUi(hub, page);
    await newTerminal(page);
    await page.locator(byTestId(TID.newTab)).click();
    const options = page.locator(byTestId(TID.presetPicker)).locator(byTestId(TID.presetOption));
    await expect(options.nth(0)).toBeFocused();

    await page.keyboard.press('Alt+ArrowDown');
    await page.keyboard.press('Alt+ArrowDown');
    await expect(options.nth(0)).toHaveText(CAT.name);
    // The second press either waited for the first move or moved the same preset again.
    const order = await options.allTextContents();
    expect([
      [CAT.name, SHELL.name, third.name],
      [CAT.name, third.name, SHELL.name],
    ]).toContainEqual(order);
    expect(configured(hub.configPath)).toEqual(order.map((name) => [...PRESETS, third].find((p) => p.name === name)));
  });
});
