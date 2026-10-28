import {
  appendFileSync,
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
import { delimiter, dirname, join } from 'node:path';
import { DaemonClient, type EventOf } from './daemon-client.js';
import { alive, hostFileName, livePidsWhere, waitUntil, type DaemonHost, type Exit } from './daemon-host.js';

const QUOTED_QUOTE = String.raw`'\''`;

/** POSIX single-quoted form of `value`. */
export const shellQuote = (value: string): string => `'${value.replaceAll("'", QUOTED_QUOTE)}'`;

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

const SSH_SCRIPT = (dir: string): string => String.raw`#!/bin/sh
d=${shellQuote(dir)}
f="$d/calls/$$"
for a in "$@"; do printf '%s\0' "$a"; done > "$f.tmp" && mv "$f.tmp" "$f"
fwd=
while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do
  if [ "$1" = "-W" ]; then fwd=$2; shift; fi
  shift
done
if [ -n "$fwd" ]; then
  if [ "$#" -ne 2 ]; then echo "fake ssh: expected -W <host:port> -- <alias>" >&2; exit 255; fi
elif [ "$#" -ne 3 ]; then echo "fake ssh: expected -- <alias> <command>" >&2; exit 255; fi
alias=$2
cmd=$3
h="$d/hosts/$alias"
if [ ! -f "$h" ]; then echo "ssh: Could not resolve hostname $alias: Name or service not known" >&2; exit 255; fi
. "$h"
if [ -n "$R_HANG" ]; then trap '' TERM; exec sleep 600; fi
if [ -n "$R_GATE" ]; then while [ ! -e "$R_GATE" ]; do sleep 0.05; done; fi
if [ -n "$R_LOGIN" ] && [ ! -e "$d/login/open-$alias" ]; then
  # Recorded whole before the banner, which the reader may act on at once.
  date +%s%3N > "$d/login/$$.at.tmp" && mv "$d/login/$$.at.tmp" "$d/login/$$.at"
  printf '%s\n' '# Tailscale SSH requires an additional check.' "# To authenticate, visit: https://login.tailscale.com/a/wtd$$" >&2
  while [ ! -e "$d/login/$$.ok" ]; do
    if [ -e "$d/login/$$.fail" ]; then cat "$d/login/$$.fail" >&2; exit 255; fi
    sleep 0.05
  done
fi
if [ -n "$R_FAIL_LINE" ]; then printf '%s\n' "$R_FAIL_LINE" >&2; exit 255; fi
if [ -n "$R_FAIL_BYTES" ]; then head -c "$R_FAIL_BYTES" /dev/zero | tr '\000' x >&2; exit 255; fi
if [ -n "$R_NOISE_BYTES" ]; then head -c "$R_NOISE_BYTES" /dev/zero | tr '\000' x >&2; fi
if [ -n "$fwd" ]; then
  if [ -n "$R_NO_FORWARD" ]; then echo 'channel 0: open failed: administratively prohibited' >&2; exit 255; fi
  exec ${shellQuote(process.execPath)} "$d/relay.cjs" "$fwd"
fi
cd "$R_HOME" || exit 255
exec env -i HOME="$R_HOME" PATH="$R_PATH" SHELL="$R_SHELL" LANG=C.UTF-8 USER="$USER" /bin/sh -c "$cmd"
`;

/** Relays stdio to the TCP address in argv, as `ssh -W` does; a refused connect fails as OpenSSH reports it. */
const RELAY_SCRIPT = String.raw`const net = require('node:net');
const target = process.argv[2];
const at = target.lastIndexOf(':');
const socket = net.connect(Number(target.slice(at + 1)), target.slice(0, at));
let open = false;
socket.once('connect', () => {
  open = true;
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
});
socket.once('error', () => {
  if (!open) process.stderr.write('channel 0: open failed: connect failed: Connection refused\nstdio forwarding failed\n');
  process.exit(255);
});
socket.once('close', () => process.exit(0));
`;

/** One run of the fake SSH program. */
export interface SshCall {
  pid: number;
  /** Its arguments, without the program. */
  args: string[];
  alias: string;
  /** The remote command, as one argument; empty for a forward. */
  command: string;
  /** The `-W` target of a forward, else null. */
  forward: string | null;
}

export interface RemoteOptions {
  /** The remote command's PATH; defaults to a PATH without Node. */
  path?: string;
  /** The remote login shell. */
  shell?: string;
}

/** The pid of the fake SSH run that wrote the login URL `url`. */
export const loginRun = (url: string): number => {
  const match = /^https:\/\/login\.tailscale\.com\/a\/wtd(\d+)$/.exec(url);
  if (match?.[1] === undefined) throw new Error(`not a fake SSH login URL: ${url}`);
  return Number(match[1]);
};

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

  /** Replaces the remote's `wtd` with a shell script. */
  plantWtd(script: string): void {
    mkdirSync(dirname(this.shim), { recursive: true });
    writeFileSync(this.shim, `#!/bin/sh\n${script}\n`);
    chmodSync(this.shim, 0o755);
  }

  /** Writes the remote hub's `config.json`. */
  writeHubConfig(config: unknown): void {
    const dir = join(this.home, '.config', 'worktree-term');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  }

  /** Pids of daemons running with this remote's home. */
  daemonPids(): number[] {
    return this.pidsOf('daemon');
  }

  /** Pids of hubs running with this remote's home. */
  hubPids(): number[] {
    return this.pidsOf('hub');
  }

  private pidsOf(verb: string): number[] {
    const pids: number[] = [];
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const cmdline = readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0');
        if (cmdline[2] !== verb) continue;
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
    for (const pid of [...this.hubPids(), ...this.daemonPids()]) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    await waitUntil(() => this.hubPids().length === 0 && this.daemonPids().length === 0, 'remote hubs and daemons to exit').catch(
      () => undefined,
    );
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
  private readonly loginDir: string;
  private readonly remotes: FakeRemote[] = [];
  private noNode: string | null = null;

  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    this.hostsDir = join(dir, 'hosts');
    this.callsDir = join(dir, 'calls');
    this.loginDir = join(dir, 'login');
    mkdirSync(this.hostsDir, { recursive: true });
    mkdirSync(this.callsDir, { recursive: true });
    mkdirSync(this.loginDir, { recursive: true });
    this.program = join(dir, 'ssh');
    writeFileSync(join(dir, 'relay.cjs'), RELAY_SCRIPT);
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

  /** Makes every later SSH run for `alias` hang, ignoring SIGTERM and its standard input. */
  hangHost(alias: string): void {
    appendFileSync(join(this.hostsDir, alias), 'R_HANG=1\n');
  }

  /** Makes every later SSH run for `alias` write `bytes` bytes to standard error before running its command. */
  noisyHost(alias: string, bytes: number): void {
    appendFileSync(join(this.hostsDir, alias), `R_NOISE_BYTES=${String(bytes)}\n`);
  }

  /** Holds every later SSH run for `alias` until the returned function is called. */
  holdHost(alias: string): () => void {
    const gate = join(this.dir, `gate-${alias}`);
    appendFileSync(join(this.hostsDir, alias), `R_GATE=${shellQuote(gate)}\n`);
    return () => {
      writeFileSync(gate, '');
    };
  }

  /**
   * Makes every later SSH run for `alias` write Tailscale's check banner, with a login URL naming the run
   * (see `loginRun`), and wait until that run is approved or expired, or `skipLogin` was called before it started.
   */
  loginHost(alias: string): void {
    appendFileSync(join(this.hostsDir, alias), 'R_LOGIN=1\n');
  }

  /** When, in ms since the epoch, the run behind `url` wrote its banner. */
  loginWrittenAt(url: string): number {
    return Number(readFileSync(join(this.loginDir, `${String(loginRun(url))}.at`), 'utf8').trim());
  }

  /** Lets the run behind `url` proceed. */
  approveLogin(url: string): void {
    writeFileSync(join(this.loginDir, `${String(loginRun(url))}.ok`), '');
  }

  /** Makes the run behind `url` write `line` to standard error and exit 255. */
  expireLogin(url: string, line: string): void {
    writeFileSync(join(this.loginDir, `${String(loginRun(url))}.fail`), `${line}\n`);
  }

  /** Lets SSH runs for `alias` that start from now on proceed without a banner. */
  skipLogin(alias: string): void {
    writeFileSync(join(this.loginDir, `open-${alias}`), '');
  }

  /** Every run so far, in no particular order. */
  calls(): SshCall[] {
    return readdirSync(this.callsDir)
      .filter((name) => /^\d+$/.test(name))
      .map((name) => {
        const args = readFileSync(join(this.callsDir, name), 'utf8').split('\0').slice(0, -1);
        const dash = args.indexOf('--');
        const w = args.indexOf('-W');
        const forward = w >= 0 && w < dash ? (args[w + 1] ?? null) : null;
        return { pid: Number(name), args, alias: args[dash + 1] ?? '', command: args[dash + 2] ?? '', forward };
      });
  }

  /** Makes every later forward (`-W`) run for `alias` print OpenSSH's refusal and exit 255; other runs are unaffected. */
  refuseForwards(alias: string): void {
    appendFileSync(join(this.hostsDir, alias), 'R_NO_FORWARD=1\n');
  }

  /** Pids of forward (`-W`) runs for `alias` still alive. */
  forwardPids(alias: string): number[] {
    return this.calls()
      .filter((call) => call.alias === alias && call.forward !== null && alive(call.pid))
      .map((call) => call.pid);
  }

  /** Pids of runs for `alias` still alive. */
  livePids(alias: string): number[] {
    return this.calls()
      .filter((call) => call.alias === alias && alive(call.pid))
      .map((call) => call.pid);
  }

  async cleanup(): Promise<void> {
    this.killRuns();
    await Promise.all(this.remotes.map((remote) => remote.cleanup()));
    // rmSync empties a directory once and then retries only removing it, so a call recorded meanwhile fails it
    // for good: retry the whole removal, killing runs that started since.
    await waitUntil(
      () => {
        this.killRuns();
        try {
          rmSync(this.dir, { recursive: true, force: true });
          return true;
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ENOTEMPTY') return false;
          throw error;
        }
      },
      'the fake SSH directory to go',
      10_000,
    );
  }

  /** Kills every live run, including those that have not recorded their call yet. */
  private killRuns(): void {
    let recorded: number[] = [];
    try {
      recorded = this.calls().map((call) => call.pid);
    } catch {
      // Removed while we read it.
    }
    for (const pid of [...recorded, ...livePidsWhere((cmdline) => cmdline[1] === this.program)]) {
      try {
        if (alive(pid)) process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
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
