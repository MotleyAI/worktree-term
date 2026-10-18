import { decodeHomeFragment, decodeRemoteFragment, encodeHomeFragment, encodeRemoteFragment, ProtocolError } from '../../protocol/index.js';

/** The page's URL fragment: a remote hub page's, a home page's, or none (also for a malformed one). */
export type PageFragment =
  | { kind: 'remote'; code: string; host: string; home: number; hubs: string[] }
  | { kind: 'home'; code: string | null; hub: string | null }
  | { kind: 'none' };

/** What makes a page a remote hub's: its host, its home hub's port and the hubs its menu lists. */
export interface RemotePage {
  host: string;
  home: number;
  hubs: string[];
}

const REMOTE_KEY = 'wtd.remote';
/** Stands in for the one-time code, never kept, when checking kept values against the fragment's rules. */
const PLACEHOLDER_CODE = '0'.repeat(64);

const attempt = <T>(decode: () => T): T | null => {
  try {
    return decode();
  } catch (error) {
    if (error instanceof ProtocolError) return null;
    throw error;
  }
};

/** Reads `location.hash` as a remote fragment, else a home fragment, else none. */
export const readFragment = (hash: string): PageFragment => {
  const text = hash.startsWith('#') ? hash.slice(1) : hash;
  if (text === '') return { kind: 'none' };
  const remote = attempt(() => decodeRemoteFragment(text));
  if (remote !== null) return { kind: 'remote', ...remote };
  const home = attempt(() => decodeHomeFragment(text));
  return home === null ? { kind: 'none' } : { kind: 'home', ...home };
};

const parseKept = (text: string): RemotePage | null => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  if (typeof value !== 'object' || value === null || !('host' in value) || !('home' in value) || !('hubs' in value)) return null;
  const { host, home, hubs } = value;
  if (typeof host !== 'string' || typeof home !== 'number' || !Array.isArray(hubs) || !hubs.every((h) => typeof h === 'string')) {
    return null;
  }
  const page: RemotePage = { host, home, hubs };
  return attempt(() => encodeRemoteFragment({ code: PLACEHOLDER_CODE, ...page })) === null ? null : page;
};

/** Keeps a remote fragment's values in `storage`, replacing earlier ones; gives the page's kept values, null on a home page. */
export const keptRemote = (storage: Pick<Storage, 'getItem' | 'setItem'>, fragment: PageFragment): RemotePage | null => {
  if (fragment.kind === 'remote') {
    const page: RemotePage = { host: fragment.host, home: fragment.home, hubs: fragment.hubs };
    storage.setItem(REMOTE_KEY, JSON.stringify(page));
    return page;
  }
  const kept = storage.getItem(REMOTE_KEY);
  return kept === null ? null : parseKept(kept);
};

/** The page title: `worktree-term`, or `worktree-term — <host>` on a remote hub's page. */
export const pageTitle = (remote: RemotePage | null): string => (remote === null ? 'worktree-term' : `worktree-term — ${remote.host}`);

/** The home hub's page on `home`, asking it to open `hub`'s hub when given. */
export const homePageUrl = (home: number, hub: string | null): string => {
  const fragment = hub === null ? '' : `#${encodeHomeFragment({ code: null, hub })}`;
  return `http://127.0.0.1:${String(home)}/${fragment}`;
};
