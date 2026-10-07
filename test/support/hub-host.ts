import { randomInt } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeCodeResponse } from '../../src/protocol/index.js';
import { alive, DaemonHost, waitUntil, type WtdProcess } from './daemon-host.js';
import { HubClient } from './hub-client.js';

/** The hub record `run/hub.json`. */
export interface HubRecord {
  pid: number;
  port: number;
  instance: string;
}

/** One invocation of the stub browser. */
export interface BrowserCall {
  args: string[];
  /** Where the stub's stdout pointed. */
  stdout: string;
  /** Session id of the stub process. */
  sid: number;
}

export interface RawResponse {
  status: number;
  /** Header values by lower-cased name, in arrival order. */
  headers: Map<string, string[]>;
  body: string;
}

export type HeaderList = readonly (readonly [string, string])[];

export interface HttpOptions {
  /** Headers sent in order, duplicates allowed; `Host` is added unless `host` is null. */
  headers?: HeaderList;
  /** The `Host` header value; null sends none. Defaults to the hub's own. */
  host?: string | null;
  body?: string;
  /** Resolve once the response headers arrived (for upgrades that switch protocols). */
  headersOnly?: boolean;
}

const canBind = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => {
      resolve(false);
    });
    server.listen(port, '127.0.0.1', () => {
      server.close(() => {
        resolve(true);
      });
    });
  });

const PORT_SLICES = 32;
const SLICE_SIZE = 375;

/** This test worker's slice of ports, so up to 32 concurrent workers never pick the same one. */
const sliceStart = (): number => {
  const worker = Number(process.env['TEST_PARALLEL_INDEX'] ?? process.env['VITEST_POOL_ID'] ?? 0);
  return 20_000 + (worker % PORT_SLICES) * SLICE_SIZE;
};

/** A free TCP port on 127.0.0.1, below the ephemeral range so outgoing connections never take it meanwhile. */
export const freePort = async (): Promise<number> => {
  const start = sliceStart();
  for (let attempt = 0; attempt < 100; attempt++) {
    const port = randomInt(start, start + SLICE_SIZE);
    if (await canBind(port)) return port; // NOSONAR(S9382) — retries until a port is free
  }
  throw new Error('no free port');
};

const HTTP_TIMEOUT_MS = 10_000;

const decodeChunked = (body: string): string => {
  let out = '';
  let at = 0;
  for (;;) {
    const lineEnd = body.indexOf('\r\n', at);
    if (lineEnd < 0) return out;
    const size = Number.parseInt(body.slice(at, lineEnd), 16);
    if (Number.isNaN(size) || size <= 0) return out;
    out += body.slice(lineEnd + 2, lineEnd + 2 + size);
    at = lineEnd + 2 + size + 2;
  }
};

const parseResponse = (text: string): RawResponse => {
  const split = text.indexOf('\r\n\r\n');
  const head = split < 0 ? text : text.slice(0, split);
  const rest = split < 0 ? '' : text.slice(split + 4);
  const [statusLine = '', ...lines] = head.split('\r\n');
  const status = Number(statusLine.split(' ')[1]);
  const headers = new Map<string, string[]>();
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    headers.set(name, [...(headers.get(name) ?? []), line.slice(colon + 1).trim()]);
  }
  const chunked = headers.get('transfer-encoding')?.includes('chunked') ?? false;
  return { status, headers, body: chunked ? decodeChunked(rest) : rest };
};

/** Sends one raw HTTP/1.1 request to 127.0.0.1:`port` and parses the response. */
export const rawHttp = (port: number, method: string, path: string, options: HttpOptions = {}): Promise<RawResponse> =>
  new Promise((resolve, reject) => {
    const host = options.host === undefined ? `127.0.0.1:${String(port)}` : options.host;
    const headers: (readonly [string, string])[] = [];
    if (host !== null) headers.push(['Host', host]);
    headers.push(...(options.headers ?? []));
    if (options.body !== undefined) headers.push(['Content-Length', String(Buffer.byteLength(options.body))]);
    if (options.headersOnly !== true) headers.push(['Connection', 'close']);
    const head = headers.map(([k, v]) => `${k}: ${v}\r\n`).join('');
    const request = `${method} ${path} HTTP/1.1\r\n${head}\r\n${options.body ?? ''}`;
    const socket = connect(port, '127.0.0.1');
    let text = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`no complete response to ${method} ${path} within ${String(HTTP_TIMEOUT_MS)} ms`));
    }, HTTP_TIMEOUT_MS);
    const finish = (): void => {
      clearTimeout(timer);
      resolve(parseResponse(text));
    };
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      text += chunk;
      if (options.headersOnly === true && text.includes('\r\n\r\n')) {
        socket.destroy();
        finish();
      }
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once('end', finish);
    socket.once('close', () => {
      clearTimeout(timer);
      if (text === '') reject(new Error('connection closed without a response'));
      else resolve(parseResponse(text));
    });
    socket.write(request);
  });

