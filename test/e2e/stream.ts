/** What the page received for one terminal, checked as it arrived. */
export interface StreamResult {
  snapshots: number;
  /** Output frames whose offset did not continue the previous frame. */
  gaps: number;
  detached: number;
  /** Numbered lines seen in order after the start marker. */
  lines: number;
  /** Bytes of those lines. */
  bytes: number;
  /** The end marker followed the last line. */
  done: boolean;
  error: string | null;
}

declare global {
  interface Window {
    __wtdStream?: {
      /** Checks the terminal's output for lines 1..last between `SEQ-START` and `SEQ-END`. */
      watch: (host: number, termId: number, last: number) => void;
      result: (host: number, termId: number) => StreamResult | null;
    };
  }
}

/**
 * Init script: wraps WebSocket to check terminal output inside the page, so large outputs are not
 * copied to the test process frame by frame.
 */
export function installStreamCheck(): void {
  const START = 'SEQ-START\r\n';
  const decoder = new TextDecoder('latin1');
  interface Lines {
    last: number;
    started: boolean;
    carry: string;
  }
  const terms = new Map<string, { result: StreamResult; position: number; lines: Lines | null }>();
  const state = (host: number, termId: number) => {
    const key = `${String(host)}:${String(termId)}`;
    let entry = terms.get(key);
    if (entry === undefined) {
      entry = { result: { snapshots: 0, gaps: 0, detached: 0, lines: 0, bytes: 0, done: false, error: null }, position: 0, lines: null };
      terms.set(key, entry);
    }
    return entry;
  };
  const check = (entry: ReturnType<typeof state>, lines: Lines, data: Uint8Array): void => {
    const result = entry.result;
    if (result.done || result.error !== null) return;
    let text = lines.carry + decoder.decode(data);
    if (!lines.started) {
      const at = text.indexOf(START);
      if (at < 0) {
        lines.carry = text.slice(-START.length);
        return;
      }
      lines.started = true;
      text = text.slice(at + START.length);
    }
    let at = 0;
    for (let end = text.indexOf('\r\n', at); end >= 0; end = text.indexOf('\r\n', at)) {
      const line = text.slice(at, end);
      at = end + 2;
      if (result.lines === lines.last) {
        if (line === 'SEQ-END') result.done = true;
        else result.error = `unexpected line after ${String(lines.last)}: ${line.slice(0, 40)}`;
        return;
      }
      if (line !== String(result.lines + 1)) {
        result.error = `expected ${String(result.lines + 1)}, got ${line.slice(0, 40)}`;
        return;
      }
      result.lines++;
      result.bytes += line.length + 2;
    }
    lines.carry = text.slice(at);
  };
  const binary = (buffer: ArrayBuffer): void => {
    const view = new DataView(buffer);
    const kind = view.getUint8(0);
    if (kind !== 1 && kind !== 2) return;
    const entry = state(view.getUint16(1), view.getUint32(3));
    const offset = Number(view.getBigUint64(7));
    const data = new Uint8Array(buffer, 15);
    if (kind === 2) {
      entry.result.snapshots++;
      entry.position = offset;
      return;
    }
    if (offset !== entry.position) entry.result.gaps++;
    entry.position = offset + data.length;
    if (entry.lines !== null) check(entry, entry.lines, data);
  };
  const text = (message: string): void => {
    const parsed: unknown = JSON.parse(message);
    if (typeof parsed !== 'object' || parsed === null || !('t' in parsed) || parsed.t !== 'host') return;
    if (!('host' in parsed) || typeof parsed.host !== 'number' || !('m' in parsed)) return;
    const m = parsed.m;
    if (typeof m !== 'object' || m === null || !('t' in m) || m.t !== 'detached' || !('termId' in m) || typeof m.termId !== 'number')
      return;
    state(parsed.host, m.termId).result.detached++;
  };
  const Native = window.WebSocket;
  window.WebSocket = class extends Native {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      this.addEventListener('message', (event: MessageEvent) => {
        if (event.data instanceof ArrayBuffer) binary(event.data);
        else if (typeof event.data === 'string') text(event.data);
      });
    }
  };
  window.__wtdStream = {
    watch: (host, termId, last) => {
      state(host, termId).lines = { last, started: false, carry: '' };
    },
    result: (host, termId) => terms.get(`${String(host)}:${String(termId)}`)?.result ?? null,
  };
}
