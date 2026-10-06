import { readTree } from '../../platform/files/index.js';

/** A bundle file as served. */
export interface StaticFile {
  body: Uint8Array;
  contentType: string;
  cacheControl: string;
}

export interface StaticFiles {
  /** The file served at the raw request path `path`, or null. */
  lookup: (path: string) => StaticFile | null;
}

const INDEX = 'index.html';
const NO_CACHE = 'no-cache';
const IMMUTABLE = 'public, max-age=31536000, immutable';

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json',
  map: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
  ico: 'image/x-icon',
  woff2: 'font/woff2',
  wasm: 'application/wasm',
  txt: 'text/plain; charset=utf-8',
};

const contentTypeOf = (path: string): string => CONTENT_TYPES[path.slice(path.lastIndexOf('.') + 1)] ?? 'application/octet-stream';

/** Reads the web bundle in `dir` once; fails naming `dir` when it or its index.html is missing. */
export const loadStaticFiles = async (dir: string): Promise<StaticFiles> => {
  let tree;
  try {
    tree = await readTree(dir);
  } catch (error) {
    throw new Error(`cannot read the web bundle ${dir}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const files = new Map<string, StaticFile>(
    tree.map(({ path, data }) => [
      `/${path}`,
      { body: data, contentType: contentTypeOf(path), cacheControl: path === INDEX ? NO_CACHE : IMMUTABLE },
    ]),
  );
  const index = files.get(`/${INDEX}`);
  if (index === undefined) throw new Error(`the web bundle ${dir} has no ${INDEX}`);
  files.set('/', index);
  return { lookup: (path) => files.get(path) ?? null };
};
