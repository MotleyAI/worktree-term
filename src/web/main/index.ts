import { h, render } from 'preact';
import { HubClient, RequestError, Restorer } from '../client/index.js';
import { TerminalManager } from '../terminals/index.js';
import { App, View } from '../ui/index.js';

/** The package version, defined at build time. */
declare const __WTD_VERSION__: string;

const client = new HubClient(__WTD_VERSION__);
const manager = new TerminalManager(client);
const view = new View(client, manager);

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
  restorer.connected(host, instance, repos).catch((error: unknown) => {
    console.error(`restoring host ${String(host)} failed`, error);
  });
});

const root = document.getElementById('app');
if (root === null) throw new Error('no #app element');
render(h(App, { client, manager, view }), root);
client.start();
