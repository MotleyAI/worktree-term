import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { REPO_ROOT } from '../support/exec.js';

const TEXT = new Set(['.js', '.mjs', '.css', '.html']);

const replaceAll = (text: string, from: string, to: string): { text: string; count: number } => {
  const parts = text.split(from);
  return { text: parts.join(to), count: parts.length - 1 };
};

/**
 * Copies `dist/` into a directory inside the repo (so its externals resolve), renames every web asset
 * and rewrites the references, and replaces the package version literal with `version`; with `web`
 * false only the hub's version changes, so the hub serves a bundle older than itself.
 */
export const skewedDist = (from: string, version: string, { web = true }: { web?: boolean } = {}): string => {
  mkdirSync(join(REPO_ROOT, 'build'), { recursive: true });
  const dir = mkdtempSync(join(REPO_ROOT, 'build', 'e2e-skew-'));
  try {
    cpSync(join(REPO_ROOT, 'dist'), dir, { recursive: true });
    if (web) rewriteWeb(dir, from, version);
    rewriteHub(dir, from, version);
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return dir;
};

const rewriteWeb = (dir: string, from: string, version: string): void => {
  const web = join(dir, 'web');
  const assets = join(web, 'assets');
  const names = readdirSync(assets);
  for (const name of names) renameSync(join(assets, name), join(assets, `skew-${name}`));
  const textFiles = [join(web, 'index.html'), ...names.filter((n) => TEXT.has(extname(n))).map((n) => join(assets, `skew-${n}`))];
  let webVersions = 0;
  for (const file of textFiles) {
    let text = readFileSync(file, 'utf8');
    for (const name of names) text = replaceAll(text, name, `skew-${name}`).text;
    for (const quote of ['"', "'"]) {
      const replaced = replaceAll(text, `${quote}${from}${quote}`, `${quote}${version}${quote}`);
      text = replaced.text;
      webVersions += replaced.count;
    }
    writeFileSync(file, text);
  }
  if (webVersions === 0) throw new Error(`version ${from} not found in the web bundle`);
};

const rewriteHub = (dir: string, from: string, version: string): void => {
  const bundle = join(dir, 'wtd.mjs');
  let hubVersions = 0;
  let text = readFileSync(bundle, 'utf8');
  for (const quote of ['"', "'"]) {
    const replaced = replaceAll(text, `${quote}${from}${quote}`, `${quote}${version}${quote}`);
    text = replaced.text;
    hubVersions += replaced.count;
  }
  writeFileSync(bundle, text);
  if (hubVersions === 0) throw new Error(`version ${from} not found in the hub bundle`);
};
