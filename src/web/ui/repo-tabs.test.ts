import { describe, expect, it } from 'vitest';
import { repoTabs } from './repo-tabs.js';

const host = (idx: number, name: string, remote: boolean, repos: string[]) => ({ idx, name, remote, repos });

describe('repoTabs', () => {
  it('labels repos by directory name in the hub’s order', () => {
    expect(repoTabs([host(0, 'box', false, ['/src/web', '/src/api'])])).toEqual([
      { host: 0, repo: '/src/web', label: 'web' },
      { host: 0, repo: '/src/api', label: 'api' },
    ]);
  });

  it('adds leading path segments until labels are unique', () => {
    expect(repoTabs([host(0, 'box', false, ['/a/x/app', '/b/y/app', '/c/lib'])]).map((t) => t.label)).toEqual(['x/app', 'y/app', 'lib']);
  });

  it('adds as many segments as uniqueness needs', () => {
    expect(repoTabs([host(0, 'box', false, ['/a/x/app', '/b/x/app'])]).map((t) => t.label)).toEqual(['a/x/app', 'b/x/app']);
  });

  it('prefixes repos of a remote host with its name', () => {
    expect(repoTabs([host(0, 'box', false, ['/src/app']), host(1, 'devbox', true, ['/src/app'])])).toEqual([
      { host: 0, repo: '/src/app', label: 'app' },
      { host: 1, repo: '/src/app', label: 'devbox:app' },
    ]);
  });

  it('makes labels unique within each host only', () => {
    const tabs = repoTabs([host(0, 'box', false, ['/a/app']), host(1, 'devbox', true, ['/b/app', '/c/app'])]);
    expect(tabs.map((t) => t.label)).toEqual(['app', 'devbox:b/app', 'devbox:c/app']);
  });

  it('lists no tabs for hosts without repos', () => {
    expect(repoTabs([host(0, 'box', false, [])])).toEqual([]);
  });
});
