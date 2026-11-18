import { h, render } from 'preact';
import { HubClient, pageTitle, RequestError, Restorer } from '../client/index.js';
import { TerminalManager } from '../terminals/index.js';
import { App, FocusOrigin, readPageFocus, trackFocusOrigin, View } from '../ui/index.js';

/** The package version, defined at build time. */
declare const __WTD_VERSION__: string;

const client = new HubClient(__WTD_VERSION__);
const manager = new TerminalManager(client);
const view = new View(client, manager);

const origin = new FocusOrigin<Element>();
trackFocusOrigin(origin);

manager.setKeyFilter((event) => !view.handleKey(event, true));
document.addEventListener('keydown', (event) => {
  // Keys in a terminal reach the view through the terminal's key filter.
  if (manager.owns(event.target instanceof Node ? event.target : null)) return;
  view.handleKey(event, false);
  view.claimKey(event, readPageFocus(manager, origin));
});

// A click claims once its own handlers and renders have run; a double click leaves the focus to them.
let clickClaim: ReturnType<typeof setTimeout> | undefined;
document.addEventListener('click', (event) => {
  if (event.detail === 0) return;
  clearTimeout(clickClaim);
  clickClaim = setTimeout(() => {
    view.claimFocus('click', readPageFocus(manager, origin));
  });
});
document.addEventListener('dblclick', () => {
  clearTimeout(clickClaim);
});
window.addEventListener('focus', () => {
  view.claimFocus('windowFocus', readPageFocus(manager, origin));
});

const restorer = new Restorer({
  watch: async (host, repo) => {
    try {
      await client.request(host, { t: 'watchRepo', repo });
      return true;
    } catch (error) {
      if (error instanceof RequestError) client.store.repoError(host, repo, { code: error.code, message: error.message });
      else console.warn(`watching ${repo} failed`, error);
      return false;
    }
  },
  attached: (host, repo) => manager.attachedOf(host, repo),
  listed: (host, repo) => client.store.terminalIds(host, repo),
  attach: (host, termId) => {
    manager.attach(host, termId);
  },
  drop: (host, termId) => {
    manager.disposeTerm(host, termId);
  },
  dispose: (host) => {
    manager.disposeHost(host);
    client.store.clearHost(host);
  },
});

client.onHostConnected((host, instance, repos) => {
  restorer
    .connected(host, instance, repos)
    .then(() => {
      manager.restored(host);
    })
    .catch((error: unknown) => {
      console.error(`restoring host ${String(host)} failed`, error);
    });
});

const root = document.getElementById('app');
if (root === null) throw new Error('no #app element');
render(h(App, { client, manager, view }), root);
client.start();
document.title = pageTitle(client.remote);
