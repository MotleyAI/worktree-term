import { z } from 'zod';
import { ProtocolError } from './errors.js';
import { parseJson, toText } from './json.js';
import { hostName, port, secret } from './values.js';

// The print-code line and both fragments pass between `wtd` installations of any versions: never change their shape.

const MAX_HUBS = 63;

const printCode = z.strictObject({ port, code: secret });

const homeFragment = z
  .strictObject({ code: secret.nullable(), hub: hostName.nullable() })
  .refine((f) => f.code !== null || f.hub !== null, { message: 'needs a code or a hub' });

const remoteFragment = z
  .strictObject({ code: secret, host: hostName, home: port, hubs: z.array(hostName).min(1).max(MAX_HUBS) })
  .refine((f) => new Set(f.hubs).size === f.hubs.length, { message: 'hubs repeat a name', path: ['hubs'] })
  .refine((f) => f.hubs.includes(f.host), { message: 'hubs must name the host', path: ['hubs'] });

export type PrintCode = z.infer<typeof printCode>;
export type HomeFragment = z.infer<typeof homeFragment>;
export type RemoteFragment = z.infer<typeof remoteFragment>;

const parse = <T>(schema: z.ZodType<T>, what: string, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success) throw new ProtocolError(`invalid ${what}: ${z.prettifyError(result.error)}`);
  return result.data;
};

/** Decodes the print-code line from text or UTF-8 bytes holding it and at most trailing whitespace. */
export const decodePrintCode = (data: string | Uint8Array): PrintCode => {
  const text = toText(data).trimEnd();
  if (/^\s/.test(text)) throw new ProtocolError('invalid print-code line: leading text');
  return parse(printCode, 'print-code line', parseJson(text));
};

/** Encodes the print-code line, ending with one newline; refuses values that would not decode. */
export const encodePrintCode = (line: PrintCode): string => `${JSON.stringify(parse(printCode, 'print-code line', line))}\n`;

const decodeComponent = (text: string): string => {
  try {
    return decodeURIComponent(text.replaceAll('+', ' '));
  } catch (error) {
    throw new ProtocolError('invalid fragment: malformed percent-encoding', { cause: error });
  }
};

/** The parameters of form-encoded `text`, each of `keys` at most once and no other. */
const parameters = (text: string, keys: readonly string[]): Map<string, string> => {
  const params = new Map<string, string>();
  for (const part of text.split('&')) {
    const eq = part.indexOf('=');
    if (eq < 0) throw new ProtocolError('invalid fragment: parameter without value');
    const key = decodeComponent(part.slice(0, eq));
    if (!keys.includes(key)) throw new ProtocolError(`invalid fragment: unknown parameter ${JSON.stringify(key)}`);
    if (params.has(key)) throw new ProtocolError(`invalid fragment: repeated parameter ${key}`);
    params.set(key, decodeComponent(part.slice(eq + 1)));
  }
  return params;
};

/** Decodes a home page fragment: `code`, `hub`, or both. */
export const decodeHomeFragment = (text: string): HomeFragment => {
  const params = parameters(text, ['code', 'hub']);
  return parse(homeFragment, 'home fragment', { code: params.get('code') ?? null, hub: params.get('hub') ?? null });
};

/** Encodes a home page fragment; refuses values that would not decode. */
export const encodeHomeFragment = (fragment: HomeFragment): string => {
  const { code, hub } = parse(homeFragment, 'home fragment', fragment);
  return [code === null ? [] : [`code=${code}`], hub === null ? [] : [`hub=${hub}`]].flat().join('&');
};

const decimalPort = (text: string | undefined): number | undefined =>
  text !== undefined && /^[1-9]\d*$/.test(text) ? Number(text) : undefined;

/** Decodes a remote page fragment: `code`, `host`, `home` and `hubs`. */
export const decodeRemoteFragment = (text: string): RemoteFragment => {
  const params = parameters(text, ['code', 'host', 'home', 'hubs']);
  return parse(remoteFragment, 'remote fragment', {
    code: params.get('code'),
    host: params.get('host'),
    home: decimalPort(params.get('home')),
    hubs: params.get('hubs')?.split(','),
  });
};

/** Encodes a remote page fragment; refuses values that would not decode. */
export const encodeRemoteFragment = (fragment: RemoteFragment): string => {
  const { code, host, home, hubs } = parse(remoteFragment, 'remote fragment', fragment);
  return `code=${code}&host=${host}&home=${String(home)}&hubs=${hubs.join(',')}`;
};

const OPENED_URL = /^http:\/\/127\.0\.0\.1:([1-9]\d*)\/#([^]*)$/;

const isOpenedUrl = (url: string): boolean => {
  const match = OPENED_URL.exec(url);
  if (match === null || !port.safeParse(Number(match[1])).success) return false;
  try {
    decodeRemoteFragment(match[2] ?? '');
    return true;
  } catch (error) {
    if (error instanceof ProtocolError) return false;
    throw error;
  }
};

/** A remote hub page on a loopback port, carrying a remote fragment. */
export const openedUrl = z.string().max(8192).refine(isOpenedUrl, { message: 'must be a loopback remote hub page' });
