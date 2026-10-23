import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Socket } from 'node:net';
import type { Readable, Writable } from 'node:stream';
import { LineScanner, sshCommand, sshForwardCommand, StderrTail, stopProcess, tailscaleLoginUrl } from '../../platform/dialer/index.js';
import { decodePrintCode, ProtocolError } from '../../protocol/index.js';

/** The remote command that makes the host's hub serve and prints its port and a one-time code. */
export const PRINT_CODE_COMMAND = '"$HOME/.local/bin/wtd" ui --print-code';

const OPEN_TIMEOUT_MS = 30_000;
const MAX_OUTPUT = 4096;
const KILL_GRACE_MS = 1000;
/** Exit statuses of a `wtd` without `--print-code` (usage error) or without `wtd` (command not found). */
const OUTDATED_STATUSES: ReadonlySet<number> = new Set([2, 127]);

export type HubOpenResult =
  { kind: 'opened'; port: number; code: string } | { kind: 'outdated'; message: string } | { kind: 'failed'; message: string };

export interface HubOpenEvents {
  /** SSH waits for its Tailscale check to be approved at `url`. Once per URL. */
  login: (url: string) => void;
  /** Called once, unless cancelled. */
  done: (result: HubOpenResult) => void;
}

export interface HubOpening {
  /** Kills the SSH process; no event follows. */
  cancel: () => void;
}

type SshProcess = ChildProcessByStdio<null, Readable, Readable>;

const seconds = (ms: number): string => String(ms / 1000);

/** Runs `wtd ui --print-code` on a remote host over SSH. */
export class HubOpener {
  private readonly timeoutMs: number;

  constructor(
    private readonly paths: Parameters<typeof sshCommand>[0],
    readonly alias: string,
    options: { timeoutMs?: number } = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? OPEN_TIMEOUT_MS;
  }

  open(events: HubOpenEvents): HubOpening {
    let ended = false;
    const end = (result: HubOpenResult): void => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      if (child !== null) stopProcess(child, KILL_GRACE_MS);
      events.done(result);
    };
    let child: SshProcess | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
      end({ kind: 'failed', message: `${this.alias} did not answer within ${seconds(this.timeoutMs)} s` });
    }, this.timeoutMs);
    try {
      const [program = 'ssh', ...args] = sshCommand(this.paths, this.alias, PRINT_CODE_COMMAND);
      child = spawn(program, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      this.follow(child, program, events, end, () => {
        clearTimeout(timer);
        timer = undefined;
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setImmediate(() => {
        end({ kind: 'failed', message });
      });
    }
    return {
      cancel: () => {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        if (child !== null) stopProcess(child, KILL_GRACE_MS);
      },
    };
  }

  private follow(
    child: SshProcess,
    program: string,
    events: HubOpenEvents,
    end: (result: HubOpenResult) => void,
    loggingIn: () => void,
  ): void {
    const tail = new StderrTail();
    const lines = new LineScanner();
    const logins = new Set<string>();
    const output: Buffer[] = [];
    let size = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT) {
        end({ kind: 'failed', message: `${this.alias} printed more than ${String(MAX_OUTPUT)} bytes` });
        return;
      }
      output.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      for (const line of lines.push(chunk)) {
        const url = tailscaleLoginUrl(line);
        if (url === null || logins.has(url)) continue;
        logins.add(url);
        loggingIn();
        events.login(url);
      }
    });
    tail.follow(child.stderr, () => {
      end({ kind: 'failed', message: `${this.alias} wrote too much to standard error` });
    });
    child.once('error', (error) => {
      end({ kind: 'failed', message: `cannot run ${program}: ${error.message}` });
    });
    child.once('close', (code, signal) => {
      end(this.result(code, signal, Buffer.concat(output), tail.reason(), program));
    });
  }

  private result(
    code: number | null,
    signal: NodeJS.Signals | null,
    output: Buffer,
    reason: string | null,
    program: string,
  ): HubOpenResult {
    const outdated: HubOpenResult = { kind: 'outdated', message: `wtd on ${this.alias} is missing or too old to serve its hub` };
    if (code !== null && OUTDATED_STATUSES.has(code)) return outdated;
    if (code === 0) {
      try {
        return { kind: 'opened', ...decodePrintCode(output) };
      } catch (error) {
        if (!(error instanceof ProtocolError)) throw error;
        return outdated;
      }
    }
    const status = code === null ? `${program} was killed by ${String(signal)}` : `${program} exited with status ${String(code)}`;
    return { kind: 'failed', message: reason ?? status };
  }
}

/** One tunnelled connection to a remote hub. */
export interface HubForward {
  /** Resolves when both sides ended: null when the local side ended first, else SSH's last standard error line or exit. */
  ended: Promise<string | null>;
  /** Ends both sides. */
  close: () => void;
}

/** Relays `socket` both ways to `127.0.0.1:<remotePort>` on `alias` through its own `ssh -W` process. */
export const forwardToHub = (paths: Parameters<typeof sshCommand>[0], alias: string, remotePort: number, socket: Socket): HubForward => {
  let child: ChildProcessByStdio<Writable, Readable, Readable>;
  let program: string;
  try {
    const [first = 'ssh', ...args] = sshForwardCommand(paths, alias, remotePort);
    program = first;
    child = spawn(program, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (error) {
    socket.destroy();
    return { ended: Promise.resolve(error instanceof Error ? error.message : String(error)), close: () => undefined };
  }
  const tail = new StderrTail();
  let localEnded = false;
  let stopping = false;
  /** Ends SSH's input, then signals it if it is still running a grace period later. */
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    child.stdin.end();
    setTimeout(() => {
      stopProcess(child, KILL_GRACE_MS);
    }, KILL_GRACE_MS).unref();
  };
  const localEnd = (): void => {
    localEnded = true;
    stop();
  };
  socket.on('error', () => {
    socket.destroy();
  });
  socket.once('end', localEnd);
  socket.once('close', localEnd);
  child.stdin.on('error', () => undefined);
  socket.pipe(child.stdin);
  // Ended only once the cause is recorded, so whoever reads the connection's end can ask for it.
  child.stdout.pipe(socket, { end: false });
  const endLocal = (): void => {
    setImmediate(() => {
      socket.end();
      setTimeout(() => socket.destroy(), KILL_GRACE_MS).unref();
    });
  };
  tail.follow(child.stderr, () => {
    stopProcess(child, KILL_GRACE_MS);
  });
  const ended = new Promise<string | null>((resolve) => {
    child.once('error', (error) => {
      resolve(localEnded ? null : `cannot run ${program}: ${error.message}`);
      endLocal();
    });
    child.once('close', (code, signal) => {
      const exit = code === null ? `${program} was killed by ${String(signal)}` : `${program} exited with status ${String(code)}`;
      const failure = code === 0 ? null : exit;
      resolve(localEnded ? null : (tail.reason() ?? failure));
      endLocal();
    });
  });
  return {
    ended,
    close: () => {
      localEnded = true;
      socket.destroy();
      stop();
    },
  };
};
