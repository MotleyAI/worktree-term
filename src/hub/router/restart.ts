import {
  decodeMessage,
  encodeFrame,
  encodeMessage,
  FrameKind,
  PROTOCOL_VERSION,
  ProtocolError,
  type Frame,
  type MessageOf,
} from '../../protocol/index.js';
import type { DaemonEndpoint, Link } from '../links/index.js';

type Hello = Extract<MessageOf<'daemonToClient'>, { t: 'hello' }>;

const RESTART_MS = 10_000;
const POLL_MS = 100;

const encoder = new TextEncoder();

/** A stream control frame carrying `message`. */
export const controlFrame = (message: MessageOf<'clientToDaemon'>): Uint8Array =>
  encodeFrame({ kind: FrameKind.control, payload: encoder.encode(encodeMessage('clientToDaemon', message)) });

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The daemon's hello carried by `frame`, or null. */
const helloOf = (frame: Frame): Hello | null => {
  if (frame.kind !== FrameKind.control) return null;
  try {
    const message = decodeMessage('daemonToClient', frame.payload);
    return message.t === 'hello' ? message : null;
  } catch (error) {
    if (error instanceof ProtocolError) return null;
    throw error;
  }
};

/** Whether to send a daemon answering a probe `shutdown`. */
type ShutdownIf = (hello: Hello) => boolean;

const always: ShutdownIf = () => true;
const never: ShutdownIf = () => false;

/** Replaces the daemon of one host; only the frozen `hello` of a daemon being replaced is decoded. */
export class DaemonRestarter {
  constructor(
    private readonly daemon: DaemonEndpoint,
    /** Our hello to a daemon. */
    private readonly hello: Extract<MessageOf<'clientToDaemon'>, { t: 'hello' }>,
  ) {}

  /** Resolves once a new daemon instance of our protocol serves; rejects after 10 s. */
  async restart(): Promise<void> {
    const deadline = Date.now() + RESTART_MS;
    const old = await this.probe({ start: false, shutdown: always }, deadline);
    if (old !== null) {
      for (;;) {
        const current = await this.probe({ start: false, shutdown: never }, deadline); // NOSONAR(S9382) — polls until the old daemon is gone
        if (current?.instance !== old.instance) break;
        if (Date.now() >= deadline) throw new Error('the daemon did not exit within 10 s');
        await sleep(POLL_MS); // NOSONAR(S9382) — polling loop
      }
    }
    for (;;) {
      const fresh = await this.probe({ start: true, shutdown: never }, deadline); // NOSONAR(S9382) — polls until a new daemon serves
      if (fresh !== null && fresh.instance !== old?.instance && fresh.protocol === PROTOCOL_VERSION) return;
      if (Date.now() >= deadline) throw new Error('no new daemon served within 10 s');
      await sleep(POLL_MS); // NOSONAR(S9382) — polling loop
    }
  }

  /** Dials until a daemon of `version` and our protocol answers, shutting down any other; rejects after 10 s. */
  async replaceOther(version: string): Promise<void> {
    const deadline = Date.now() + RESTART_MS;
    const other: ShutdownIf = (hello) => hello.version !== version || hello.protocol !== PROTOCOL_VERSION;
    for (;;) {
      const hello = await this.probe({ start: true, shutdown: other }, deadline); // NOSONAR(S9382) — polls until the new daemon serves
      if (hello !== null && !other(hello)) return;
      if (Date.now() >= deadline) throw new Error(`no daemon of version ${version} served within 10 s`);
      await sleep(POLL_MS); // NOSONAR(S9382) — polling loop
    }
  }

  /** The hello of the daemon answering (sending it `shutdown` if asked), or null when none answers in time. */
  private probe({ start, shutdown }: { start: boolean; shutdown: ShutdownIf }, deadline: number): Promise<Hello | null> {
    return new Promise((resolve) => {
      let link: Link | null = null;
      const done = (hello: Hello | null): void => {
        clearTimeout(timer);
        link?.close();
        resolve(hello);
      };
      const timer = setTimeout(
        () => {
          done(null);
        },
        Math.max(0, deadline - Date.now()),
      );
      link = this.daemon.open(
        {
          frame: (frame) => {
            const hello = helloOf(frame);
            if (hello !== null && shutdown(hello)) {
              link?.send(controlFrame(this.hello));
              link?.send(controlFrame({ t: 'shutdown' }));
            }
            done(hello);
          },
          ended: () => {
            done(null);
          },
        },
        { start },
      );
    });
  }
}
