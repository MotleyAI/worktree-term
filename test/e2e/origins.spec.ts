import type { Locator, Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FakeSsh } from '../support/fake-ssh.js';
import type { HubHost } from '../support/hub-host.js';
import { byTestId, groupTab, terminalBox, TID, worktreeAt, worktreeEntry } from './contract.js';
import {
  confirmAction,
  expect,
  hostEntries,
  LOCAL,
  newTerminal,
  openUi,
  REMOTE,
  selectWorktree,
  stopHub,
  test,
  writeHubConfig,
} from './fixture.js';
import {
  cloneAt,
  discoveredOn,
  discoveriesSent,
  dropLinks,
  installedRemote,
  listedRows,
  plainPath,
  reachable,
  row,
  selectRow,
  sentJson,
  watchesSent,
} from './origins.js';
import type { WireRecorder } from './wire.js';

const BOX = REMOTE;
const GPU = REMOTE + 1;
const REMOTE_TIMEOUT = { timeout: 20_000 };

const tabs = (page: Page): Locator => page.locator(byTestId(TID.repoTab));

/** This machine lists `<hub>/r/app` (worktree `feat`) and box lists `<box home>/srv/app` (worktree `fix`), both of origin `app`; opens the page. */
const sharedApp = async (hub: HubHost, ssh: FakeSsh, page: Page): Promise<{ local: string; feat: string; boxApp: string; fix: string }> => {
  plainPath(hub);
  const remote = await installedRemote(hub, ssh, 'box');
  const local = cloneAt(join(hub.dir, 'r', 'app'), 'app', ['feat']);
  const boxApp = cloneAt(join(remote.home, 'srv', 'app'), 'app', ['fix']);
  writeHubConfig(hub, { repos: [local.repo], hosts: [{ name: 'box', ssh: 'box', repos: [boxApp.repo] }] });
  await openUi(hub, page);
  return { local: local.repo, feat: local.worktrees[0] ?? '', boxApp: boxApp.repo, fix: boxApp.worktrees[0] ?? '' };
};

/** This machine and box both list the same directory `<box home>/app`, of origin `app`; opens the page. */
const samePath = async (hub: HubHost, ssh: FakeSsh, page: Page): Promise<string> => {
  plainPath(hub);
  const remote = await installedRemote(hub, ssh, 'box');
  const { repo } = cloneAt(join(remote.home, 'app'), 'app');
  writeHubConfig(hub, { repos: [repo], hosts: [{ name: 'box', ssh: 'box', repos: [repo] }] });
  await openUi(hub, page);
  await expect.poll(() => listedRows(page), REMOTE_TIMEOUT).toEqual([row(LOCAL, repo), row(BOX, repo)]);
  return repo;
};

/** The `removeRepo` and `removeRepos` requests the page sent since `from`. */
const removals = (wire: WireRecorder, from: number): Record<string, unknown>[] =>
  sentJson(wire, from).filter((m) => m['t'] === 'removeRepo' || m['t'] === 'removeRepos');

/** Waits until `host` is `status` in a `hosts` message received since `from`. */
const hostBecomes = async (wire: WireRecorder, host: number, status: string, from: number): Promise<void> => {
  await expect.poll(() => hostEntries(wire, host, from).map((h) => h.status), REMOTE_TIMEOUT).toContain(status);
};

