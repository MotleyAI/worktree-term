/** What a page does about the bundle it runs, given the hub's `hello`. */
export type BundleCheck = 'current' | 'reload' | 'outdated';

/** `reloadedFor`: the hub instance the page last reloaded for, if any. */
export const checkBundle = (
  page: { protocol: number; version: string },
  hub: { protocol: number; version: string; instance: string },
  reloadedFor: string | null,
): BundleCheck => {
  if (page.protocol === hub.protocol && page.version === hub.version) return 'current';
  return reloadedFor === hub.instance ? 'outdated' : 'reload';
};
