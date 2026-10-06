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

/** A rectangle in pixels, relative to the terminal layer when it places a terminal. */
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A terminal to show, and where in the layer. */
export interface ShownPane {
  termId: number;
  box: Box;
}

/** Decides for a key event in a terminal whether xterm.js handles it; false consumes it. */
export type TerminalKeyFilter = (event: KeyboardEvent) => boolean;

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
/** Horizontal and vertical padding of a terminal container, as in the stylesheet. */
const PAD_X = 4;
const PAD_Y = 2;

const OPTIONS: ITerminalOptions = {
  scrollback: SCROLLBACK,
  allowProposedApi: true,
  fontFamily: 'ui-monospace, "DejaVu Sans Mono", Menlo, Consolas, monospace',
  fontSize: 14,
  cursorBlink: false,
};

/**
 * Keeps `manager`'s layer over `element` as it moves or resizes, telling `placed` its size; returns a
 * function that stops and hides the layer.
 */
export const followArea = (manager: TerminalManager, element: HTMLElement, placed?: (rect: DOMRect) => void): (() => void) => {
  const place = (): void => {
    const rect = element.getBoundingClientRect();
    manager.place(rect);
    placed?.(rect);
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

/** Calls `fn` just after the next frame is painted. */
const afterPaint = (fn: () => void): void => {
  requestAnimationFrame(() => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      fn();
    };
    channel.port2.postMessage(null);
  });
};

const px = (n: number): string => `${String(n)}px`;