test.describe('repo tabs by origin', () => {
  test('a repo of the same origin on this machine and on box is one tab, labelled app, listing this machine’s worktrees, then box’s', async ({
    hub,
    page,
    ssh,
  }) => {
    test.setTimeout(120_000);
    const { local, feat, boxApp, fix } = await sharedApp(hub, ssh, page);
    await expect(tabs(page)).toHaveText(['app'], REMOTE_TIMEOUT);
    await expect(page.locator(groupTab(local))).toHaveAttribute('title', `${local}\nbox:${boxApp}`);
    await expect
      .poll(() => listedRows(page), REMOTE_TIMEOUT)
      .toEqual([row(LOCAL, local), row(LOCAL, feat), row(BOX, boxApp), row(BOX, fix)]);
  });

  test('a repo only remote hosts list keeps its tab, labelled box:api, and gathers gpu’s clone of it', async ({ hub, page, ssh }) => {
    test.setTimeout(150_000);
    plainPath(hub);
    const box = await installedRemote(hub, ssh, 'box');
    const gpu = await installedRemote(hub, ssh, 'gpu');
    const boxApi = cloneAt(join(box.home, 'srv', 'api'), 'api').repo;
    const gpuApi = cloneAt(join(gpu.home, 'data', 'api'), 'api').repo;
    writeHubConfig(hub, {
      hosts: [
        { name: 'box', ssh: 'box', repos: [boxApi] },
        { name: 'gpu', ssh: 'gpu', repos: [gpuApi] },
      ],
    });
    await openUi(hub, page);
    await expect.poll(() => listedRows(page), REMOTE_TIMEOUT).toEqual([row(BOX, boxApi), row(GPU, gpuApi)]);
    await expect(tabs(page)).toHaveText(['box:api']);
    await expect(page.locator(groupTab(`box:${boxApi}`))).toHaveAttribute('title', `box:${boxApi}\ngpu:${gpuApi}`);
  });

  test('repos without an origin stay apart, and a discovered repo without one is not watched', async ({ hub, page, ssh, wire }) => {
    test.setTimeout(120_000);
    plainPath(hub);
    const remote = await installedRemote(hub, ssh, 'box');
    const local = cloneAt(join(hub.dir, 'r', 'a'), null).repo;
    const boxA = cloneAt(join(remote.home, 'srv', 'a'), null).repo;
    const boxB = cloneAt(join(remote.home, 'srv', 'b'), null).repo;
    writeHubConfig(hub, { repos: [local], hosts: [{ name: 'box', ssh: 'box', repos: [boxA] }] });
    await openUi(hub, page);
    await expect.poll(() => discoveredOn(wire, BOX), REMOTE_TIMEOUT).toBe(true);
    await expect(tabs(page)).toHaveText(['a', 'box:a']);
    await page.waitForTimeout(500); // NOSONAR(S2925) — absence check: nothing to synchronise on
    expect(watchesSent(wire, BOX)).not.toContain(boxB);
  });

  test('a repo of box down at load has its tab box:app with the status down, merging into app once box connects', async ({
    hub,
    page,
    ssh,
  }) => {
    test.setTimeout(150_000);
    plainPath(hub);
    const remote = await installedRemote(hub, ssh, 'box');
    const local = cloneAt(join(hub.dir, 'r', 'app'), 'app').repo;
    const boxApp = cloneAt(join(remote.home, 'srv', 'app'), 'app').repo;
    ssh.failHost('box', 'ssh: Could not resolve hostname box');
    writeHubConfig(hub, { repos: [local], hosts: [{ name: 'box', ssh: 'box', repos: [boxApp] }] });
    await openUi(hub, page);
    const own = page.locator(groupTab(`box:${boxApp}`));
    await expect(own.locator(byTestId(TID.hostStatus))).toHaveText('down', REMOTE_TIMEOUT);
    await expect(tabs(page)).toHaveCount(2);
    await expect(own).toContainText('box:app');

    reachable(ssh, 'box');
    await expect(tabs(page)).toHaveText(['app'], { timeout: 30_000 });
    await expect(page.locator(groupTab(local))).toHaveAttribute('title', `${local}\nbox:${boxApp}`);
    await expect(page.locator(worktreeAt(BOX, boxApp))).toBeVisible();
  });

  test('box’s repo merged into app stays there, with no box:app tab, while box reconnects', async ({ hub, page, ssh, wire }) => {
    test.setTimeout(120_000);
    const { boxApp } = await sharedApp(hub, ssh, page);
    await expect(page.locator(worktreeAt(BOX, boxApp))).toBeVisible(REMOTE_TIMEOUT);
    await expect(tabs(page)).toHaveText(['app']);

    const from = wire.markReceived();
    const release = ssh.holdHost('box');
    dropLinks(ssh, 'box');
    await hostBecomes(wire, BOX, 'reconnecting', from);
    await page.waitForTimeout(500); // NOSONAR(S2925) — absence check: nothing to synchronise on
    await expect(tabs(page)).toHaveText(['app']);
    expect(hostEntries(wire, BOX).at(-1)?.status).toBe('reconnecting');
    release();
  });

  test('two clones this machine lists with the same origin share the tab app', async ({ hub, page }) => {
    plainPath(hub);
    const app = cloneAt(join(hub.dir, 'r', 'app'), 'app').repo;
    const app2 = cloneAt(join(hub.dir, 'r', 'app-2'), 'app').repo;
    writeHubConfig(hub, { repos: [app, app2] });
    await openUi(hub, page);
    await expect.poll(() => listedRows(page)).toEqual([row(LOCAL, app), row(LOCAL, app2)]);
    await expect(tabs(page)).toHaveText(['app']);
    await expect(page.locator(groupTab(app))).toHaveAttribute('title', `${app}\n${app2}`);
  });

  test('view preferences follow the origin across a reload, whichever of its clones config.json lists first', async ({ hub, page }) => {
    plainPath(hub);
    const app = cloneAt(join(hub.dir, 'r', 'app'), 'app').repo;
    const app2 = cloneAt(join(hub.dir, 'r', 'app-2'), 'app').repo;
    writeHubConfig(hub, { repos: [app] });
    await openUi(hub, page);
    await expect(page.locator(worktreeEntry(app))).toBeVisible();
    await page.locator(byTestId(TID.filterChecked)).check();

    await stopHub(hub);
    writeHubConfig(hub, { repos: [app2, app] });
    await hub.startHub();
    await page.reload();
    await expect(tabs(page)).toHaveText(['app-2']);
    await expect(page.locator(groupTab(app))).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator(byTestId(TID.filterChecked))).toBeChecked();
  });
});

