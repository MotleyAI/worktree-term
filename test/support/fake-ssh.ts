import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, join } from 'node:path';
import { DaemonClient, type EventOf } from './daemon-client.js';
import { alive, hostFileName, waitUntil, type DaemonHost, type Exit } from './daemon-host.js';

/** POSIX single-quoted form of `value`. */
export const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

const NODE_NAMES = new Set(['node', 'nodejs', 'npm', 'npx', 'corepack', 'pnpm', 'yarn']);

/**
 * A directory holding a link to every executable on this machine's PATH except Node and its tools,
 * so a remote PATH can offer the usual commands without any Node.
 */
export const pathWithoutNode = (dir: string): string => {
  mkdirSync(dir, { recursive: true });
  const dirs = (process.env['PATH'] ?? '/usr/bin:/bin').split(delimiter).filter((d) => d.startsWith('/') && !d.startsWith(dir));
  for (const source of [...dirs, '/usr/local/bin', '/usr/bin', '/bin']) {
    let names: string[];
    try {
      names = readdirSync(source);
    } catch {
      continue;
    }
    for (const name of names) {
      if (NODE_NAMES.has(name) || existsSync(join(dir, name))) continue;
      const path = join(source, name);
      try {
        if ((statSync(path).mode & 0o111) === 0 || !statSync(path).isFile()) continue;
        symlinkSync(path, join(dir, name));
      } catch {
        // Dangling or unreadable entry.
      }
    }
  }
  return dir;
};

/** A directory whose `node` is this test runner's Node (20 or later). */
export const currentNodeDir = (dir: string): string => {
  mkdirSync(dir, { recursive: true });
  symlinkSync(process.execPath, join(dir, 'node'));
  return dir;
};

/** A directory whose `node` reports version 18 and fails to run anything. */
export const oldNodeDir = (dir: string): string => {
  mkdirSync(dir, { recursive: true });
  const script = `#!/bin/sh
case "$1" in
  --version|-v) echo v18.19.1 ;;
  -p|-e|--print|--eval) case "$2" in *version*) echo 18.19.1 ;; *) echo 'Node 18 cannot run this' >&2; exit 1 ;; esac ;;
  *) echo 'Node 18 cannot run this' >&2; exit 1 ;;
esac
`;
  writeFileSync(join(dir, 'node'), script);
  chmodSync(join(dir, 'node'), 0o755);
  return dir;
};

const SSH_SCRIPT = (dir: string): string => `#!/bin/sh
d=${shellQuote(dir)}
f="$d/calls/$$"
for a in "$@"; do printf '%s\\0' "$a"; done > "$f.tmp" && mv "$f.tmp" "$f"
while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done
if [ "$#" -ne 3 ]; then echo "fake ssh: expected -- <alias> <command>" >&2; exit 255; fi
alias=$2
cmd=$3
h="$d/hosts/$alias"
if [ ! -f "$h" ]; then echo "ssh: Could not resolve hostname $alias: Name or service not known" >&2; exit 255; fi
. "$h"
if [ -n "$R_FAIL_LINE" ]; then printf '%s\\n' "$R_FAIL_LINE" >&2; exit 255; fi
if [ -n "$R_FAIL_BYTES" ]; then head -c "$R_FAIL_BYTES" /dev/zero | tr '\\000' x >&2; exit 255; fi
cd "$R_HOME" || exit 255
exec env -i HOME="$R_HOME" PATH="$R_PATH" SHELL="$R_SHELL" LANG=C.UTF-8 USER="$USER" /bin/sh -c "$cmd"
`;

/** One run of the fake SSH program. */
export interface SshCall {
  pid: number;
  /** Its arguments, without the program. */
  args: string[];
  alias: string;
  /** The remote command, as one argument. */
  command: string;
}

export interface RemoteOptions {
  /** The remote command's PATH; defaults to a PATH without Node. */
  path?: string;
  /** The remote login shell. */
  shell?: string;
}

/** A remote host reached through FakeSsh: its own temporary home, state and daemon. */
export class FakeRemote {
  readonly stateDir: string;
  readonly runDir: string;
  readonly socket: string;
  readonly shim: string;
  readonly dataDir: string;
  private readonly clients: DaemonClient[] = [];

  constructor(
    readonly alias: string,
    readonly home: string,
  ) {
    this.stateDir = join(home, '.local', 'state', 'worktree-term');
    this.runDir = join(this.stateDir, 'run');
    this.socket = join(this.runDir, `${hostFileName()}.sock`);
    this.shim = join(home, '.local', 'bin', 'wtd');
    this.dataDir = join(home, '.local', 'share', 'worktree-term');
  }

  /** Release directory names under `versions/`, sorted. */
  releases(): string[] {
    const versions = join(this.dataDir, 'versions');
    return existsSync(versions)
      ? readdirSync(versions)
          .filter((name) => !name.startsWith('.'))
          .sort()
      : [];
  }

  /** Where `current` points, or null. */
  current(): string | null {
    try {
      return readlinkSync(join(this.dataDir, 'current'));
    } catch {
      return null;
    }
  }

