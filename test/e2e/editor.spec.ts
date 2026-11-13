import type { Locator, Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeMessage, encodeMessage } from '../../src/protocol/index.js';
import { addWorktree, fakeWorktrees, git, makeRepo } from '../support/daemon-host.js';
import { installRemote } from '../support/fake-ssh.js';
import { freePort, type HubHost } from '../support/hub-host.js';
import { remoteHub } from '../support/remote-hub.js';
import { byTestId, hubsEntry, repoTab, terminalBox, TID, worktreeEntry } from './contract.js';
import {
  expect,
  LOCAL,
  makeRepoWith,
  newTerminal,
  nodeRemote,
  openPage,
  openUi,
  PRESETS,
  ready,
  selectRepo,
  selectWorktree,
  stopHub,
  test,
  waitScreen,
  watcher,
  writeHubConfig,
} from './fixture.js';
import { holdAddReplies } from './held-presets.js';
import { pickerSeen, watchPicker } from './panes.js';
import type { BrowserMessage, HubMessage, WireRecorder } from './wire.js';

const ENABLED_TITLE = 'Open in editor (right-click to change the command)';
const HINT = '{path} stands for the worktree path; without it, the path is added at the end.';
/** An editor command whose program exists nowhere, so a click that reaches the hub launches nothing. */
const NO_EDITOR = 'wtd-e2e-no-editor';

const control = (page: Page): Locator => page.locator(byTestId(TID.openEditor));
const form = (page: Page): Locator => page.locator(byTestId(TID.editorForm));
const field = (page: Page): Locator => page.locator(byTestId(TID.editorCommand));
const dialog = (page: Page): Locator => page.locator(byTestId(TID.editorDialog));

/** Writes `config.json` with the e2e presets, `repos` and, unless null, `editor`. */
const configure = (hub: HubHost, repos: readonly string[], editor: string | null = NO_EDITOR): void => {
  hub.writeConfig({ port: hub.port, presets: PRESETS, repos, ...(editor === null ? {} : { editor }) });
};

/** Right-clicks the control where it is drawn, enabled or not. */
const rightClick = async (page: Page): Promise<void> => {
  await control(page).click({ button: 'right', force: true });
};

/** Right-clicks until the form opens: a right-click before the hub's `editor` arrived opens nothing. */
const openForm = async (page: Page): Promise<void> => {
  await expect(async () => {
    await rightClick(page);
    await expect(form(page)).toBeVisible({ timeout: 500 });
  }).toPass();
};

/** `openEditor` and `setEditor` requests the page sent since `from`, without their `req`. */
const editorRequests = (wire: WireRecorder, from = 0): unknown[] =>
  wire.sentMessages(from).flatMap((m): unknown[] => {
    if (m.t === 'openEditor') return [{ t: m.t, worktree: m.worktree }];
    return m.t === 'setEditor' ? [{ t: m.t, command: m.command }] : [];
  });

type EditorRequest = Extract<BrowserMessage, { t: 'openEditor' | 'setEditor' }>;

interface EditorRoute {
  /** The `openEditor` and `setEditor` requests the page sent, in order; none reaches the hub. */
  requests: () => EditorRequest[];
  /** Delivers `message` to the page as if the hub sent it. */
  answer: (message: HubMessage) => void;
}

const isEditorRequest = (m: BrowserMessage): m is EditorRequest => m.t === 'openEditor' || m.t === 'setEditor';

