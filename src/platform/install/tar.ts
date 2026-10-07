/** A tar member: a directory when `data` is absent, else a regular file. */
export interface TarEntry {
  /** Relative path with `/` separators. */
  path: string;
  mode: number;
  data?: Uint8Array;
}

const BLOCK = 512;
const MAX_NAME = 100;
const MAX_PREFIX = 155;

const encoder = new TextEncoder();

const isSafe = (path: string): boolean =>
  path !== '' && !path.startsWith('/') && path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');

/** `path` as ustar name and prefix fields; throws naming it when it does not fit. */
const splitName = (path: string): { name: Uint8Array; prefix: Uint8Array } => {
  const whole = encoder.encode(path);
  if (whole.length <= MAX_NAME) return { name: whole, prefix: new Uint8Array() };
  for (let at = path.indexOf('/'); at !== -1; at = path.indexOf('/', at + 1)) {
    const prefix = encoder.encode(path.slice(0, at));
    const name = encoder.encode(path.slice(at + 1));
    if (prefix.length <= MAX_PREFIX && name.length <= MAX_NAME) return { name, prefix };
  }
  throw new Error(`tar: cannot store the name ${path}`);
};

const octal = (value: number, width: number): Uint8Array => encoder.encode(`${value.toString(8).padStart(width - 1, '0')}\0`);

const header = (entry: TarEntry, mtime: number): Uint8Array => {
  if (!isSafe(entry.path)) throw new Error(`tar: unsafe path '${entry.path}'`);
  const directory = entry.data === undefined;
  const { name, prefix } = splitName(directory ? `${entry.path}/` : entry.path);
  const block = new Uint8Array(BLOCK);
  block.set(name, 0);
  block.set(octal(entry.mode & 0o7777, 8), 100);
  block.set(octal(0, 8), 108);
  block.set(octal(0, 8), 116);
  block.set(octal(entry.data?.length ?? 0, 12), 124);
  block.set(octal(mtime, 12), 136);
  block.fill(0x20, 148, 156);
  block[156] = directory ? 0x35 : 0x30;
  block.set(encoder.encode('ustar\x0000'), 257);
  block.set(prefix, 345);
  const sum = block.reduce((total, byte) => total + byte, 0);
  block.set(encoder.encode(`${sum.toString(8).padStart(6, '0')}\0 `), 148);
  return block;
};

/** A ustar archive holding `entries` in order, owned by uid 0 and stamped with the current time. */
export const tarArchive = (entries: readonly TarEntry[]): Uint8Array => {
  const mtime = Math.floor(Date.now() / 1000);
  const parts = entries.map((entry) => ({ header: header(entry, mtime), data: entry.data ?? new Uint8Array() }));
  const size = parts.reduce((total, part) => total + BLOCK + Math.ceil(part.data.length / BLOCK) * BLOCK, 2 * BLOCK);
  const archive = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    archive.set(part.header, at);
    archive.set(part.data, at + BLOCK);
    at += BLOCK + Math.ceil(part.data.length / BLOCK) * BLOCK;
  }
  return archive;
};
