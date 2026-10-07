/** The part of `localStorage` the terminal memory uses. */
export interface TerminalStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

/** A running terminal as a confirmation names it. */
export interface RememberedTerminal {
  worktree: string;
  preset: string;
}

/** The running terminals last seen on one daemon instance, and when. */
export interface Recalled {
  at: number;
  terminals: RememberedTerminal[];
}

const PREFIX = 'wtd.terminals.';
const MAX_TERMINALS = 256;

/** The storage key part of a host: `local`, or `remote:<name>`. */
export const hostKey = (host: { remote: boolean; name: string }): string => (host.remote ? `remote:${host.name}` : 'local');

const isTerminal = (value: unknown): value is RememberedTerminal =>
  typeof value === 'object' &&
  value !== null &&
  'worktree' in value &&
  'preset' in value &&
  typeof value.worktree === 'string' &&
  typeof value.preset === 'string';

/** Parses a stored record, or null for anything else. */
const parseRecord = (text: string): (Recalled & { instance: string }) | null => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || !('instance' in value) || !('at' in value) || !('terminals' in value)) return null;
  const { instance, at, terminals } = value;
  if (typeof instance !== 'string' || typeof at !== 'number' || !Array.isArray(terminals) || !terminals.every(isTerminal)) return null;
  return { instance, at, terminals: terminals.slice(0, MAX_TERMINALS) };
};

/** Per host, the running terminals the page last saw on a daemon instance; storage failures lose only the list. */
export class TerminalMemory {
  constructor(private readonly storage: TerminalStorage | null) {}

  remember(host: string, instance: string, terminals: readonly RememberedTerminal[], at: number): void {
    const record = { instance, at, terminals: terminals.slice(0, MAX_TERMINALS) };
    try {
      this.storage?.setItem(PREFIX + host, JSON.stringify(record));
    } catch (error) {
      console.warn('remembering terminals failed', error);
    }
  }

  /** What was remembered for `host` on `instance`, or null. */
  recall(host: string, instance: string | null): Recalled | null {
    if (instance === null || this.storage === null) return null;
    let text: string | null;
    try {
      text = this.storage.getItem(PREFIX + host);
    } catch (error) {
      console.warn('recalling terminals failed', error);
      return null;
    }
    const record = text === null ? null : parseRecord(text);
    return record?.instance === instance ? { at: record.at, terminals: record.terminals } : null;
  }
}