/** Routes the page's WebSockets through the test, keeping editor requests from the hub; with `dropEditor`, the hub's `editor` too. */
const routeEditor = async (page: Page, { dropEditor = false }: { dropEditor?: boolean } = {}): Promise<EditorRoute> => {
  const requests: EditorRequest[] = [];
  let toPage: ((text: string) => void) | null = null;
  await page.routeWebSocket(
    (url) => url.pathname === '/ws',
    (ws) => {
      const server = ws.connectToServer();
      toPage = (text) => {
        ws.send(text);
      };
      ws.onMessage((message) => {
        if (typeof message === 'string') {
          const m = decodeMessage('browserToHub', message);
          if (isEditorRequest(m)) {
            requests.push(m);
            return;
          }
        }
        server.send(message);
      });
      server.onMessage((message) => {
        if (dropEditor && typeof message === 'string' && decodeMessage('hubToBrowser', message).t === 'editor') return;
        ws.send(message);
      });
    },
  );
  return {
    requests: () => [...requests],
    answer: (message) => {
      if (toPage === null) throw new Error('no WebSocket session');
      toPage(encodeMessage('hubToBrowser', message));
    },
  };
};

/** The req of the only editor request the route holds, once the page sent it. */
const heldReq = async (route: EditorRoute): Promise<number> => {
  await expect.poll(() => route.requests().length).toBe(1);
  return route.requests()[0]?.req ?? 0;
};

/** The dialog's text with any backticks removed. */
const dialogText = async (page: Page): Promise<string> => ((await dialog(page).textContent()) ?? '').replaceAll('`', '');