/** Sizes `container` so that, with its padding, it fills `box`. */
const fill = (container: HTMLElement, box: Box): void => {
  const style = container.style;
  style.left = px(box.left);
  style.top = px(box.top);
  style.width = px(Math.max(0, box.width - 2 * PAD_X));
  style.height = px(Math.max(0, box.height - 2 * PAD_Y));
};

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
  /** The terminal ids last sent with `setVisible`, by host. */
  private readonly told = new Map<number, string>();
  private probe: { container: HTMLDivElement; term: Terminal; fit: FitAddon } | null = null;
  private keyFilter: TerminalKeyFilter = () => true;
  private readonly focusListeners = new Set<(host: number, termId: number) => void>();
  private unloaded = false;
  /** Shown terminals waiting for a WebGL addon, given one per frame after the frame that shows them. */
  private readonly upgrades = new Set<Entry>();
  private upgrading = false;
  private fitting = false;

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
      this.syncVisible();
      if (document.visibilityState === 'visible') for (const entry of this.shown) this.attachIfNeeded(entry);
    });
    window.addEventListener('pagehide', () => {
      this.unloaded = true;
      this.syncVisible();
    });
    window.addEventListener('pageshow', () => {
      this.unloaded = false;
      this.syncVisible();
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
    this.fitAll(this.shown);
  }

  /** The size in cells a terminal filling `box` has. */
  sizeFor(box: Box): { cols: number; rows: number } {
    if (this.probe === null) {
      const container = document.createElement('div');
      container.className = 'wtd-terminal wtd-probe';
      this.layer.append(container);
      const term = new Terminal(OPTIONS);
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(container);
      this.probe = { container, term, fit };
    }
    fill(this.probe.container, box);
    const size = this.probe.fit.proposeDimensions();
    return size === undefined || !(size.cols > 0 && size.rows > 0) ? { cols: 80, rows: 24 } : { cols: size.cols, rows: size.rows };
  }

  /** Installs the filter every terminal consults for its key events. */
  setKeyFilter(filter: TerminalKeyFilter): void {
    this.keyFilter = filter;
  }

  /** Called whenever a terminal receives the keyboard focus. */
  onFocus(listener: (host: number, termId: number) => void): void {
    this.focusListeners.add(listener);
  }

  /** Whether `node` lies in the terminal layer. */
  owns(node: Node | null): boolean {
    return node !== null && this.layer.contains(node);
  }

  focus(host: number, termId: number): void {
    this.entries.get(keyOf(host, termId))?.term.focus();
  }

  /** The terminal's selected text; empty without a selection. */
  selection(host: number, termId: number): string {
    return this.entries.get(keyOf(host, termId))?.term.getSelection() ?? '';
  }

  /** Types `text` into the terminal as pasted text. */
  paste(host: number, termId: number, text: string): void {
    this.entries.get(keyOf(host, termId))?.term.paste(text);
  }

  /** Host `host` was restored after a reconnect: tells it again which of its terminals are shown. */
  restored(host: number): void {
    this.told.delete(host);
    this.syncVisible();
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
    term.attachCustomKeyEventHandler((event) => this.keyFilter(event));
    container.style.display = 'none';
    container.style.visibility = '';
    container.addEventListener('focusin', () => {
      for (const listener of this.focusListeners) listener(host, termId);
    });
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

  /**
   * Shows exactly `panes` of `host` (none for null), each over its box, hiding the others; fits them
   * and tells the daemons. With `fitLater` the terminals fit in the frame after the one showing the
   * boxes, as while a divider is dragged.
   */
  show(host: number | null, panes: readonly ShownPane[], fitLater = false): void {
    const next = host === null ? [] : panes.flatMap(({ termId, box }) => this.placed(host, termId, box));
    for (const entry of this.shown) {
      if (next.includes(entry)) continue;
      entry.shown = false;
      entry.container.style.display = 'none';
    }
    for (const entry of next) {
      if (!entry.shown) {
        entry.shown = true;
        entry.container.style.display = '';
      }
      const key = keyOf(entry.host, entry.termId);
      // Starting WebGL takes a frame or more per terminal, so a switch first paints with the DOM renderer.
      if (this.lru.rendererOf(key) === 'webgl') this.lru.show(key);
      else {
        this.lru.touch(key);
        this.upgrades.add(entry);
      }
      this.attachIfNeeded(entry);
    }
    this.shown = next;
    if (fitLater) this.fitLater();
    else this.fitAll(next);
    this.syncVisible();
    this.upgradeLater();
  }

  private fitLater(): void {
    if (this.fitting) return;
    this.fitting = true;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        this.fitting = false;
        this.fitAll(this.shown);
      });
    });
  }

  private upgradeLater(): void {
    if (this.upgrading || this.upgrades.size === 0) return;
    this.upgrading = true;
    afterPaint(() => {
      this.upgrading = false;
      const [entry] = this.upgrades;
      if (entry === undefined) return;
      this.upgrades.delete(entry);
      if (entry.shown && this.entries.get(keyOf(entry.host, entry.termId)) === entry) {
        this.lru.show(keyOf(entry.host, entry.termId));
        this.fit(entry);
      }
      this.upgradeLater();
    });
  }

  /** The entry of `termId`, its container moved over `box`; none without a terminal object. */
  private placed(host: number, termId: number, box: Box): Entry[] {
    const entry = this.entries.get(keyOf(host, termId));
    if (entry === undefined) return [];
    fill(entry.container, box);
    return [entry];
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
    this.upgrades.delete(entry);
    entry.term.dispose();
    entry.container.remove();
  }

  /** Tells each host the terminals of it the page shows, none while the page is hidden; only changes are sent. */
  private syncVisible(): void {
    const visible = document.visibilityState === 'visible' && !this.unloaded;
    const hosts = new Set([...this.told.keys(), ...this.shown.map((e) => e.host)]);
    for (const host of hosts) {
      const termIds = visible ? this.shown.filter((e) => e.host === host).map((e) => e.termId) : [];
      const key = termIds.join(',');
      if (this.told.get(host) === key) continue;
      this.told.set(host, key);
      this.client.notify(host, { t: 'setVisible', termIds });
    }
  }

  private attachIfNeeded(entry: Entry): void {
    if (entry.needsAttach && entry.shown && document.visibilityState === 'visible') this.attach(entry.host, entry.termId);
  }

  private fit(entry: Entry): void {
    this.fitAll([entry]);
  }

  /** Fits `entries` to their containers: every size is read before any terminal resizes, so layout runs once. */
  private fitAll(entries: readonly Entry[]): void {
    const sizes = entries.map((entry) => ({ entry, size: entry.fit.proposeDimensions() }));
    for (const { entry, size } of sizes) {
      const { cols, rows } = entry.term;
      if (size === undefined || !(size.cols > 0 && size.rows > 0) || (size.cols === cols && size.rows === rows)) continue;
      entry.term.resize(size.cols, size.rows);
      this.client.notify(entry.host, { t: 'resize', termId: entry.termId, cols: size.cols, rows: size.rows });
    }
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
