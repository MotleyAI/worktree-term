import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { encodeHomeFragment, encodePrintCode } from '../../protocol/index.js';
import { loadConfig, type HubConfig } from '../config/index.js';
import { forwardToHub, startDetached, type DaemonPaths } from '../links/index.js';
import { Router } from '../router/index.js';
import {
  hubIdentity,
  portServed,
  prepareHubDirs,
  readHubRecord,
  readToken,
  requestCode,
  requestShutdown,
  startHubServer,
  TunnelListeners,
  type HubPaths,
} from '../server/index.js';

export { ConfigError } from '../config/index.js';
export { HubAlreadyRunningError, PortInUseError } from '../server/index.js';

/** Host files the hub uses. */
export type HubHostPaths = HubPaths & DaemonPaths & { config: string };

export interface HubRun {
  /** The package version. */
  version: string;
  paths: HubHostPaths;
  /** The command that runs this `wtd`, without a verb. */
  wtd: readonly string[];
  /** The web bundle directory. */
  webDir: string;
  home: string;
  /** Read for `WTD_HUB_OPEN_MS`, `WTD_HUB_PROBE_MS` and `WTD_HUB_INSTALL_MS`, which shorten the hub's time limits. */
  env: Readonly<Record<string, string | undefined>>;
}

/** What makes a hub of this version serve. */
export interface HubStart {
  version: string;
  paths: HubHostPaths;
  wtd: readonly string[];
  home: string;
}

export interface UiRun extends HubStart {
  /** The browser command. */
  browser: string;
  /** The remote host whose hub the page opens; null for this machine's. */
  host: string | null;
}

const STOP_SIGNALS = ['SIGTERM', 'SIGINT'] as const;
const PROBE_MS = 10_000;
const HUB_START_MS = 5000;
const POLL_MS = 50;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A positive integer number of milliseconds from `value`, else undefined. */
const budget = (value: string | undefined): number | undefined => {
  const ms = Number(value);
  return value !== undefined && Number.isInteger(ms) && ms > 0 ? ms : undefined;
};

/** Whether `config` still forwards `port` to `host` over `alias`. */
const maps = (config: HubConfig, { host, alias, port }: { host: string; alias: string; port: number }): boolean =>
  config.hosts.some((h) => h.name === host && h.ssh === alias && h.port === port);

/** Runs the hub until SIGTERM, SIGINT or an authenticated shutdown request. */
export const runHub = async ({ version, paths, wtd, webDir, home, env }: HubRun): Promise<void> => {
  let stop = (): void => undefined;
  const stopped = new Promise<void>((resolve) => {
    stop = resolve;
  });
  for (const signal of STOP_SIGNALS) process.on(signal, stop);
  try {
    const config = await loadConfig(paths.config, home);
    const instance = randomBytes(12).toString('base64url');
    let latest = config;
    const tunnels = new TunnelListeners({
      forward: (alias, remotePort, socket) => forwardToHub(paths, alias, remotePort, socket),
      current: (target) => maps(latest, target),
    });
    const probeMs = budget(env['WTD_HUB_PROBE_MS']) ?? PROBE_MS;
    const router = new Router({
      paths,
      daemonCommand: [...wtd, 'daemon'],
      configPath: paths.config,
      home,
      config,
      version,
      instance,
      hostName: hostname(),
      bundle: wtd[1] ?? '',
      report: (error) => {
        console.error(error);
      },
      tunnels: {
        ensure: (target) => tunnels.ensure(target),
        probe: (port, signal) => tunnels.probe(port, probeMs, signal),
      },
      configRead: (read) => {
        latest = read;
      },
      budgets: { openMs: budget(env['WTD_HUB_OPEN_MS']), installMs: budget(env['WTD_HUB_INSTALL_MS']) },
    });
    const server = await startHubServer({
      paths,
      port: config.port,
      version,
      instance,
      webDir,
      openSession: (channel) => router.open(channel),
      shutdown: stop,
    });
    await stopped;
    await Promise.all([server.close(), tunnels.close()]);
  } finally {
    for (const signal of STOP_SIGNALS) process.off(signal, stop);
  }
};

/** The port of a hub that answers for its record, if any. */
const answeringHub = async (paths: HubHostPaths): Promise<{ port: number; version: string; token: string } | null> => {
  const record = await readHubRecord(paths.hubRecord);
  const token = await readToken(paths.hubToken);
  if (record === null || token === null) return null;
  const identity = await hubIdentity(record.port, token);
  return identity?.instance === record.instance ? { port: record.port, version: identity.version, token } : null;
};

const waitFor = async <T>(probe: () => Promise<T | null>, ms: number): Promise<T | null> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe(); // NOSONAR(S9382) — polling loop
    if (value !== null || Date.now() >= deadline) return value;
    await sleep(POLL_MS); // NOSONAR(S9382) — polling loop
  }
};

/** Makes a hub of `version` serve: reuses one, replaces one of another version, or starts one. */
const ensureHub = async ({ version, paths, wtd }: HubStart): Promise<{ port: number; token: string }> => {
  const running = await answeringHub(paths);
  if (running?.version === version) return running;
  if (running !== null) {
    await requestShutdown(running.port, running.token);
    const closed = await waitFor(async () => ((await portServed(running.port)) ? null : true), HUB_START_MS);
    if (closed === null) throw new Error(`the running hub on port ${String(running.port)} did not shut down`);
  }
  await prepareHubDirs(paths);
  await startDetached([...wtd, 'hub'], paths.hubLog);
  const started = await waitFor(() => answeringHub(paths), HUB_START_MS);
  if (started === null) throw new Error(`the hub did not start; see ${paths.hubLog}`);
  return started;
};

/** Makes a hub of this version serve, then opens the browser on it with a one-time code, asking it to open `run.host`'s hub. */
export const openUi = async (run: UiRun): Promise<void> => {
  const config = await loadConfig(run.paths.config, run.home);
  if (run.host !== null && !config.hosts.some((h) => h.name === run.host)) {
    throw new Error(`no host named ${run.host} in ${run.paths.config}`);
  }
  const { port, token } = await ensureHub(run);
  const code = await requestCode(port, token);
  const fragment = encodeHomeFragment({ code, hub: run.host });
  await startDetached([run.browser, `--app=http://127.0.0.1:${String(port)}/#${fragment}`], null);
};

/** Makes a hub of this version serve and gives the print-code line with its port and a one-time code. */
export const printCode = async (run: HubStart): Promise<string> => {
  await loadConfig(run.paths.config, run.home);
  const { port, token } = await ensureHub(run);
  return encodePrintCode({ port, code: await requestCode(port, token) });
};