test.describe('clone discovery', () => {
  test('a clone on box with the origin of a listed repo is watched and listed in its tab; a clone of another origin is not', async ({
    hub,
    page,
    ssh,
    wire,
  }) => {
    test.setTimeout(120_000);
    plainPath(hub);
    const remote = await installedRemote(hub, ssh, 'box');
    const local = cloneAt(join(hub.dir, 'r', 'app'), 'app').repo;
    const clone = cloneAt(join(remote.home, 'src', 'app'), 'app', ['feat']);
    const other = cloneAt(join(remote.home, 'src', 'other'), 'other').repo;
    writeHubConfig(hub, { repos: [local], hosts: [{ name: 'box', ssh: 'box', repos: [] }] });
    await openUi(hub, page);
    await expect.poll(() => watchesSent(wire, BOX), REMOTE_TIMEOUT).toContain(clone.repo);
    await expect
      .poll(() => listedRows(page), REMOTE_TIMEOUT)
      .toEqual([row(LOCAL, local), row(BOX, clone.repo), row(BOX, clone.worktrees[0] ?? '')]);
    await expect(tabs(page)).toHaveText(['app']);
    await page.waitForTimeout(500); // NOSONAR(S2925) — absence check: nothing to synchronise on
    expect(watchesSent(wire, BOX).filter((repo) => repo === clone.repo)).toHaveLength(1);
    expect(watchesSent(wire, BOX)).not.toContain(other);
  });

  test('a clone on this machine with the origin of a listed repo is watched; one of another origin is not', async ({ hub, page, wire }) => {
    plainPath(hub);
    const root = join(hub.dir, 'r');
    const app = cloneAt(join(root, 'app'), 'app').repo;
    const app2 = cloneAt(join(root, 'app-2'), 'app').repo;
    const other = cloneAt(join(root, 'other'), 'other').repo;
    writeHubConfig(hub, { repos: [app], roots: [root] });
    await openUi(hub, page);
    await expect.poll(() => listedRows(page)).toEqual([row(LOCAL, app), row(LOCAL, app2)]);
    await expect(tabs(page)).toHaveText(['app']);
    await page.waitForTimeout(500); // NOSONAR(S2925) — absence check: nothing to synchronise on
    expect(watchesSent(wire, LOCAL).filter((repo) => repo === app2)).toHaveLength(1);
    expect(watchesSent(wire, LOCAL)).not.toContain(other);
  });

  test('each host is discovered once per session: this machine at the start, box at its first connection and not after reconnecting', async ({
    hub,
    page,
    ssh,
    wire,
  }) => {
    test.setTimeout(120_000);
    plainPath(hub);
    const remote = await installedRemote(hub, ssh, 'box');
    const local = cloneAt(join(hub.dir, 'r', 'app'), 'app').repo;
    const boxApp = cloneAt(join(remote.home, 'srv', 'app'), 'app').repo;
    const release = ssh.holdHost('box');
    writeHubConfig(hub, { repos: [local], hosts: [{ name: 'box', ssh: 'box', repos: [boxApp] }] });
    await openUi(hub, page);
    await expect.poll(() => discoveriesSent(wire, LOCAL)).toBe(1);
    expect(discoveriesSent(wire, BOX)).toBe(0);

    release();
    await expect.poll(() => discoveriesSent(wire, BOX), REMOTE_TIMEOUT).toBe(1);
    const from = wire.markReceived();
    dropLinks(ssh, 'box');
    await hostBecomes(wire, BOX, 'reconnecting', from);
    await expect.poll(() => hostEntries(wire, BOX, from).at(-1)?.status, REMOTE_TIMEOUT).toBe('connected');
    await page.waitForTimeout(1000); // NOSONAR(S2925) — absence check: nothing to synchronise on
    expect(discoveriesSent(wire, BOX)).toBe(1);
    expect(discoveriesSent(wire, LOCAL)).toBe(1);
  });

  test('the add-repo dialog and the session discover box side by side, each following only its own reply', async ({
    hub,
    page,
    ssh,
    wire,
  }) => {
    test.setTimeout(120_000);
    plainPath(hub);
    const remote = await installedRemote(hub, ssh, 'box');
    const boxApp = cloneAt(join(remote.home, 'srv', 'app'), 'app').repo;
    const clone = cloneAt(join(remote.home, 'srv', 'app-2'), 'app').repo;
    const other = cloneAt(join(remote.home, 'srv', 'other'), 'other').repo;
    const release = ssh.holdHost('box');
    writeHubConfig(hub, { hosts: [{ name: 'box', ssh: 'box', repos: [boxApp] }] });
    await openUi(hub, page);
    await expect(tabs(page)).toHaveCount(1);
    await page.locator(byTestId(TID.addRepo)).click();
    const dialog = page.locator(byTestId(TID.addRepoDialog));
    await expect(dialog.locator(byTestId(TID.addRepoHost))).toHaveValue(String(BOX));

    release();
    await expect
      .poll(
        () => dialog.locator(byTestId(TID.addRepoOption)).evaluateAll((options) => options.map((o) => o.getAttribute('title') ?? '')),
        REMOTE_TIMEOUT,
      )
      .toEqual([clone, other]);
    await expect.poll(() => watchesSent(wire, BOX), REMOTE_TIMEOUT).toContain(clone);
    await page.waitForTimeout(500); // NOSONAR(S2925) — absence check: nothing to synchronise on
    expect(discoveriesSent(wire, BOX)).toBe(2);
    expect(watchesSent(wire, BOX).filter((repo) => repo === clone)).toHaveLength(1);
    expect(watchesSent(wire, BOX)).not.toContain(other);
    await expect(dialog).toBeVisible();
  });
});

