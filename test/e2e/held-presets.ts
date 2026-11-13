import type { Page } from '@playwright/test';
import { decodeMessage } from '../../src/protocol/index.js';

export interface Session {
  /** Closes both sides of the session. */
  cut: () => void;
  /** Whether the session holds back the hub's messages. */
  holding: () => boolean;
  /** Delivers the held messages in order and passes later ones through. */
  release: () => void;
}

export interface HeldPresets {
  /** WebSocket sessions the page opened. */
  sessions: () => number;
  /** The latest session. */
  current: () => Session;
  /** `createTerm` requests the page sent over every session. */
  creates: () => number;
}

/** Routes the page's WebSockets through the test; every session after the first holds back `presets` and every later hub message. */
export const holdPresets = async (page: Page): Promise<HeldPresets> => {
  let sessions = 0;
  let creates = 0;
  let current: Session | null = null;
  await page.routeWebSocket(
    (url) => url.pathname === '/ws',
    (ws) => {
      sessions++;
      const later = sessions > 1;
      const server = ws.connectToServer();
      let held: (string | Buffer)[] | null = null;
      let released = false;
      current = {
        cut: () => {
          void ws.close();
          void server.close();
        },
        holding: () => held !== null,
        release: () => {
          released = true;
          for (const message of held ?? []) ws.send(message);
          held = null;
        },
      };
      ws.onMessage((message) => {
        if (typeof message === 'string') {
          const m = decodeMessage('browserToHub', message);
          if (m.t === 'host' && m.m.t === 'createTerm') creates++;
        }
        server.send(message);
      });
      server.onMessage((message) => {
        // `presets` precedes `hosts`: holding it and everything after keeps the hub's order.
        if (later && !released && held === null && typeof message === 'string' && decodeMessage('hubToBrowser', message).t === 'presets') {
          held = [];
        }
        if (held === null) ws.send(message);
        else held.push(message);
      });
    },
  );
  return {
    sessions: () => sessions,
    current: () => {
      if (current === null) throw new Error('no WebSocket session');
      return current;
    },
    creates: () => creates,
  };
};
