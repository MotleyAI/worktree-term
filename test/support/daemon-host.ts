import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaemonClient } from './daemon-client.js';
import { REPO_ROOT } from './exec.js';

export const BUNDLE = join(REPO_ROOT, 'dist', 'wtd.mjs');

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type Probed<T> = T | undefined | false;

/** Polls `probe` every 20 ms until it yields a value other than undefined or false. */
export const waitUntil = async <T>(probe: () => Probed<T> | Promise<Probed<T>>, what: string, timeout = 5000): Promise<T> => {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await probe(); // NOSONAR(S9382) — polling loop
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${String(timeout)} ms waiting for ${what}`);
    await sleep(20); // NOSONAR(S9382) — polling loop
  }
};

/** Whether `pid` is a live (not zombie) process. */
export const alive = (pid: number): boolean => {
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
  } catch {
    return false;
  }
};

/** Session id of `pid`. */
export const sessionOf = (pid: number): number => {
  const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
  return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[3]);
};

/** Resident memory of `pid` in bytes. */
export const residentBytes = (pid: number): number => {
  const match = /^VmRSS:\s+(\d+) kB$/m.exec(readFileSync(`/proc/${String(pid)}/status`, 'utf8'));
  if (match?.[1] === undefined) throw new Error(`no VmRSS for ${String(pid)}`);
  return Number(match[1]) * 1024;
};

/** This host's name as it appears in socket and lock file names. */
export const hostFileName = (): string => hostname().replace(/[^A-Za-z0-9._-]/g, '_');

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'wtd test',
  GIT_AUTHOR_EMAIL: 'wtd@test',
  GIT_COMMITTER_NAME: 'wtd test',
  GIT_COMMITTER_EMAIL: 'wtd@test',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
};

/** Runs git in `cwd` and returns its trimmed stdout. */
export const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, env: { ...process.env, ...GIT_ENV }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); // NOSONAR(S4036) — test helper; PATH is the test runner's own

/** Creates a repo with one commit on `main` and returns its real path. */
export const makeRepo = (path: string): string => {
  mkdirSync(path, { recursive: true });
  git(path, 'init', '-q', '-b', 'main');
  git(path, 'commit', '-q', '--allow-empty', '-m', 'init');
  return realpathSync(path);
};

/** Adds a linked worktree on a new branch and returns its real path. */
export const addWorktree = (repo: string, path: string, branch: string): string => {
  git(repo, 'worktree', 'add', '-q', '-b', branch, path);
  return realpathSync(path);
};

/**
 * Registers `count` linked worktrees whose directories do not exist (git lists them as prunable),
 * each path about `pathLength` characters long. Far faster than `git worktree add`.
 */
export const fakeWorktrees = (repo: string, count: number, pathLength = 40): string[] => {
  const head = git(repo, 'rev-parse', 'HEAD');
  const base = join('/nonexistent', 'p'.repeat(Math.max(1, pathLength - 24)));
  const paths: string[] = [];
  for (let i = 0; i < count; i++) {
    const name = `fake${String(i).padStart(5, '0')}`;
    const admin = join(repo, '.git', 'worktrees', name);
    mkdirSync(admin, { recursive: true });
    writeFileSync(join(admin, 'gitdir'), `${join(base, name)}/.git\n`);
    writeFileSync(join(admin, 'HEAD'), `${head}\n`);
    writeFileSync(join(admin, 'commondir'), '../..\n');
    paths.push(join(base, name));
  }
  return paths;
};

export interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** A `wtd` child process with captured output. */
export class WtdProcess {
  stdout = '';
  stderr = '';
  readonly exited: Promise<Exit>;

  constructor(readonly child: ChildProcess) {
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => (this.stderr += chunk));
    this.exited = new Promise((resolve) => {
      child.once('exit', (code, signal) => {
        resolve({ code, signal });
      });
    });
  }

  get pid(): number {
    if (this.child.pid === undefined) throw new Error('wtd did not start');
    return this.child.pid;
  }

  /** Captures stdout as text; not for children whose stdout carries frames. */
  captureStdout(): this {
    this.child.stdout?.setEncoding('utf8');
    this.child.stdout?.on('data', (chunk: string) => (this.stdout += chunk));
    return this;
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    this.child.kill(signal);
  }
}

/** An isolated host: temporary XDG_STATE_HOME and HOME, with daemons and clients cleaned up afterwards. */
export class DaemonHost {
  readonly stateHome: string;
  readonly home: string;
  readonly stateDir: string;
  readonly runDir: string;
  readonly socket: string;
  readonly lock: string;
  readonly statePath: string;
  readonly logPath: string;
  private readonly processes: WtdProcess[] = [];
  private readonly clients: DaemonClient[] = [];

  constructor(readonly dir: string) {
    this.stateHome = join(dir, 's');
    this.home = join(dir, 'h');
    mkdirSync(this.home);
    this.stateDir = join(this.stateHome, 'worktree-term');
    this.runDir = join(this.stateDir, 'run');
    this.socket = join(this.runDir, `${hostFileName()}.sock`);
    this.lock = join(this.runDir, `${hostFileName()}.lock`);
    this.statePath = join(this.stateDir, 'state.json');
    this.logPath = join(this.stateDir, 'daemon.log');
  }

  static create(): DaemonHost {
    return new DaemonHost(realpathSync(mkdtempSync(join(tmpdir(), 'wtd-'))));
  }

  /** Environment for wtd: isolated state and home, bash as the shell. */
  env(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
    const env: Record<string, string | undefined> = {
      PATH: process.env['PATH'],
      HOME: this.home,
      XDG_STATE_HOME: this.stateHome,
      SHELL: '/bin/bash',
      LANG: 'C.UTF-8',
      ...extra,
    };
    return Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined));
  }

  /** Spawns `wtd <args>` with this host's environment. */
  wtd(args: readonly string[], extraEnv: Record<string, string | undefined> = {}): WtdProcess {
    const process_ = new WtdProcess(spawn(process.execPath, [BUNDLE, ...args], { env: this.env(extraEnv), stdio: 'pipe' }));
    this.processes.push(process_);
    return process_;
  }

  /** Starts `wtd daemon` and waits until its socket accepts connections. */
  async start(extraEnv: Record<string, string | undefined> = {}): Promise<WtdProcess> {
    const daemon = this.wtd(['daemon'], extraEnv).captureStdout();
    let exited = false;
    void daemon.exited.then(() => (exited = true));
    await waitUntil(
      () => {
        if (exited) throw new Error(`wtd daemon exited early: ${daemon.stderr}`);
        return canConnect(this.socket);
      },
      'the daemon socket',
      10_000,
    );
    return daemon;
  }

  /** Connects a client and completes the handshake. */
  async client(): Promise<DaemonClient> {
    const client = await this.rawClient();
    await client.handshake();
    return client;
  }

  /** Connects a client without a handshake. */
  async rawClient(): Promise<DaemonClient> {
    const client = await DaemonClient.connect(this.socket);
    this.clients.push(client);
    return client;
  }

  /** Pids of daemons started for this host, whether by the test or by `wtd connect`. */
  daemonPids(): number[] {
    const pids: number[] = [];
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const cmdline = readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0');
        if (cmdline[1] !== BUNDLE || cmdline[2] !== 'daemon') continue;
        const environ = readFileSync(`/proc/${name}/environ`, 'utf8').split('\0');
        if (environ.includes(`XDG_STATE_HOME=${this.stateHome}`) && alive(Number(name))) pids.push(Number(name));
      } catch {
        // The process exited while we looked.
      }
    }
    return pids;
  }

  async cleanup(): Promise<void> {
    for (const client of this.clients) client.close();
    for (const process_ of this.processes) process_.kill('SIGKILL');
    for (const pid of this.daemonPids()) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    await waitUntil(() => this.daemonPids().length === 0, 'daemons to exit').catch(() => undefined);
    // Shells hung up with the daemon may still be writing their history into HOME.
    rmSync(this.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }

  /** Whether the socket file exists. */
  socketExists(): boolean {
    return existsSync(this.socket);
  }
}

/** Resolves true once a connection to `path` succeeds, false if it is refused or missing. */
export const canConnect = (path: string): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = connect(path);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      resolve(false);
    });
  });
