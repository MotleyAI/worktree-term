import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal, type ITerminalOptions } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type { DataFrame } from '../../protocol/index.js';
import { RequestError, type DaemonEvent, type HubClient } from '../client/index.js';
import { AckTracker } from './acks.js';
import { WEBGL_LIMIT, WebglLru } from './webgl-lru.js';

/** Read-only inspection hook for end-to-end tests. */
interface WtdInspect {
  screen: (host: number, termId: number) => string | null;
}

declare global {
  interface Window {
    __wtdInspect?: WtdInspect;
  }
}

interface Entry {
  host: number;
  termId: number;
  repo: string;
  term: Terminal;
  container: HTMLDivElement;
  fit: FitAddon;
  acks: AckTracker;
  shown: boolean;
  /** Detached as lagging; attach when next shown with the page visible. */
  needsAttach: boolean;
  /** Output arrived out of order; waiting for the snapshot of a new attach. */
  resyncing: boolean;
}

const SCROLLBACK = 10_000;

const OPTIONS: ITerminalOptions = {
  scrollback: SCROLLBACK,
  allowProposedApi: true,
  fontFamily: 'ui-monospace, "DejaVu Sans Mono", Menlo, Consolas, monospace',
  fontSize: 14,
  cursorBlink: false,
};

/** Keeps `manager`'s layer over `element` as it moves or resizes; returns a function that stops and hides the layer. */
export const followArea = (manager: TerminalManager, element: HTMLElement): (() => void) => {
  const place = (): void => {
    manager.place(element.getBoundingClientRect());
  };
  const observer = new ResizeObserver(place);
  observer.observe(element);
  window.addEventListener('resize', place);
  place();
  return () => {
    observer.disconnect();
    window.removeEventListener('resize', place);
    manager.place(null);
  };
};

const keyOf = (host: number, termId: number): string => `${String(host)}:${String(termId)}`;

/** Opens link `uri` in a new window that has no access to this page. */
const openLink = (_event: MouseEvent, uri: string): void => {
  window.open(uri, '_blank', 'noopener,noreferrer');
};

/** One xterm.js terminal per daemon terminal, kept outside Preact and never re-created while its PTY lives (design D11, D12). */
export class TerminalManager {
  private readonly layer = document.createElement('div');
  private readonly entries = new Map<string, Entry>();
  private readonly lru = new WebglLru<string, WebglAddon>(WEBGL_LIMIT, (key) => this.createWebgl(key));
  private shown: Entry[] = [];
  /** Hosts whose daemons were told of shown terminals. */
  private readonly visibleHosts = new Set<number>();
  private probe: { term: Terminal; fit: FitAddon } | null = null;

  constructor(private readonly client: HubClient) {
    this.layer.className = 'wtd-terminals';
    document.body.append(this.layer);
    client.onData((host, frame) => {
      this.data(host, frame);
    });
    client.onEvent((host, m) => {
      this.event(host, m);
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') for (const entry of this.shown) this.attachIfNeeded(entry);
    });
    window.__wtdInspect = { screen: (host, termId) => this.screen(host, termId) };
  }

  /** Places the terminal layer over `rect`, refitting the shown terminals. */
  place(rect: { left: number; top: number; width: number; height: number } | null): void {
    const style = this.layer.style;
    style.display = rect === null ? 'none' : '';
    if (rect === null) return;
    style.left = `${String(rect.left)}px`;
    style.top = `${String(rect.top)}px`;
    style.width = `${String(rect.width)}px`;
    style.height = `${String(rect.height)}px`;
    for (const entry of this.shown) this.fit(entry);
  }

  /** The size in cells a terminal filling the layer has. */
  areaSize(): { cols: number; rows: number } {
    if (this.probe === null) {
      const container = document.createElement('div');
      container.className = 'wtd-terminal wtd-probe';
      this.layer.append(container);
      const term = new Terminal(OPTIONS);
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(container);
      this.probe = { term, fit };
    }
    const size = this.probe.fit.proposeDimensions();
    return size === undefined || !(size.cols > 0 && size.rows > 0) ? { cols: 80, rows: 24 } : { cols: size.cols, rows: size.rows };
  }

  has(host: number, termId: number): boolean {
    return this.entries.has(keyOf(host, termId));
  }

  /** Terminals of `repo` with a terminal object. */
  attachedOf(host: number, repo: string): number[] {
    return [...this.entries.values()].filter((e) => e.host === host && e.repo === repo).map((e) => e.termId);
  }

