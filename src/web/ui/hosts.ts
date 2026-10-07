import type { HostEntry } from '../../protocol/index.js';

/** What a host banner's action does. */
export interface HostAction {
  kind: 'restart' | 'reinstall';
  label: string;
}

/** The banner action of `host`: restart an outdated local daemon, reinstall an outdated remote, install on a down remote. */
export const hostAction = (host: Pick<HostEntry, 'remote' | 'status'>): HostAction | null => {
  if (host.status === 'outdated') {
    return host.remote ? { kind: 'reinstall', label: 'Reinstall & restart' } : { kind: 'restart', label: 'Restart daemon' };
  }
  if (host.status === 'down' && host.remote) return { kind: 'reinstall', label: 'Install' };
  return null;
};

/** Whether `host` gets a banner. */
export const hasBanner = (host: Pick<HostEntry, 'status'>): boolean => host.status === 'down' || host.status === 'outdated';

/** Discovered repos the host does not list yet, narrowed to those whose path contains `filter`. */
export const offeredRepos = (discovered: readonly string[], listed: readonly string[], filter: string): string[] =>
  discovered.filter((repo) => !listed.includes(repo) && repo.includes(filter));
