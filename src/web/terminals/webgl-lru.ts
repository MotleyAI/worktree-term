/** Most terminals rendering with WebGL at once. */
export const WEBGL_LIMIT = 8;

export interface Disposable {
  dispose: () => void;
}

/** Gives the most recently shown terminals a WebGL addon each, within a budget (design D12). */
export class WebglLru<K, A extends Disposable> {
  /** Every known key, most recently shown first. */
  private order: K[] = [];
  /** Each key's addon; null renders with the DOM renderer. */
  private readonly addons = new Map<K, A | null>();

  constructor(
    private readonly capacity: number,
    private readonly create: (key: K) => A,
  ) {}

  /** `key` is shown: moves it to the front and gives it WebGL if possible; returns its addon or null. */
  show(key: K): A | null {
    this.order = [key, ...this.order.filter((k) => k !== key)];
    const current = this.addons.get(key);
    if (current !== undefined && current !== null) return current;
    const webgl = this.webglKeys();
    if (webgl.length >= this.capacity) {
      const victim = webgl.at(-1);
      if (victim !== undefined) this.drop(victim);
    }
    let addon: A | null;
    try {
      addon = this.create(key);
    } catch {
      addon = null;
    }
    this.addons.set(key, addon);
    return addon;
  }

  /** `addon` of `key` lost its context; ignored unless it is the key's current addon. */
  lost(key: K, addon: A): void {
    if (this.addons.get(key) === addon) this.drop(key);
  }

  /** Forgets `key`, disposing its addon. */
  remove(key: K): void {
    this.drop(key);
    this.addons.delete(key);
    this.order = this.order.filter((k) => k !== key);
  }

  rendererOf(key: K): 'webgl' | 'dom' | null {
    if (!this.addons.has(key)) return null;
    return this.addons.get(key) === null ? 'dom' : 'webgl';
  }

  /** Keys rendering with WebGL, most recently shown first. */
  webglKeys(): K[] {
    return this.order.filter((k) => {
      const addon = this.addons.get(k);
      return addon !== undefined && addon !== null;
    });
  }

  private drop(key: K): void {
    const addon = this.addons.get(key);
    if (addon === undefined || addon === null) return;
    this.addons.set(key, null);
    addon.dispose();
  }
}