test.describe('open in editor', () => {
  test('is the last control of the tab bar, after split right and split down, titled for both clicks', async ({ hub, page }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    configure(hub, [repo]);
    await openUi(hub, page);
    for (let i = 0; i < 3; i++) await newTerminal(page); // NOSONAR(S9382) — sequential setup
    await expect(page.locator(byTestId(TID.termTab))).toHaveCount(3);
    const order = await page
      .locator('.term-tabs [data-testid]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')).filter((id) => id !== null && !id.startsWith('term-tab')));
    expect(order.slice(-3)).toEqual([TID.splitRight, TID.splitDown, TID.openEditor]);
    await expect(control(page)).toBeEnabled();
    await expect(control(page)).toHaveAttribute('title', ENABLED_TITLE);
    const [down, editor] = await Promise.all([page.locator(byTestId(TID.splitDown)).boundingBox(), control(page).boundingBox()]);
    expect(editor?.x ?? 0).toBeGreaterThan(down?.x ?? 0);
  });

  test('sends openEditor for the selected worktree and stays disabled until the answer, showing nothing on done', async ({ hub, page }) => {
    const route = await routeEditor(page);
    const { repo } = makeRepoWith(hub, 'app', []);
    const spaced = addWorktree(repo, join(hub.dir, 'repos', 'feat x'), 'feat');
    configure(hub, [repo]);
    await openUi(hub, page);
    await selectWorktree(page, spaced);
    await control(page).click();
    const req = await heldReq(route);
    expect(route.requests()).toEqual([{ t: 'openEditor', req, worktree: spaced }]);
    await expect(control(page)).toBeDisabled();

    route.answer({ t: 'done', req });
    await expect(control(page)).toBeEnabled();
    await expect(control(page)).toHaveAttribute('title', ENABLED_TITLE);
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.locator(byTestId(TID.notice))).toHaveCount(0);
  });

  test('sends openEditor through the hub, which answers for the command it holds', async ({ hub, page, wire }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    configure(hub, [repo]);
    await openUi(hub, page);
    await expect(page.locator(worktreeEntry(repo))).toHaveAttribute('aria-selected', 'true');
    const from = wire.markSent();
    await control(page).click();
    await expect(dialog(page)).toBeVisible();
    expect(editorRequests(wire, from)).toEqual([{ t: 'openEditor', worktree: repo }]);
    expect(await dialogText(page)).toContain(`Could not find ${NO_EDITOR}.`);
  });

  test('is disabled, saying why, while no worktree is selected, and a click sends nothing', async ({ hub, page, wire }) => {
    configure(hub, []);
    await openUi(hub, page);
    await expect(control(page)).toBeDisabled();
    await expect(control(page)).toHaveAttribute('title', /no worktree is selected/i);
    const from = wire.markSent();
    await control(page).click({ force: true });
    await page.waitForTimeout(300); // NOSONAR(S2925) — absence check: nothing to synchronise on
    expect(editorRequests(wire, from)).toEqual([]);
    await expect(dialog(page)).toHaveCount(0);
  });

  test('is disabled for a prunable worktree and for a gone worktree with a live terminal', async ({ hub, page }) => {
    const { repo, worktrees } = makeRepoWith(hub, 'app', ['doomed']);
    const doomed = worktrees[0] ?? '';
    const [prunable = ''] = fakeWorktrees(repo, 1);
    configure(hub, [repo]);
    await openUi(hub, page);
    await selectWorktree(page, prunable);
    await expect(control(page)).toBeDisabled();

    await selectWorktree(page, doomed);
    await expect(control(page)).toBeEnabled();
    const term = await newTerminal(page);
    await ready(page, term);
    git(repo, 'worktree', 'remove', '--force', doomed);
    await expect(page.locator(worktreeEntry(doomed))).toHaveAttribute('data-gone', 'true');
    await expect(control(page)).toBeDisabled();
  });

  test('is disabled for a remote host’s worktree on the home page, saying only this machine’s open', async ({ hub, page, ssh }) => {
    const remote = nodeRemote(ssh, 'box');
    await installRemote(hub, ssh, 'box');
    const remoteRepo = makeRepo(join(remote.home, 'src', 'app'));
    const { repo } = makeRepoWith(hub, 'local-app', []);
    writeHubConfig(hub, { repos: [repo], hosts: [{ name: 'box', ssh: 'box', repos: [remoteRepo] }] });
    await openUi(hub, page);
    await expect(control(page)).toBeEnabled();
    await selectRepo(page, remoteRepo);
    await expect(page.locator(worktreeEntry(remoteRepo))).toHaveAttribute('aria-selected', 'true', { timeout: 20_000 });
    await expect(control(page)).toBeDisabled();
    await expect(control(page)).toHaveAttribute('title', /only worktrees on this machine can be opened/i);
    await openForm(page);
  });

  test('says which program is missing and how to fix it', async ({ hub, page }) => {
    const route = await routeEditor(page);
    const { repo } = makeRepoWith(hub, 'app', []);
    configure(hub, [repo], null);
    await openUi(hub, page);
    await control(page).click();
    const req = await heldReq(route);
    route.answer({ t: 'error', req, host: null, code: 'editor-missing', message: 'kate' });
    await expect(dialog(page)).toBeVisible();
    expect(await dialogText(page)).toContain(
      'Could not find kate. Install it, or right-click the editor button to set the command of the editor you prefer.',
    );
    await page.locator(byTestId(TID.editorDialogClose)).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(control(page)).toBeEnabled();
  });

  test('while the failure dialog is open shortcuts act not; once it closes, the terminal takes typed input', async ({ hub, page }) => {
    const route = await routeEditor(page);
    const { repo } = makeRepoWith(hub, 'app', []);
    configure(hub, [repo], null);
    await openUi(hub, page);
    const term = await newTerminal(page);
    await ready(page, term);
    await control(page).click();
    route.answer({ t: 'error', req: await heldReq(route), host: null, code: 'editor-missing', message: 'kate' });
    await expect(dialog(page)).toBeFocused();

    await watchPicker(page);
    await page.keyboard.press('Control+Shift+KeyT');
    await page.waitForTimeout(300); // NOSONAR(S2925) — absence check: nothing to synchronise on
    expect(await pickerSeen(page)).toBe(false);
    await expect(dialog(page)).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    await page.keyboard.type("echo EDITOR''-CLOSED");
    await page.keyboard.press('Enter');
    await waitScreen(page, term, 'EDITOR-CLOSED');
  });

  test('preset choices shown while the failure dialog is open leave it the focus, and take it once it closes', async ({ hub, page }) => {
    const route = await routeEditor(page);
    const { repo } = makeRepoWith(hub, 'app', []);
    configure(hub, [repo], null);
    await openUi(hub, page);
    const daemon = await watcher(hub, repo);
    const term = await daemon.create(repo, { command: 'read -r _; exit 0' });
    await expect(page.locator(terminalBox(LOCAL, term.termId))).toBeVisible();
    await control(page).click();
    route.answer({ t: 'error', req: await heldReq(route), host: null, code: 'editor-missing', message: 'kate' });
    await expect(dialog(page)).toBeFocused();

    daemon.sendInput(term.termId, '\r');
    const options = page.locator(byTestId(TID.presetChoices)).locator(byTestId(TID.presetOption));
    await expect(options.nth(0)).toBeVisible();
    await page.waitForTimeout(300); // NOSONAR(S2925) — absence check: nothing to synchronise on
    await expect(dialog(page)).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    await expect(options.nth(0)).toBeFocused();
  });

  test('an add in the choices completing while the failure dialog is open closes its form and leaves the dialog the focus', async ({
    hub,
    page,
  }) => {
    const adds = await holdAddReplies(page);
    const { repo } = makeRepoWith(hub, 'app', []);
    configure(hub, [repo]);
    await openUi(hub, page);
    const choices = page.locator(byTestId(TID.presetChoices));
    await choices.locator(byTestId(TID.presetAdd)).click();
    await choices.locator(byTestId(TID.presetName)).fill('added');
    await choices.locator(byTestId(TID.presetCommand)).press('Enter');
    await expect.poll(() => adds.held()).toBe(1);
    await control(page).click();
    await expect(dialog(page)).toBeFocused();

    adds.release();
    await expect(choices.locator(byTestId(TID.presetForm))).toHaveCount(0);
    await expect(choices.locator(byTestId(TID.presetOption))).toHaveText([...PRESETS.map((p) => p.name), 'added']);
    await page.waitForTimeout(300); // NOSONAR(S2925) — absence check: nothing to synchronise on
    await expect(dialog(page)).toBeFocused();
  });

  test('names the first word of the shown command as the missing program', async ({ hub, page }) => {
    const route = await routeEditor(page);
    const { repo } = makeRepoWith(hub, 'app', []);
    configure(hub, [repo], `'my ed' --folder {path}`);
    await openUi(hub, page);
    await control(page).click();
    route.answer({ t: 'error', req: await heldReq(route), host: null, code: 'editor-missing', message: 'my ed' });
    await expect(dialog(page)).toBeVisible();
    expect(await dialogText(page)).toContain('Could not find my ed. Install it');
  });

  test('names the program of the command shown when it was clicked, not of one received since', async ({ hub, page }) => {
    const route = await routeEditor(page);
    const { repo } = makeRepoWith(hub, 'app', []);
    configure(hub, [repo], null);
    await openUi(hub, page);
    await control(page).click();
    const req = await heldReq(route);
    route.answer({ t: 'editor', command: 'code {path}' });
    route.answer({ t: 'error', req, host: null, code: 'editor-missing', message: 'kate' });
    await expect(dialog(page)).toBeVisible();
    expect(await dialogText(page)).toContain('Could not find kate. Install it');
  });

  test('has an accessible name', async ({ hub, page }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    configure(hub, [repo]);
    await openUi(hub, page);
    await expect(page.getByRole('button', { name: 'Open selected worktree in editor' })).toHaveAttribute('data-testid', TID.openEditor);
  });

  test('shows another failure’s message as text', async ({ hub, page }) => {
    const route = await routeEditor(page);
    const { repo } = makeRepoWith(hub, 'app', []);
    configure(hub, [repo]);
    await openUi(hub, page);
    await control(page).click();
    route.answer({ t: 'error', req: await heldReq(route), host: null, code: 'editor-failed', message: '<b>no</b>' });
    await expect(dialog(page)).toContainText('Could not open the editor: <b>no</b>');
    await expect(dialog(page).locator('b')).toHaveCount(0);
  });
});