test.describe('selection across hosts', () => {
  test('with the same path on this machine and box, selecting box’s row selects only it, shows its terminals, and survives a reload', async ({
    hub,
    page,
    ssh,
  }) => {
    test.setTimeout(120_000);
    const repo = await samePath(hub, ssh, page);
    await selectRow(page, BOX, repo);
    await expect(page.locator(worktreeAt(LOCAL, repo))).toHaveAttribute('aria-selected', 'false');
    const term = await newTerminal(page, 'shell', BOX);

    await page.reload();
    await expect(page.locator(worktreeAt(BOX, repo))).toHaveAttribute('aria-selected', 'true', REMOTE_TIMEOUT);
    await expect(page.locator(worktreeAt(LOCAL, repo))).toHaveAttribute('aria-selected', 'false');
    await expect(page.locator(terminalBox(BOX, term))).toBeVisible();
  });

  test('a selected worktree of box:app stays selected, its tab too, when this machine adds a clone of its origin and removes it again', async ({
    hub,
    page,
    ssh,
  }) => {
    test.setTimeout(120_000);
    plainPath(hub);
    const remote = await installedRemote(hub, ssh, 'box');
    const boxApp = cloneAt(join(remote.home, 'srv', 'app'), 'app', ['fix']);
    const fix = boxApp.worktrees[0] ?? '';
    const local = cloneAt(join(hub.dir, 'r', 'app'), 'app').repo;
    writeHubConfig(hub, { hosts: [{ name: 'box', ssh: 'box', repos: [boxApp.repo] }] });
    await openUi(hub, page);
    await expect(tabs(page)).toHaveText(['box:app'], REMOTE_TIMEOUT);
    await expect(page.locator(worktreeEntry(fix))).toBeVisible(REMOTE_TIMEOUT);
    await selectWorktree(page, fix);

    const other = await hub.session();
    try {
      expect((await other.hubRequest({ t: 'addRepo', host: LOCAL, repo: local })).m.t).toBe('done');
      await expect(tabs(page)).toHaveText(['app'], REMOTE_TIMEOUT);
      await expect(page.locator(groupTab(local))).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator(worktreeAt(LOCAL, local))).toBeVisible();
      await expect(page.locator(worktreeAt(BOX, fix))).toHaveAttribute('aria-selected', 'true');

      expect((await other.hubRequest({ t: 'removeRepo', host: LOCAL, repo: local })).m.t).toBe('done');
      await expect(tabs(page)).toHaveText(['box:app'], REMOTE_TIMEOUT);
      await expect(page.locator(groupTab(`box:${boxApp.repo}`))).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator(worktreeAt(BOX, fix))).toHaveAttribute('aria-selected', 'true');
    } finally {
      other.close();
    }
  });
});

