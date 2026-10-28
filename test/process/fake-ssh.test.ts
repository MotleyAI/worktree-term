import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { alive, waitUntil } from '../support/daemon-host.js';
import { FakeSsh } from '../support/fake-ssh.js';
import { freePort } from '../support/hub-host.js';

it('cleanup removes its directory while runs it cannot see keep recording their calls for a while', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'wtd-fake-ssh-')));
  const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'wtd-fake-ssh-copy-')));
  const ssh = new FakeSsh(dir);
  // Like a hub killed mid-reconnect whose last runs start late: four loops of a copy of the program, whose runs
  // outlive the program's removal, keep recording calls for a second.
  const program = join(elsewhere, 'ssh');
  copyFileSync(ssh.program, program);
  const loop = 'end=$(($(date +%s%3N)+1000)); while [ "$(date +%s%3N)" -lt "$end" ]; do "$0" -- nowhere true 2>/dev/null; done';
  const stopped = Array.from({ length: 4 }, () => {
    const runs = spawn('/bin/sh', ['-c', loop, program], { stdio: 'ignore' });
    return new Promise((resolve) => runs.once('exit', resolve));
  });
  try {
    await waitUntil(() => ssh.calls().length > 0, 'a first run');
    await ssh.cleanup();
    expect(existsSync(dir)).toBe(false);
  } finally {
    await Promise.all(stopped);
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

type Run = ChildProcessByStdio<Writable, Readable, Readable>;

interface Finished {
  code: number | null;
  stdout: string;
  stderr: string;
}

describe('FakeSsh forwards and planted programs', () => {
  let dir: string;
  let ssh: FakeSsh;
  const servers: Server[] = [];

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'wtd-fake-ssh-')));
    ssh = new FakeSsh(join(dir, 'ssh'));
  });

  afterEach(async () => {
    for (const server of servers.splice(0)) server.close();
    await ssh.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  const run = (args: readonly string[]): Run => spawn(ssh.program, [...args], { stdio: ['pipe', 'pipe', 'pipe'] });

  const finished = (child: Run): Promise<Finished> =>
    new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
      child.once('close', (code) => {
        resolve({ code, stdout, stderr });
      });
    });

  const forward = (alias: string, port: number): Run =>
    run(['-o', 'BatchMode=yes', '-o', 'ControlMaster=auto', '-W', `127.0.0.1:${String(port)}`, '--', alias]);

  /** A TCP server on a free port answering each line with `echo:` and the line. */
  const echoServer = async (): Promise<number> => {
    const port = await freePort();
    const server = createServer((socket) => {
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => socket.write(`echo:${chunk}`));
      socket.on('end', () => socket.end());
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    return port;
  };

  it('relays a -W run’s standard input and output to the TCP port, both ways, and exits when its input ends', async () => {
    ssh.addHost('box');
    const port = await echoServer();
    const child = forward('box', port);
    const done = finished(child);
    child.stdin.write('ping\n');
    await waitUntil(() => ssh.forwardPids('box').length === 1, 'the forward to run');
    child.stdin.end();
    expect(await done).toEqual({ code: 0, stdout: 'echo:ping\n', stderr: '' });
  });

  it('records a forward’s target and no command', async () => {
    ssh.addHost('box');
    const port = await echoServer();
    const child = forward('box', port);
    const done = finished(child);
    child.stdin.end();
    await done;
    expect(ssh.calls()).toEqual([expect.objectContaining({ alias: 'box', command: '', forward: `127.0.0.1:${String(port)}` })]);
  });

  it('records no forward for a command run', async () => {
    ssh.addHost('box');
    expect((await finished(run(['-o', 'BatchMode=yes', '--', 'box', 'echo hi']))).stdout).toBe('hi\n');
    expect(ssh.calls().map((c) => ({ command: c.command, forward: c.forward }))).toEqual([{ command: 'echo hi', forward: null }]);
  });

  it('reports a forward to a closed port as OpenSSH does', async () => {
    ssh.addHost('box');
    const result = await finished(forward('box', await freePort()));
    expect(result.code).toBe(255);
    expect(result.stderr).toBe('channel 0: open failed: connect failed: Connection refused\nstdio forwarding failed\n');
  });

  it('refuses forwards for a host after refuseForwards, leaving its command runs alone', async () => {
    ssh.addHost('box');
    ssh.refuseForwards('box');
    const refused = await finished(forward('box', await echoServer()));
    expect(refused).toEqual({ code: 255, stdout: '', stderr: 'channel 0: open failed: administratively prohibited\n' });
    expect(await finished(run(['--', 'box', 'echo hi']))).toEqual({ code: 0, stdout: 'hi\n', stderr: '' });
  });

  it('lists only live forward runs in forwardPids', async () => {
    ssh.addHost('box');
    const port = await echoServer();
    const child = forward('box', port);
    const command = run(['--', 'box', 'sleep 30']);
    await waitUntil(() => ssh.forwardPids('box').length === 1 && ssh.livePids('box').length === 2, 'both runs');
    expect(ssh.forwardPids('box')).toEqual([child.pid]);
    const done = finished(child);
    child.stdin.end();
    await done;
    expect(ssh.forwardPids('box')).toEqual([]);
    command.kill('SIGKILL');
  });

  it('has the banner’s write time recorded by the time the banner can be read', async () => {
    ssh.addHost('box');
    ssh.loginHost('box');
    const startedAt = Date.now();
    const seen = await Promise.all(
      Array.from({ length: 8 }, () => {
        const child = run(['--', 'box', 'true']);
        return new Promise<{ url: string; writtenAt: number; readAt: number }>((resolve) => {
          let stderr = '';
          child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
            stderr += chunk;
            const url = /https:\/\/login\.tailscale\.com\/a\/wtd\d+/.exec(stderr)?.[0];
            if (url === undefined) return;
            let writtenAt = Number.NaN;
            try {
              writtenAt = ssh.loginWrittenAt(url);
            } catch {
              // Not written yet: NaN fails the checks below.
            }
            resolve({ url, writtenAt, readAt: Date.now() });
          });
        });
      }),
    );
    for (const { url, writtenAt, readAt } of seen) {
      expect(writtenAt, url).toBeGreaterThanOrEqual(startedAt);
      expect(writtenAt, url).toBeLessThanOrEqual(readAt);
    }
    for (const { url } of seen) ssh.approveLogin(url);
  });

  it('runs a planted wtd as the remote’s ~/.local/bin/wtd', async () => {
    const remote = ssh.addHost('box');
    remote.plantWtd('echo "planted $*"; exit 2');
    expect(statSync(remote.shim).mode & 0o111).not.toBe(0);
    expect(await finished(run(['--', 'box', '"$HOME/.local/bin/wtd" ui --print-code']))).toEqual({
      code: 2,
      stdout: 'planted ui --print-code\n',
      stderr: '',
    });
  });

  it('writes the remote hub’s configuration under the remote’s home', () => {
    const remote = ssh.addHost('box');
    remote.writeHubConfig({ port: 9000 });
    expect(JSON.parse(readFileSync(join(remote.home, '.config', 'worktree-term', 'config.json'), 'utf8'))).toEqual({ port: 9000 });
  });

  it('kills the remote’s hubs on cleanup', async () => {
    const remote = ssh.addHost('box');
    const script = join(dir, 'idle.cjs');
    writeFileSync(script, 'setInterval(() => {}, 1000);\n');
    // Looks like a hub of the remote: node <script> hub, with the remote's HOME.
    const hub = spawn(process.execPath, [script, 'hub'], {
      env: { HOME: remote.home, PATH: process.env['PATH'] },
      stdio: 'ignore',
    });
    try {
      await waitUntil(() => remote.hubPids().includes(hub.pid ?? 0), 'the remote hub to be seen');
      await remote.cleanup();
      await waitUntil(() => !alive(hub.pid ?? 0), 'the remote hub to die');
      expect(remote.hubPids()).toEqual([]);
    } finally {
      hub.kill('SIGKILL');
    }
  });
});
