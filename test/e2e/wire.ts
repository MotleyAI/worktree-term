import type { Page } from '@playwright/test';
import { decodeMessage, decodeWsData, type DataFrame, type MessageOf } from '../../src/protocol/index.js';

export type BrowserMessage = MessageOf<'browserToHub'>;
export type HubMessage = MessageOf<'hubToBrowser'>;
type BrowserEnvelope = Extract<BrowserMessage, { t: 'host' }>;
type HubEnvelope = Extract<HubMessage, { t: 'host' }>;

/** One WebSocket message as Playwright saw it. */
export type WireFrame = { text: string } | { bytes: Buffer };

/** A received binary message, decoded. */
export interface ReceivedData {
  host: number;
  frame: DataFrame;
}

const toFrame = (payload: string | Buffer): WireFrame => (typeof payload === 'string' ? { text: payload } : { bytes: payload });

/** Records every WebSocket message the page sends and receives; create it before the page navigates. */
export class WireRecorder {
  readonly sent: WireFrame[] = [];
  readonly received: WireFrame[] = [];
  /** WebSockets the page opened. */
  sockets = 0;

  constructor(page: Page) {
    page.on('websocket', (ws) => {
      this.sockets++;
      ws.on('framesent', ({ payload }) => this.sent.push(toFrame(payload)));
      ws.on('framereceived', ({ payload }) => this.received.push(toFrame(payload)));
    });
  }

  /** Index of the next sent frame; pass as `from` to look only at later ones. */
  markSent(): number {
    return this.sent.length;
  }

  markReceived(): number {
    return this.received.length;
  }

  /** Control messages the page sent since `from`, decoded. */
  sentMessages(from = 0): BrowserMessage[] {
    return this.sent.slice(from).flatMap((f) => ('text' in f ? [decodeMessage('browserToHub', f.text)] : []));
  }

  /** Binary messages the page sent since `from`. */
  sentBinary(from = 0): Buffer[] {
    return this.sent.slice(from).flatMap((f) => ('bytes' in f ? [f.bytes] : []));
  }

  /** Daemon requests the page sent to `host` since `from`. */
  sentToHost(host: number, from = 0): BrowserEnvelope['m'][] {
    return this.sentMessages(from).flatMap((m) => (m.t === 'host' && m.host === host ? [m.m] : []));
  }

  /** `attach` requests for the terminal since `from`. */
  attachesSent(host: number, termId: number, from = 0): number {
    return this.sentToHost(host, from).filter((m) => m.t === 'attach' && m.termId === termId).length;
  }

  receivedMessages(from = 0): HubMessage[] {
    return this.received.slice(from).flatMap((f) => ('text' in f ? [decodeMessage('hubToBrowser', f.text)] : []));
  }

  /** Daemon events from `host` received since `from`. */
  receivedFromHost(host: number, from = 0): HubEnvelope['m'][] {
    return this.receivedMessages(from).flatMap((m) => (m.t === 'host' && m.host === host ? [m.m] : []));
  }

  /** Data frames of the terminal received since `from`, in arrival order. */
  dataOf(host: number, termId: number, from = 0): DataFrame[] {
    return this.received
      .slice(from)
      .flatMap((f) => ('bytes' in f ? [decodeWsData(f.bytes)] : []))
      .filter((d) => d.host === host && d.frame.kind !== 'input' && d.frame.termId === termId)
      .map((d) => d.frame);
  }
}