  /** Pids of daemons running with this remote's home. */
  daemonPids(): number[] {
    const pids: number[] = [];
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const cmdline = readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0');
        if (cmdline[2] !== 'daemon') continue;
        const environ = readFileSync(`/proc/${name}/environ`, 'utf8').split('\0');
        if (environ.includes(`HOME=${this.home}`) && alive(Number(name))) pids.push(Number(name));
      } catch {
        // The process exited while we looked.
      }
    }
    return pids;
  }

  /** A client of the remote daemon's socket, after the handshake. */
  async client(): Promise<DaemonClient> {
    return (await this.connect()).client;
  }

  /** The remote daemon's hello to a new connection. */
  async hello(): Promise<EventOf<'hello'>> {
    return (await this.connect()).hello;
  }

  private async connect(): Promise<{ client: DaemonClient; hello: EventOf<'hello'> }> {
    const client = await DaemonClient.connect(this.socket);
    this.clients.push(client);
    return { client, hello: await client.handshake() };
  }

  async cleanup(): Promise<void> {
    for (const client of this.clients) client.close();
    for (const pid of this.daemonPids()) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    await waitUntil(() => this.daemonPids().length === 0, 'remote daemons to exit').catch(() => undefined);
  }
}

/**
 * A stand-in for `ssh`, used as `WTD_SSH`: records its arguments and runs the remote command with
 * `sh -c` in the alias's own home, with a fresh environment, as sshd would.
 */
export class FakeSsh {
  readonly program: string;
  private readonly hostsDir: string;
  private readonly callsDir: string;
  private readonly remotes: FakeRemote[] = [];
  private noNode: string | null = null;

  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    this.hostsDir = join(dir, 'hosts');
    this.callsDir = join(dir, 'calls');
    mkdirSync(this.hostsDir, { recursive: true });
    mkdirSync(this.callsDir, { recursive: true });
    this.program = join(dir, 'ssh');
    writeFileSync(this.program, SSH_SCRIPT(dir));
    chmodSync(this.program, 0o755);
  }

  /** A PATH holding the usual commands but no Node. */
  get pathWithoutNode(): string {
    this.noNode ??= pathWithoutNode(join(this.dir, 'no-node-bin'));
    return this.noNode;
  }

  /** Makes `alias` reachable, with a fresh home under this fake's directory. */
  addHost(alias: string, { path, shell = '/bin/bash' }: RemoteOptions = {}): FakeRemote {
    const home = join(this.dir, 'remotes', alias);
    mkdirSync(home, { recursive: true });
    this.writeHost(alias, { R_HOME: home, R_PATH: path ?? this.pathWithoutNode, R_SHELL: shell });
    const remote = new FakeRemote(alias, home);
    this.remotes.push(remote);
    return remote;
  }

  /** Makes every SSH run for `alias` write `line` to standard error and exit 255. */
  failHost(alias: string, line: string): void {
    this.writeHost(alias, { R_FAIL_LINE: line });
  }

  /** Makes every SSH run for `alias` write `bytes` bytes without a newline to standard error and exit 255. */
  spewHost(alias: string, bytes: number): void {
    this.writeHost(alias, { R_FAIL_BYTES: String(bytes) });
  }

  /** Every run so far, in no particular order. */
  calls(): SshCall[] {
    return readdirSync(this.callsDir)
      .filter((name) => /^\d+$/.test(name))
      .map((name) => {
        const args = readFileSync(join(this.callsDir, name), 'utf8').split('\0').slice(0, -1);
        const dash = args.indexOf('--');
        return { pid: Number(name), args, alias: args[dash + 1] ?? '', command: args[dash + 2] ?? '' };
      });
  }

  /** Pids of runs for `alias` still alive. */
  livePids(alias: string): number[] {
    return this.calls()
      .filter((call) => call.alias === alias && alive(call.pid))
      .map((call) => call.pid);
  }

  async cleanup(): Promise<void> {
    for (const call of this.calls()) {
      try {
        if (alive(call.pid)) process.kill(call.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    await Promise.all(this.remotes.map((remote) => remote.cleanup()));
    rmSync(this.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }

  private writeHost(alias: string, values: Record<string, string>): void {
    const text = Object.entries(values)
      .map(([key, value]) => `${key}=${shellQuote(value)}\n`)
      .join('');
    writeFileSync(join(this.hostsDir, alias), text);
  }
}

/** Runs `wtd install-remote <alias> [args]` on `host` through `ssh`; resolves with its exit and output. */
export const runInstallRemote = async (
  host: DaemonHost,
  ssh: FakeSsh,
  alias: string,
  args: readonly string[] = ['--node', process.execPath],
): Promise<{ exit: Exit; stdout: string; stderr: string }> => {
  const run = host.wtd(['install-remote', alias, ...args], { WTD_SSH: ssh.program }).captureStdout();
  const exit = await run.exited;
  return { exit, stdout: run.stdout, stderr: run.stderr };
};

/** Installs this checkout's bundle on `alias`, failing the test when the installer fails. */
export const installRemote = async (host: DaemonHost, ssh: FakeSsh, alias: string): Promise<void> => {
  const { exit, stderr } = await runInstallRemote(host, ssh, alias);
  if (exit.code !== 0) throw new Error(`wtd install-remote ${alias} failed: ${stderr}`);
};
