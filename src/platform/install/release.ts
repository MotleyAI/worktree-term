import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { ownedEntry, pathExists, readTree, type EntryKind } from '../files/index.js';
import type { TarEntry } from './tar.js';

const PTY_PACKAGE = 'node_modules/@homebridge/node-pty-prebuilt-multiarch';
const PTY_FILES = ['package.json', 'LICENSE'];
const PTY_TREES = ['lib', 'prebuilds'];
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** Where an installation in `home` puts its files. */
export interface Layout {
  dataDir: string;
  versions: string;
  current: string;
  bin: string;
  shim: string;
  launcher: string;
}

export const layoutOf = (home: string): Layout => {
  const dataDir = join(home, '.local', 'share', 'worktree-term');
  return {
    dataDir,
    versions: join(dataDir, 'versions'),
    current: join(dataDir, 'current'),
    bin: join(home, '.local', 'bin'),
    shim: join(home, '.local', 'bin', 'wtd'),
    launcher: join(home, '.local', 'share', 'applications', 'worktree-term.desktop'),
  };
};

/** A release directory name: the version and 12 random lowercase hex digits. */
export const releaseName = (version: string): string => `${version}-${randomBytes(6).toString('hex')}`;

/** Releases to delete once `fresh` is current: all but it and `previous`, never one still being assembled. */
export const releasesToRemove = (names: readonly string[], fresh: string, previous: string | null): string[] =>
  names.filter((name) => !name.startsWith('.') && name !== fresh && name !== previous);

/** The PTY package directory the bundle at `bundle` resolves, searching `node_modules` upwards. */
const ptyPackageOf = async (bundle: string): Promise<string> => {
  for (let dir = dirname(bundle); ; dir = dirname(dir)) {
    const candidate = join(dir, PTY_PACKAGE);
    if (await pathExists(join(candidate, 'package.json'))) return candidate; // NOSONAR(S9382) — nearest node_modules wins, as Node resolves
    if (dirname(dir) === dir) throw new Error(`cannot find ${PTY_PACKAGE} for ${bundle}`);
  }
};

const directoriesOf = (files: readonly string[]): string[] => {
  const dirs = new Set<string>();
  for (const file of files) {
    for (let dir = dirname(file); dir !== '.'; dir = dirname(dir)) dirs.add(dir);
  }
  return [...dirs].sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : 1));
};

/** The release of the running bundle: `wtd.mjs`, `web/` beside it and the PTY package's runtime files. */
export const releaseEntries = async (bundle: string): Promise<TarEntry[]> => {
  const pty = await ptyPackageOf(bundle);
  const files: { path: string; data: Uint8Array }[] = [{ path: 'wtd.mjs', data: await readFile(bundle) }];
  for (const file of await readTree(join(dirname(bundle), 'web'))) files.push({ path: `web/${file.path}`, data: file.data });
  for (const name of PTY_FILES) files.push({ path: `${PTY_PACKAGE}/${name}`, data: await readFile(join(pty, name)) }); // NOSONAR(S9382) — a few small files
  for (const tree of PTY_TREES) {
    for (const file of await readTree(join(pty, tree))) files.push({ path: `${PTY_PACKAGE}/${tree}/${file.path}`, data: file.data }); // NOSONAR(S9382) — two trees
  }
  const dirs = directoriesOf(files.map((f) => f.path)).map((path): TarEntry => ({ path, mode: DIR_MODE }));
  return [...dirs, ...files.map((f): TarEntry => ({ path: f.path, mode: FILE_MODE, data: f.data }))];
};

/** Throws naming the first path the installation owns that is of the wrong type or another user's. */
export const checkOwned = async (layout: Layout, others: readonly (readonly [string, EntryKind])[]): Promise<void> => {
  const checks: (readonly [string, EntryKind])[] = [
    [layout.dataDir, 'directory'],
    [layout.versions, 'directory'],
    [layout.current, 'symlink'],
    [layout.shim, 'file'],
    ...others,
  ];
  for (const [path, kind] of checks) await ownedEntry(path, kind); // NOSONAR(S9382) — the first failure is reported
  if (!(await pathExists(layout.versions))) return;
  for (const name of await readdir(layout.versions)) await ownedEntry(join(layout.versions, name), 'directory'); // NOSONAR(S9382) — the first failure is reported
};

const hex = (): string => randomBytes(6).toString('hex');

/** The release `current` points to, or null. */
const currentRelease = async (layout: Layout): Promise<string | null> => {
  try {
    return basename(await readlink(layout.current));
  } catch {
    return null;
  }
};

/** Writes `entries` as a new release of `version`, points `current` to it and prunes old releases; returns its name. */
export const installRelease = async (layout: Layout, version: string, entries: readonly TarEntry[]): Promise<string> => {
  const name = releaseName(version);
  const staging = join(layout.versions, `.${name}`);
  try {
    await mkdir(staging, { mode: DIR_MODE });
    for (const entry of entries) {
      const path = join(staging, entry.path);
      const writing =
        entry.data === undefined ? mkdir(path, { mode: DIR_MODE }) : writeFile(path, entry.data, { mode: entry.mode & 0o700, flag: 'wx' });
      await writing; // NOSONAR(S9382) — parents before children
    }
    await rename(staging, join(layout.versions, name));
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  const previous = await currentRelease(layout);
  const link = join(layout.dataDir, `.current-${hex()}`);
  await symlink(join('versions', name), link);
  try {
    await rename(link, layout.current);
  } catch (error) {
    await rm(link, { force: true });
    throw error;
  }
  for (const old of releasesToRemove(await readdir(layout.versions), name, previous)) {
    await rm(join(layout.versions, old), { recursive: true, force: true }); // NOSONAR(S9382) — few releases
  }
  return name;
};