test.describe('editing the editor command', () => {
  test('right-click opens a form holding the shown command, focused and selected, with its hint and controls', async ({ hub, page }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    configure(hub, [repo], 'code --new-window {path}');
    await openUi(hub, page);
    await openForm(page);
    await expect(field(page)).toHaveValue('code --new-window {path}');
    await expect(field(page)).toBeFocused();
    expect(await field(page).evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd, el.value.length])).toEqual([
      0, 24, 24,
    ]);
    await expect(form(page)).toContainText(HINT);
    for (const id of [TID.editorSave, TID.editorReset, TID.editorCancel]) await expect(form(page).locator(byTestId(id))).toBeVisible();
  });

  test('saving sends setEditor, closes the form on done, and shows the command the hub then sends', async ({ hub, page, wire }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    configure(hub, [repo]);
    await openUi(hub, page);
    await openForm(page);
    await field(page).fill('code {path}');
    const from = wire.markSent();
    await form(page).locator(byTestId(TID.editorSave)).click();
    await expect(form(page)).toHaveCount(0);
    expect(editorRequests(wire, from)).toEqual([{ t: 'setEditor', command: 'code {path}' }]);
    await expect.poll((): unknown => JSON.parse(readFileSync(hub.configPath, 'utf8'))).toMatchObject({ editor: 'code {path}' });
    await openForm(page);
    await expect(field(page)).toHaveValue('code {path}');
  });

  test('Enter in the field saves the trimmed command', async ({ hub, page, wire }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    configure(hub, [repo]);
    await openUi(hub, page);
    await openForm(page);
    await field(page).fill('  subl {path}  ');
    const from = wire.markSent();
    await field(page).press('Enter');
    await expect(form(page)).toHaveCount(0);
    expect(editorRequests(wire, from)).toEqual([{ t: 'setEditor', command: 'subl {path}' }]);
  });

  test('Reset to default sends a null command and the form then shows kate', async ({ hub, page, wire }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    configure(hub, [repo], 'code {path}');
    await openUi(hub, page);
    await openForm(page);
    await expect(field(page)).toHaveValue('code {path}');
    const from = wire.markSent();
    await form(page).locator(byTestId(TID.editorReset)).click();
    await expect(form(page)).toHaveCount(0);
    expect(editorRequests(wire, from)).toEqual([{ t: 'setEditor', command: null }]);
    await openForm(page);
    await expect(field(page)).toHaveValue('kate');
    expect(JSON.parse(readFileSync(hub.configPath, 'utf8'))).not.toHaveProperty('editor');
  });

  for (const [name, text] of [
    ['a blank command', '   '],
    ['a command of 4097 characters', 'e'.repeat(4097)],
    ['a command with an unclosed quote', 'code "{path}'],
  ] as const) {
    test(`refuses ${name} in the form, sending nothing`, async ({ hub, page, wire }) => {
      const { repo } = makeRepoWith(hub, 'app', []);
      configure(hub, [repo]);
      await openUi(hub, page);
      await openForm(page);
      await field(page).fill(text);
      const from = wire.markSent();
      await form(page).locator(byTestId(TID.editorSave)).click();
      await expect(form(page).locator(byTestId(TID.editorError))).toBeVisible();
      await expect(form(page)).toBeVisible();
      await page.waitForTimeout(300); // NOSONAR(S2925) — absence check: nothing to synchronise on
      expect(editorRequests(wire, from)).toEqual([]);
    });
  }

  test('saving the command it opened with, trimmed, closes the form and sends nothing', async ({ hub, page, wire }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    configure(hub, [repo], 'code {path}');
    await openUi(hub, page);
    await openForm(page);
    await field(page).fill(' code {path} ');
    const from = wire.markSent();
    await form(page).locator(byTestId(TID.editorSave)).click();
    await expect(form(page)).toHaveCount(0);
    await page.waitForTimeout(300); // NOSONAR(S2925) — absence check: nothing to synchronise on
    expect(editorRequests(wire, from)).toEqual([]);
  });

  test('Escape, Cancel and a press outside close the form without sending, keeping the command', async ({ hub, page, wire }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    configure(hub, [repo], 'code {path}');
    await openUi(hub, page);
    const from = wire.markSent();
    const closers: [string, () => Promise<void>][] = [
      ['Escape', () => field(page).press('Escape')],
      ['Cancel', () => form(page).locator(byTestId(TID.editorCancel)).click()],
      ['outside', () => page.locator('.sidebar-title').click()],
    ];
    for (const [name, close] of closers) {
      await openForm(page); // NOSONAR(S9382) — one closer after another
      await field(page).fill(`changed by ${name}`);
      await close(); // NOSONAR(S9382) — one closer after another
      await expect(form(page), name).toHaveCount(0);
    }
    await openForm(page);
    await expect(field(page)).toHaveValue('code {path}');
    expect(editorRequests(wire, from)).toEqual([]);
  });

  test('right-click on the control disabled for want of a worktree opens the form', async ({ hub, page }) => {
    configure(hub, []);
    await openUi(hub, page);
    await expect(control(page)).toBeDisabled();
    await openForm(page);
    await expect(field(page)).toHaveValue(NO_EDITOR);
  });

  test('shows an error answering a save in the form, which stays open', async ({ hub, page }) => {
    const route = await routeEditor(page);
    const { repo } = makeRepoWith(hub, 'app', []);
    configure(hub, [repo]);
    await openUi(hub, page);
    await openForm(page);
    await field(page).fill('code {path}');
    await form(page).locator(byTestId(TID.editorSave)).click();
    const req = await heldReq(route);
    expect(route.requests()).toEqual([{ t: 'setEditor', req, command: 'code {path}' }]);
    route.answer({ t: 'error', req, host: null, code: 'internal', message: 'config.json: hosts: invalid' });
    await expect(form(page).locator(byTestId(TID.editorError))).toContainText('config.json: hosts: invalid');
    await expect(form(page)).toBeVisible();
  });

  test('shows the command another page saved', async ({ hub, page, context }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    configure(hub, [repo]);
    await openUi(hub, page);
    const other = await openPage(hub, context);
    await expect(other.page.locator(repoTab(repo))).toBeVisible();
    await openForm(other.page);
    await field(other.page).fill('subl {path}');
    await field(other.page).press('Enter');
    await expect(form(other.page)).toHaveCount(0);
    await openForm(page);
    await expect(field(page)).toHaveValue('subl {path}');
  });

  test('an open, untouched form follows a command received meanwhile; an edited one keeps its text', async ({ hub, page }) => {
    const route = await routeEditor(page);
    const { repo } = makeRepoWith(hub, 'app', []);
    configure(hub, [repo], 'code {path}');
    await openUi(hub, page);
    await openForm(page);
    route.answer({ t: 'editor', command: 'subl {path}' });
    await expect(field(page)).toHaveValue('subl {path}');
    await field(page).fill('subl {path}'); // edited, if to the text it already showed
    route.answer({ t: 'editor', command: 'zed {path}' });
    await page.waitForTimeout(300); // NOSONAR(S2925) — absence check: nothing to synchronise on
    await expect(field(page)).toHaveValue('subl {path}');
  });

  test('closes when the hub session closes and stays closed once the page reconnects', async ({ hub, page }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    configure(hub, [repo]);
    await openUi(hub, page);
    await openForm(page);
    await stopHub(hub);
    await expect(page.locator(byTestId(TID.reconnecting))).toBeVisible();
    await expect(form(page)).toHaveCount(0);
    await hub.startHub();
    await expect(page.locator(byTestId(TID.reconnecting))).toBeHidden({ timeout: 15_000 });
    await expect(control(page)).toBeEnabled();
    await page.waitForTimeout(300); // NOSONAR(S2925) — absence check: nothing to synchronise on
    await expect(form(page)).toHaveCount(0);
  });

  test('the context-menu key opens the form from the control disabled for want of a worktree', async ({ hub, page }) => {
    configure(hub, []);
    await openUi(hub, page);
    await expect(control(page)).toBeDisabled();
    await expect(async () => {
      await control(page).focus();
      await page.keyboard.press('Shift+F10');
      await expect(form(page)).toBeVisible({ timeout: 500 });
    }).toPass();
    await expect(field(page)).toBeFocused();
  });

  test('a save answered after its form closed leaves the form opened since alone', async ({ hub, page }) => {
    const route = await routeEditor(page);
    const { repo } = makeRepoWith(hub, 'app', []);
    configure(hub, [repo]);
    await openUi(hub, page);
    await openForm(page);
    await field(page).fill('code {path}');
    await field(page).press('Enter');
    const req = await heldReq(route);
    await field(page).press('Escape');
    await expect(form(page)).toHaveCount(0);
    await openForm(page);
    await field(page).fill('subl {path}');
    route.answer({ t: 'done', req });
    await page.waitForTimeout(300); // NOSONAR(S2925) — absence check: nothing to synchronise on
    await expect(form(page)).toBeVisible();
    await expect(field(page)).toHaveValue('subl {path}');
  });

  test('fits a viewport narrower than its width', async ({ hub, page }) => {
    const { repo } = makeRepoWith(hub, 'app', []);
    configure(hub, [repo]);
    await page.setViewportSize({ width: 360, height: 640 });
    await openUi(hub, page);
    await openForm(page);
    const box = await form(page).boundingBox();
    expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(360);
  });

  test('before the hub sent the command, the control is disabled and right-click opens no form', async ({ hub, page }) => {
    await routeEditor(page, { dropEditor: true });
    const { repo } = makeRepoWith(hub, 'app', []);
    configure(hub, [repo]);
    await openUi(hub, page);
    await expect(page.locator(worktreeEntry(repo))).toHaveAttribute('aria-selected', 'true');
    await expect(control(page)).toBeDisabled();
    await rightClick(page);
    await page.waitForTimeout(300); // NOSONAR(S2925) — absence check: nothing to synchronise on
    await expect(form(page)).toHaveCount(0);
  });
});