  /** Creates the terminal object of `termId` and attaches it. */
  open(host: number, termId: number, repo: string, size: { cols: number; rows: number }): void {
    const key = keyOf(host, termId);
    if (this.entries.has(key)) return;
    const container = document.createElement('div');
    container.className = 'wtd-terminal';
    container.dataset['testid'] = 'terminal';
    container.dataset['host'] = String(host);
    container.dataset['term'] = String(termId);
    container.style.visibility = 'hidden';
    this.layer.append(container);
    const term = new Terminal({ ...OPTIONS, cols: size.cols, rows: size.rows });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon(openLink));
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = '11';
    term.open(container);
    container.style.display = 'none';
    container.style.visibility = '';
    term.onData((data) => {
      this.client.input(host, termId, data);
    });
    term.onBinary((data) => {
      this.client.input(
        host,
        termId,
        Uint8Array.from(data, (c) => (c.codePointAt(0) ?? 0) & 0xff),
      );
    });
    const acks = new AckTracker((offset) => {
      this.client.notify(host, { t: 'ack', termId, offset });
    });
    const entry: Entry = { host, termId, repo, term, container, fit, acks, shown: false, needsAttach: false, resyncing: false };
    this.entries.set(key, entry);
    this.attach(host, termId);
  }

  attach(host: number, termId: number): void {
    const entry = this.entries.get(keyOf(host, termId));
    if (entry === undefined) return;
    entry.needsAttach = false;
    this.client.request(host, { t: 'attach', termId }).catch((error: unknown) => {
      // A terminal closed meanwhile is dropped on its termClosed.
      if (error instanceof RequestError && error.code === 'unknown-term') return;
      console.warn(`attaching terminal ${keyOf(host, termId)} failed`, error);
    });
  }

  /** Shows exactly `termIds` of `host` (none for null), hiding the others; fits them and tells the daemons. */
  show(host: number | null, termIds: readonly number[]): void {
    const next = host === null ? [] : termIds.flatMap((id) => this.entries.get(keyOf(host, id)) ?? []);
    for (const entry of this.shown) {
      if (next.includes(entry)) continue;
      entry.shown = false;
      entry.container.style.display = 'none';
    }
    for (const entry of next) {
      entry.shown = true;
      entry.container.style.display = '';
      this.lru.show(keyOf(entry.host, entry.termId));
      this.fit(entry);
      this.attachIfNeeded(entry);
    }
    this.shown = next;
    if (host !== null) this.visibleHosts.add(host);
    for (const h of this.visibleHosts) {
      this.client.notify(h, { t: 'setVisible', termIds: next.filter((e) => e.host === h).map((e) => e.termId) });
    }
    if (host !== null) next[0]?.term.focus();
  }

  /** Disposes the terminal `termId` of `host`, if the page has it. */
  disposeTerm(host: number, termId: number): void {
    const entry = this.entries.get(keyOf(host, termId));
    if (entry !== undefined) this.dispose(entry);
  }

  /** Disposes every terminal of `host`. */
  disposeHost(host: number): void {
    for (const entry of this.entries.values()) if (entry.host === host) this.dispose(entry);
  }

  private dispose(entry: Entry): void {
    const key = keyOf(entry.host, entry.termId);
    this.entries.delete(key);
    this.lru.remove(key);
    this.shown = this.shown.filter((e) => e !== entry);
    entry.term.dispose();
    entry.container.remove();
  }

  private attachIfNeeded(entry: Entry): void {
    if (entry.needsAttach && entry.shown && document.visibilityState === 'visible') this.attach(entry.host, entry.termId);
  }

  private fit(entry: Entry): void {
    const { cols, rows } = entry.term;
    const size = entry.fit.proposeDimensions();
    if (size === undefined || !(size.cols > 0 && size.rows > 0) || (size.cols === cols && size.rows === rows)) return;
    entry.term.resize(size.cols, size.rows);
    this.client.notify(entry.host, { t: 'resize', termId: entry.termId, cols: size.cols, rows: size.rows });
  }

  private createWebgl(key: string): WebglAddon {
    const entry = this.entries.get(key);
    if (entry === undefined) throw new Error(`no terminal ${key}`);
    const addon = new WebglAddon();
    try {
      entry.term.loadAddon(addon);
    } catch (error) {
      addon.dispose();
      throw error;
    }
    addon.onContextLoss(() => {
      this.lru.lost(key, addon);
    });
    return addon;
  }

  private data(host: number, frame: DataFrame): void {
    if (frame.kind === 'input') return;
    const entry = this.entries.get(keyOf(host, frame.termId));
    if (entry === undefined) return;
    if (frame.kind === 'snapshot') {
      entry.resyncing = false;
      entry.acks.attach(frame.offset);
      entry.term.reset();
      entry.term.write(frame.data);
      return;
    }
    if (entry.resyncing) return;
    const pending = entry.acks.output(frame.offset, frame.data);
    if (pending === null) {
      entry.resyncing = true;
      this.attach(host, frame.termId);
      return;
    }
    entry.term.write(frame.data, () => {
      entry.acks.written(pending);
    });
  }

  private event(host: number, m: DaemonEvent): void {
    const entry = 'termId' in m ? this.entries.get(keyOf(host, m.termId)) : undefined;
    if (entry === undefined) return;
    if (m.t === 'termClosed') this.dispose(entry);
    else if (m.t === 'detached') {
      entry.needsAttach = true;
      this.attachIfNeeded(entry);
    }
  }

  private screen(host: number, termId: number): string | null {
    const entry = this.entries.get(keyOf(host, termId));
    if (entry === undefined) return null;
    const buffer = entry.term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
    return lines.join('\n').trimEnd();
  }
}
