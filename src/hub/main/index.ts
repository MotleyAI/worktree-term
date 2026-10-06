import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { loadConfig } from '../config/index.js';
import { startDetached, type DaemonPaths } from '../links/index.js';
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
}

export interface UiRun {
  version: string;
  paths: HubHostPaths;
  wtd: readonly string[];
  home: string;
  /** The browser command. */
  browser: string;
}

const STOP_SIGNALS = ['SIGTERM', 'SIGINT'] as const;
const HUB_START_MS = 5000;
const POLL_MS = 50;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs the hub until SIGTERM, SIGINT or an authenticated shutdown request. */
export const runHub = async ({ version, paths, wtd, webDir, home }: HubRun): Promise<void> => {
  let stop = (): void => undefined;
  const stopped = new Promise<void>((resolve) => {
    stop = resolve;
  });
  for (const signal of STOP_SIGNALS) process.on(signal, stop);
  try {
    const config = await loadConfig(paths.config, home);
    const instance = randomBytes(12).toString('base64url');
    const router = new Router({
      paths,
      daemonCommand: [...wtd, 'daemon'],
      configPath: paths.config,
      home,
      config,
      version,
      instance,
      hostName: hostname(),
      report: (error) => {
        console.error(error);
      },
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
    await server.close();
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
const ensureHub = async ({ version, paths, wtd }: UiRun): Promise<{ port: number; token: string }> => {
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

/** Makes a hub of this version serve, then opens the browser on it with a one-time code. */
export const openUi = async (run: UiRun): Promise<void> => {
  await loadConfig(run.paths.config, run.home);
  const { port, token } = await ensureHub(run);
  const code = await requestCode(port, token);
  await startDetached([run.browser, `--app=http://127.0.0.1:${String(port)}/#code=${code}`], null);
};
