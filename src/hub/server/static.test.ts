import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadStaticFiles } from './static.js';

const NO_CACHE = 'no-cache';
const IMMUTABLE = 'public, max-age=31536000, immutable';

const matching = (pattern: RegExp): unknown => expect.stringMatching(pattern);

let root: string;
let bundle: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wtd-static-'));
  bundle = join(root, 'web');
  mkdirSync(join(bundle, 'assets'), { recursive: true });
  writeFileSync(join(bundle, 'index.html'), '<!doctype html>');
  writeFileSync(join(bundle, 'assets', 'index-abc123.js'), 'export {};');
  writeFileSync(join(bundle, 'assets', 'index-abc123.css'), 'body{}');
  writeFileSync(join(root, 'package.json'), '{}');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('loadStaticFiles', () => {
  it.each(['/', '/index.html'])('serves index.html at %s uncached', async (path) => {
    const files = await loadStaticFiles(bundle);
    expect(files.lookup(path)).toMatchObject({ cacheControl: NO_CACHE, contentType: matching(/^text\/html/) });
  });

  it('serves bundle assets as immutable with their content types', async () => {
    const files = await loadStaticFiles(bundle);
    expect(files.lookup('/assets/index-abc123.js')).toMatchObject({
      cacheControl: IMMUTABLE,
      contentType: matching(/^text\/javascript/),
    });
    expect(files.lookup('/assets/index-abc123.css')).toMatchObject({ cacheControl: IMMUTABLE, contentType: matching(/^text\/css/) });
  });

  it.each([
    '/missing.js',
    '/assets/',
    '/assets',
    '/../package.json',
    '/%2e%2e/package.json',
    '/%2E%2E/package.json',
    '/assets/../index.html',
    '/assets/%2e%2e/index.html',
    '/assets%2findex-abc123.js',
    '//index.html',
    'index.html',
    '/index.html/',
  ])('serves nothing at %s', async (path) => {
    const files = await loadStaticFiles(bundle);
    expect(files.lookup(path)).toBeNull();
  });

  it('serves only the files present at load', async () => {
    const files = await loadStaticFiles(bundle);
    writeFileSync(join(bundle, 'assets', 'late.js'), 'export {};');
    expect(files.lookup('/assets/late.js')).toBeNull();
  });

  it('fails for a missing bundle directory, naming it', async () => {
    rmSync(bundle, { recursive: true });
    await expect(loadStaticFiles(bundle)).rejects.toThrow(bundle);
  });

  it('fails for a bundle without index.html', async () => {
    rmSync(join(bundle, 'index.html'));
    await expect(loadStaticFiles(bundle)).rejects.toThrow(bundle);
  });
});
