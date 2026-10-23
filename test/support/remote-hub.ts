import { join } from 'node:path';
import { makeRepo, type DaemonHost } from './daemon-host.js';
import { currentNodeDir, installRemote, type FakeRemote, type FakeSsh } from './fake-ssh.js';
import { freePort } from './hub-host.js';

/** A fake remote with this checkout's `wtd` installed and a hub configuration of its own. */
export interface RemoteHub {
  remote: FakeRemote;
  /** The port the remote hub's configuration names. */
  port: number;
  /** A repo the remote hub's configuration lists. */
  repo: string;
}

/** Makes `alias` reachable with this runner's Node, installs this checkout there and configures its hub on a free port not in `avoid`. */
export const remoteHub = async (host: DaemonHost, ssh: FakeSsh, alias: string, avoid: readonly number[] = []): Promise<RemoteHub> => {
  const nodeDir = currentNodeDir(join(ssh.dir, `node-${alias}`));
  const remote = ssh.addHost(alias, { path: `${nodeDir}:${ssh.pathWithoutNode}` });
  await installRemote(host, ssh, alias);
  let port = await freePort();
  while (avoid.includes(port)) port = await freePort(); // NOSONAR(S9382) — retries until a port outside `avoid` is free
  const repo = makeRepo(join(remote.home, 'repo'));
  remote.writeHubConfig({ port, repos: [repo] });
  return { remote, port, repo };
};
