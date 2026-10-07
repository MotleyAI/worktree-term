import { decodeMessage, FrameKind, PROTOCOL_VERSION, ProtocolError, type Frame, type MessageOf } from '../../protocol/index.js';
import type { DaemonEndpoint, Link } from '../links/index.js';
import { controlFrame } from './restart.js';

type DaemonMessage = MessageOf<'daemonToClient'>;
type ErrorCode = Extract<DaemonMessage, { t: 'error' }>['code'];
type Hello = Extract<MessageOf<'clientToDaemon'>, { t: 'hello' }>;
type Request = Extract<MessageOf<'clientToDaemon'>, { t: 'watchRepo' | 'discoverRepos' }>;

/** The reply to a one-shot request and the daemon's messages before it. */
export interface OneShotReply {
  reply: Exclude<DaemonMessage, { t: 'error' }>;
  before: DaemonMessage[];
}

/** A one-shot request failed with `code`. */
export class OneShotError extends Error {
  override readonly name = 'OneShotError';

  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const REPLY_MS = 30_000;

const decode = (frame: Frame): DaemonMessage | null => {
  if (frame.kind !== FrameKind.control) return null;
  try {
    return decodeMessage('daemonToClient', frame.payload);
  } catch (error) {
    if (error instanceof ProtocolError) return null;
    throw error;
  }
};

/**
 * Sends `request` over a link of the hub's own to `daemon` and resolves with the reply to it,
 * closing the link afterwards; rejects with the daemon's error code, or `host-unavailable`.
 */
export const requestOnce = (daemon: DaemonEndpoint, hello: Hello, request: Request): Promise<OneShotReply> =>
  new Promise((resolve, reject) => {
    const before: DaemonMessage[] = [];
    let greeted = false;
    let settled = false;
    let link: Link | null = null;
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      link?.close();
      action();
    };
    const fail = (code: ErrorCode, message: string): void => {
      settle(() => {
        reject(new OneShotError(code, message));
      });
    };
    const timer = setTimeout(() => {
      fail('internal', `the daemon did not answer within ${String(REPLY_MS / 1000)} s`);
    }, REPLY_MS);
    link = daemon.open({
      frame: (frame) => {
        const message = decode(frame);
        if (!greeted) {
          greeted = true;
          if (message?.t !== 'hello') {
            fail('internal', 'the daemon did not greet');
          } else if (message.protocol === PROTOCOL_VERSION) {
            link?.send(controlFrame(hello));
            link?.send(controlFrame(request));
          } else {
            fail('version-mismatch', `the daemon speaks protocol ${String(message.protocol)}`);
          }
          return;
        }
        if (message === null) return;
        if (!('req' in message) || message.req !== request.req) before.push(message);
        else if (message.t === 'error') fail(message.code, message.message);
        else {
          settle(() => {
            resolve({ reply: message, before });
          });
        }
      },
      ended: (error) => {
        fail('host-unavailable', error?.message ?? 'the link to the daemon ended');
      },
    });
  });