/** Headers of a WebSocket upgrade offering `protocols`, without Host and Origin. */
export const upgradeHeaders = (protocols: readonly string[] | null): [string, string][] => {
  const headers: [string, string][] = [
    ['Upgrade', 'websocket'],
    ['Connection', 'Upgrade'],
    ['Sec-WebSocket-Version', '13'],
    ['Sec-WebSocket-Key', 'dGhlIHNhbXBsZSBub25jZQ=='],
  ];
  if (protocols !== null) headers.push(['Sec-WebSocket-Protocol', protocols.join(', ')]);
  return headers;
};

const BROWSER_STUB = (log: string): string => String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const stat = fs.readFileSync('/proc/self/stat', 'utf8');
const sid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[3]);
let stdout = '';
try { stdout = fs.readlinkSync('/proc/self/fd/1'); } catch { stdout = 'closed'; }
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), stdout, sid }) + '\n');
`;

/** An isolated host for hub tests: DaemonHost plus XDG_CONFIG_HOME, a free port and a stub browser. */
export class HubHost extends DaemonHost {
  readonly configHome: string;
  readonly configDir: string;
  readonly configPath: string;
  readonly tokenPath: string;
  readonly recordPath: string;
  readonly hubLockPath: string;
  readonly hubLogPath: string;
  readonly stubDir: string;
  /** Executable recording each invocation to `browserLog`; `WTD_BROWSER` points at it. */
  readonly browserStub: string;
  readonly browserLog: string;

  constructor(
    dir: string,
    readonly port: number,
  ) {
    super(dir);
    this.configHome = join(dir, 'c');
    this.configDir = join(this.configHome, 'worktree-term');
    this.configPath = join(this.configDir, 'config.json');
    this.tokenPath = join(this.stateDir, 'hub-token');
    this.recordPath = join(this.runDir, 'hub.json');
    this.hubLockPath = join(this.runDir, 'hub.lock');
    this.hubLogPath = join(this.stateDir, 'hub.log');
    this.stubDir = join(dir, 'bin');
    mkdirSync(this.stubDir);
    this.browserLog = join(dir, 'browser.log');
    this.browserStub = this.writeStub('browser');
    this.writeConfig({ port });
  }

  /** A host on a free port with `config.json` = `{port}`. */
  static async createHub(): Promise<HubHost> {
    return new HubHost(realpathSync(mkdtempSync(join(tmpdir(), 'wtd-hub-'))), await freePort());
  }

  get origin(): string {
    return `http://127.0.0.1:${String(this.port)}`;
  }

  get wsUrl(): string {
    return `ws://127.0.0.1:${String(this.port)}/ws`;
  }

  /** Writes a browser stub named `name` into `stubDir` and returns its path. */
  writeStub(name: string): string {
    const path = join(this.stubDir, name);
    writeFileSync(path, BROWSER_STUB(this.browserLog));
    chmodSync(path, 0o755);
    return path;
  }

  /** `WTD_SSH` for every process of this host; null leaves it unset. */
  sshProgram: string | null = null;

  override env(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
    const ssh = this.sshProgram === null ? {} : { WTD_SSH: this.sshProgram };
    return super.env({ XDG_CONFIG_HOME: this.configHome, WTD_BROWSER: this.browserStub, ...ssh, ...extra });
  }

  /** Writes `config.json` as the JSON of `config`. */
  writeConfig(config: unknown): void {
    mkdirSync(this.configDir, { recursive: true });
    writeFileSync(this.configPath, JSON.stringify(config));
  }

  /** Presets `writeRepos` puts into `config.json`; null leaves the key out. */
  presets: readonly { name: string; command: string | null }[] | null = null;

  /** Writes `config.json` with this host's port, `repos` and `presets`. */
  writeRepos(repos: readonly string[]): void {
    this.writeConfig(this.presets === null ? { port: this.port, repos } : { port: this.port, repos, presets: this.presets });
  }

  /** Starts `wtd hub` in the foreground and waits until it serves. */
  async startHub(extraEnv: Record<string, string | undefined> = {}): Promise<WtdProcess> {
    const hub = this.wtd(['hub'], extraEnv).captureStdout();
    let exited = false;
    void hub.exited.then(() => (exited = true));
    await waitUntil(
      async () => {
        if (exited) throw new Error(`wtd hub exited early: ${hub.stderr}`);
        return this.serving();
      },
      'the hub to serve',
      10_000,
    );
    return hub;
  }

  /** Whether a hub answers an authenticated identity request on the port. */
  async serving(): Promise<boolean> {
    if (!existsSync(this.tokenPath)) return false;
    try {
      return (await this.api('GET', '/api/identity')).status === 200;
    } catch {
      return false;
    }
  }

  token(): string {
    return readFileSync(this.tokenPath, 'utf8').trim();
  }

  record(): HubRecord | null {
    if (!existsSync(this.recordPath)) return null;
    const value: unknown = JSON.parse(readFileSync(this.recordPath, 'utf8'));
    if (typeof value !== 'object' || value === null || !('pid' in value) || !('port' in value) || !('instance' in value)) {
      throw new Error(`malformed hub record ${JSON.stringify(value)}`);
    }
    const { pid, port, instance } = value;
    if (typeof pid !== 'number' || typeof port !== 'number' || typeof instance !== 'string') throw new Error('malformed hub record');
    return { pid, port, instance };
  }

  /** A raw HTTP request to the hub's port. */
  http(method: string, path: string, options: HttpOptions = {}): Promise<RawResponse> {
    return rawHttp(this.port, method, path, options);
  }

  /** An API request; `token` defaults to the hub token (null sends no Authorization), `origin` to none. */
  api(
    method: string,
    path: string,
    { token, origin = null, body }: { token?: string | null; origin?: string | null; body?: string } = {},
  ): Promise<RawResponse> {
    const bearer = token === undefined ? this.token() : token;
    const headers: [string, string][] = [];
    if (bearer !== null) headers.push(['Authorization', `Bearer ${bearer}`]);
    if (origin !== null) headers.push(['Origin', origin]);
    return this.http(method, path, body === undefined ? { headers } : { headers, body });
  }

  async identity(): Promise<{ version: string; instance: string }> {
    const response = await this.api('GET', '/api/identity');
    if (response.status !== 200) throw new Error(`identity failed with ${String(response.status)}`);
    const value: unknown = JSON.parse(response.body);
    if (typeof value !== 'object' || value === null || !('version' in value) || !('instance' in value)) throw new Error('bad identity');
    const { version, instance } = value;
    if (typeof version !== 'string' || typeof instance !== 'string') throw new Error('bad identity');
    return { version, instance };
  }

  /** A fresh one-time code. */
  async code(): Promise<string> {
    const response = await this.api('POST', '/api/code');
    if (response.status !== 200) throw new Error(`code request failed with ${String(response.status)}`);
    return decodeCodeResponse(response.body).code;
  }

  /** The URL `wtd ui` would open, with a fresh code. */
  async pageUrl(): Promise<string> {
    return `${this.origin}/#code=${await this.code()}`;
  }

  /** Opens a WebSocket offering `protocols` with the hub's Origin unless overridden. */
  open(protocols: readonly string[], origin: string | null = this.origin): Promise<HubClient> {
    return HubClient.open(this.wsUrl, { protocols, origin });
  }

  /** A raw upgrade request; resolves with the hub's response status line and headers. */
  upgrade(
    protocols: readonly string[] | null,
    { origin = this.origin, host }: { origin?: string | null; host?: string | null } = {},
  ): Promise<RawResponse> {
    const headers = upgradeHeaders(protocols);
    if (origin !== null) headers.push(['Origin', origin]);
    return this.http('GET', '/ws', host === undefined ? { headers, headersOnly: true } : { headers, host, headersOnly: true });
  }

  /** A token-authenticated session after the handshake. */
  async session(): Promise<HubClient> {
    const client = await this.open(['wtd', `wtd.token.${this.token()}`]);
    await client.handshake();
    return client;
  }

  browserCalls(): BrowserCall[] {
    if (!existsSync(this.browserLog)) return [];
    return readFileSync(this.browserLog, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line): BrowserCall => {
        const value: unknown = JSON.parse(line);
        if (typeof value !== 'object' || value === null || !('args' in value) || !('stdout' in value) || !('sid' in value)) {
          throw new Error(`bad browser call ${line}`);
        }
        const { args, stdout, sid } = value;
        if (!Array.isArray(args) || typeof stdout !== 'string' || typeof sid !== 'number') throw new Error(`bad browser call ${line}`);
        return { args: args.map(String), stdout, sid };
      });
  }

  /** Pids of `wtd hub` processes of this host, foreground or detached. */
  hubPids(): number[] {
    const pids: number[] = [];
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const cmdline = readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0');
        if (cmdline[2] !== 'hub') continue;
        const environ = readFileSync(`/proc/${name}/environ`, 'utf8').split('\0');
        if (environ.includes(`XDG_STATE_HOME=${this.stateHome}`) && alive(Number(name))) pids.push(Number(name));
      } catch {
        // The process exited while we looked.
      }
    }
    return pids;
  }

  override async cleanup(): Promise<void> {
    for (const pid of this.hubPids()) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    await waitUntil(() => this.hubPids().length === 0, 'hubs to exit').catch(() => undefined);
    await super.cleanup();
  }
}
