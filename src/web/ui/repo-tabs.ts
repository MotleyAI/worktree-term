/** One repo tab. */
export interface RepoTab {
  host: number;
  repo: string;
  label: string;
}

const segmentsOf = (path: string): string[] => path.split('/').filter((s) => s !== '');

const suffix = (segments: readonly string[], length: number): string => segments.slice(-length).join('/');

/** Labels `repos` by their shortest trailing path that no other repo of the list shares. */
const uniqueLabels = (repos: readonly string[]): string[] => {
  const all = repos.map(segmentsOf);
  return all.map((segments, i) => {
    for (let length = 1; length < segments.length; length++) {
      const label = suffix(segments, length);
      if (all.every((other, j) => j === i || suffix(other, length) !== label)) return label;
    }
    return segments.join('/');
  });
};

/** The repo tabs of every host in hub order; a remote host's labels are prefixed with its name. */
export const repoTabs = (hosts: readonly { idx: number; name: string; remote: boolean; repos: readonly string[] }[]): RepoTab[] =>
  hosts.flatMap((host) => {
    const labels = uniqueLabels(host.repos);
    const prefix = host.remote ? `${host.name}:` : '';
    return host.repos.map((repo, i) => ({ host: host.idx, repo, label: prefix + (labels[i] ?? repo) }));
  });
