import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { dial, StderrTail, systemctlProgram } from '../dialer/index.js';
import { makePrivateDirs, UNIT_NAME, writeFileAtomic, type EntryKind, type HostPaths } from '../files/index.js';
import { checkNodePath, desktopEntry, shimScript, systemdUnit } from './formats.js';
import { checkOwned, installRelease, layoutOf, releaseEntries } from './release.js';

export interface LocalInstallation {
  home: string;
  /** This host's files: the unit file and the daemon socket. */
  paths: HostPaths;
  /** The running `wtd.mjs`. */
  bundle: string;
  version: string;
  /** The Node the shim runs, by absolute path. */
  node: string;
  /** Also install, enable and start the daemon's systemd user unit. */
  systemd: boolean;
}

export interface Installed {
  version: string;
  release: string;
  dataDir: string;
}

/** Runs `systemctl --user <args>`; throws naming the command and its last error line when it fails. */
const systemctl = (...args: string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    const command = [systemctlProgram(), '--user', ...args];
    const tail = new StderrTail();
    const fail = (cause: string): void => {
      reject(new Error(`${command.join(' ')} failed: ${cause}`));
    };
    const child = spawn(command[0] ?? 'systemctl', command.slice(1), { stdio: ['ignore', 'ignore', 'pipe'] });
    tail.follow(child.stderr);
    child.once('error', (error) => {
      fail(error.message);
    });
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else fail(tail.reason() ?? `exit status ${String(code ?? signal)}`);
    });
  });

/** Installs the running bundle for this user, with a launcher and optionally the systemd unit. */
export const installLocal = async ({ home, paths, bundle, version, node, systemd }: LocalInstallation): Promise<Installed> => {
  checkNodePath(node);
  const layout = layoutOf(home);
  const others: [string, EntryKind][] = [[layout.launcher, 'file']];
  if (systemd) others.push([paths.unitFile, 'file']);
  await checkOwned(layout, others);
  const entries = await releaseEntries(bundle);
  for (const dir of [layout.versions, layout.bin, dirname(layout.launcher)]) await makePrivateDirs(dir); // NOSONAR(S9382) — a few directories
  const release = await installRelease(layout, version, entries);
  await writeFileAtomic(layout.shim, shimScript(node), 0o700);
  await writeFileAtomic(layout.launcher, desktopEntry({ shim: layout.shim, icon: join(layout.current, 'web', 'icon.svg') }));
  if (systemd) {
    await makePrivateDirs(dirname(paths.unitFile));
    await writeFileAtomic(paths.unitFile, systemdUnit(layout.shim));
    await systemctl('daemon-reload');
    await systemctl('enable', UNIT_NAME);
    (await dial(paths, [layout.shim, 'daemon'])).destroy();
  }
  return { version, release, dataDir: layout.dataDir };
};
