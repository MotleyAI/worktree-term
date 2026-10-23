import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { decodeMessage, type MessageOf } from '../../protocol/index.js';
import { hostPaths } from '../../platform/files/index.js';
import { parseConfig } from '../config/index.js';
import { Router, type HubTunnels, type RoutedSession } from './index.js';

let dir: string;
let routed: RoutedSession[];

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'wtd-router-')));
  routed = [];
  // Records each print-code run; every other SSH run fails as an unreachable host.
  const program = join(dir, 'ssh');
  writeFileSync(program, `#!/bin/sh\ncase "$*" in *--print-code*) echo $$ >> '${dir}/printed'; exec sleep 600;; esac\nexit 255\n`);
  chmodSync(program, 0o755);
  vi.stubEnv('WTD_SSH', program);
});

afterEach(() => {
  for (const session of routed) session.close();
  vi.unstubAllEnvs();
  for (const pid of printRuns()) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

const printRuns = (): number[] => {
  const file = join(dir, 'printed');
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(Number) : [];
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (probe: () => boolean, what: string, timeout = 5000): Promise<void> => {
  const deadline = Date.now() + timeout;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
};

const tunnels: HubTunnels = {
  ensure: () => Promise.reject(new Error('no tunnel expected')),
  probe: () => Promise.resolve('no probe expected'),
};

/** A started session of a router whose config has one remote host `box`. */
const session = async (): Promise<RoutedSession> => {
  const configPath = join(dir, 'config.json');
  const text = JSON.stringify({ port: 7417, hosts: [{ name: 'box', ssh: 'box' }] });
  writeFileSync(configPath, text);
  const router = new Router({
    paths: hostPaths({ env: { XDG_STATE_HOME: join(dir, 's') }, home: dir, host: 'local' }),
    daemonCommand: ['true'],
    configPath,
    home: dir,
    config: parseConfig(text, dir),
    version: '0.0.0',
    instance: 'router-test',
    hostName: 'local',
    bundle: join(dir, 'wtd.mjs'),
    report: (error) => {
      throw error;
    },
    tunnels,
    configRead: () => undefined,
  });
  const sent: MessageOf<'hubToBrowser'>[] = [];
  const opened = router.open({
    send: (data) => {
      if (typeof data === 'string') sent.push(decodeMessage('hubToBrowser', data));
    },
    unsent: () => 0,
  });
  routed.push(opened);
  opened.hello();
  await waitFor(() => sent.some((m) => m.t === 'hosts'), 'the session to start');
  return opened;
};

it('runs print-code on the host for an opening', async () => {
  const opened = await session();
  opened.receive({ t: 'openHub', req: 1, host: 1 });
  await waitFor(() => printRuns().length > 0, 'the print-code run');
  expect(printRuns()).toHaveLength(1);
});

it('runs no print-code for an opening its session closed while the configuration was read', async () => {
  const opened = await session();
  opened.receive({ t: 'openHub', req: 1, host: 1 });
  opened.close();
  await sleep(500);
  expect(printRuns()).toEqual([]);
});