test.describe('worktree rows of every clone', () => {
  test('hovering a row of box shows box:<path> and no terminals', async ({ hub, page, ssh }) => {
    test.setTimeout(120_000);
    const { fix } = await sharedApp(hub, ssh, page);
    await expect(page.locator(worktreeAt(BOX, fix))).toHaveAttribute('title', `box:${fix}\nno terminals`, REMOTE_TIMEOUT);
  });

  test('toggling the checkbox of box’s row sends setChecked to box and changes only that row', async ({ hub, page, ssh, wire }) => {
    test.setTimeout(120_000);
    const repo = await samePath(hub, ssh, page);
    const checkbox = (host: number): Locator => page.locator(worktreeAt(host, repo)).locator('input[type="checkbox"]');
    const from = wire.markSent();
    await checkbox(BOX).check();
    await expect(checkbox(BOX)).toBeChecked();
    await expect
      .poll(() => wire.sentToHost(BOX, from).flatMap((m) => (m.t === 'setChecked' ? [{ worktree: m.worktree, checked: m.checked }] : [])))
      .toEqual([{ worktree: repo, checked: true }]);
    expect(wire.sentToHost(LOCAL, from).filter((m) => m.t === 'setChecked')).toEqual([]);
    await expect(checkbox(LOCAL)).not.toBeChecked();
  });
});

test.describe('removing a repo group', () => {
  test('removing the tab app names this machine’s and box’s listed repos, sends one removeRepos with both, and the tab disappears', async ({
    hub,
    page,
    ssh,
    wire,
  }) => {
    test.setTimeout(120_000);
    plainPath(hub);
    const remote = await installedRemote(hub, ssh, 'box');
    const local = cloneAt(join(hub.dir, 'r', 'app'), 'app').repo;
    const boxApp = cloneAt(join(remote.home, 'srv', 'app'), 'app').repo;
    const clone = cloneAt(join(remote.home, 'srv', 'app-2'), 'app').repo;
    writeHubConfig(hub, { repos: [local], hosts: [{ name: 'box', ssh: 'box', repos: [boxApp] }] });
    await openUi(hub, page);
    await expect(page.locator(worktreeAt(BOX, clone))).toBeVisible(REMOTE_TIMEOUT);

    const from = wire.markSent();
    await page.locator(groupTab(local)).locator(byTestId(TID.removeRepo)).click();
    const dialog = page.locator(byTestId(TID.confirmDialog));
    await expect(dialog).toContainText(local);
    await expect(dialog).toContainText(`box:${boxApp}`);
    await expect(dialog).not.toContainText(clone);
    expect(removals(wire, from)).toEqual([]);
    await confirmAction(page);
    await expect(tabs(page)).toHaveCount(0, REMOTE_TIMEOUT);
    expect(removals(wire, from).map(({ t, members }) => ({ t, members }))).toEqual([
      {
        t: 'removeRepos',
        members: [
          { host: LOCAL, repo: local },
          { host: BOX, repo: boxApp },
        ],
      },
    ]);
    expect(JSON.parse(readFileSync(hub.configPath, 'utf8'))).toMatchObject({ repos: [], hosts: [{ name: 'box', repos: [] }] });
  });
});
