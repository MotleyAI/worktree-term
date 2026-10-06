import type { Page } from '@playwright/test';
import { terminalBox } from './contract.js';

/** Tracks every WebGL context the page creates; installed by an init script. */
export interface WebglProbe {
  /** Highest number of live contexts observed so far. */
  maxLive: number;
  /** Contexts whose canvas is in the document and not lost. */
  live: () => number;
  /** Whether `element` contains a live context's canvas. */
  holds: (element: Element) => boolean;
  /** Loses the first live context inside `element`; false when there is none. */
  lose: (element: Element) => boolean;
}

declare global {
  interface Window {
    __wtdWebgl?: WebglProbe;
  }
}

/** Init script: wraps getContext to record WebGL contexts and samples the live count on every mutation and frame. */
export function installWebglProbe(): void {
  type Gl = WebGLRenderingContext | WebGL2RenderingContext;
  const contexts: { canvas: HTMLCanvasElement; gl: Gl }[] = [];
  const isLive = (entry: { canvas: HTMLCanvasElement; gl: Gl }): boolean => entry.canvas.isConnected && !entry.gl.isContextLost();
  const probe: WebglProbe = {
    maxLive: 0,
    live: () => contexts.filter(isLive).length,
    holds: (element) => contexts.some((entry) => isLive(entry) && element.contains(entry.canvas)),
    lose: (element) => {
      const entry = contexts.find((e) => isLive(e) && element.contains(e.canvas));
      const extension = entry?.gl.getExtension('WEBGL_lose_context');
      if (extension === undefined || extension === null) return false;
      extension.loseContext();
      return true;
    },
  };
  const sample = (): void => {
    probe.maxLive = Math.max(probe.maxLive, probe.live());
  };
  // eslint-disable-next-line @typescript-eslint/unbound-method -- always called with a canvas as `this`
  const original = HTMLCanvasElement.prototype.getContext;
  function getContext(this: HTMLCanvasElement, contextId: string, options?: unknown): RenderingContext | null {
    const context = original.call(this, contextId, options);
    if (
      (context instanceof WebGLRenderingContext || context instanceof WebGL2RenderingContext) &&
      !contexts.some((e) => e.gl === context)
    ) {
      contexts.push({ canvas: this, gl: context });
    }
    sample();
    return context;
  }
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { value: getContext, configurable: true, writable: true });
  Object.defineProperty(window, '__wtdWebgl', { value: probe });
  new MutationObserver(sample).observe(document, { subtree: true, childList: true });
  const frame = (): void => {
    sample();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

export const liveWebgl = (page: Page): Promise<number> => page.evaluate(() => window.__wtdWebgl?.live() ?? 0);

export const maxLiveWebgl = (page: Page): Promise<number> => page.evaluate(() => window.__wtdWebgl?.maxLive ?? 0);

/** Whether the terminal's container holds a live WebGL canvas. */
export const holdsWebgl = (page: Page, host: number, termId: number): Promise<boolean> =>
  page.evaluate(
    (selector) => {
      const box = document.querySelector(selector);
      return box !== null && (window.__wtdWebgl?.holds(box) ?? false);
    },
    terminalBox(host, termId),
  );

/** Loses the terminal's live WebGL context through WEBGL_lose_context. */
export const loseWebgl = async (page: Page, host: number, termId: number): Promise<void> => {
  const lost = await page.evaluate(
    (selector) => {
      const box = document.querySelector(selector);
      return box !== null && (window.__wtdWebgl?.lose(box) ?? false);
    },
    terminalBox(host, termId),
  );
  if (!lost) throw new Error(`terminal ${String(host)}:${String(termId)} has no live WebGL context to lose`);
};

/** The unmasked WebGL renderer string of a fresh context. */
export const webglRenderer = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (gl === null) return 'no WebGL2';
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    return info === null ? String(gl.getParameter(gl.RENDERER)) : String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL));
  });