test.describe('on a remote page', () => {
  test('the control is disabled, saying only this machine’s open, and right-click opens no form', async ({ hub, page, ssh }) => {
    test.setTimeout(120_000);
    const box = await remoteHub(hub, ssh, 'box', [hub.port]);
    let port = await freePort();
    while (port === hub.port || port === box.port) port = await freePort(); // NOSONAR(S9382) — retries until a port outside both is free
    const { repo } = makeRepoWith(hub, 'local-app', []);
    writeHubConfig(hub, { repos: [repo], hosts: [{ name: 'box', ssh: 'box', port }] });
    await openUi(hub, page);
    await page.locator(byTestId(TID.hubsMenu)).click();
    await page.locator(hubsEntry('box')).click();
    await expect.poll(() => page.url(), { timeout: 30_000 }).toBe(`http://127.0.0.1:${String(port)}/`);
    await expect(page.locator(worktreeEntry(box.repo))).toHaveAttribute('aria-selected', 'true', { timeout: 20_000 });
    await expect(control(page)).toBeDisabled();
    await expect(control(page)).toHaveAttribute('title', /only worktrees on this machine can be opened/i);
    await rightClick(page);
    await page.waitForTimeout(300); // NOSONAR(S2925) — absence check: nothing to synchronise on
    await expect(form(page)).toHaveCount(0);
  });
});
