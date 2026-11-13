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

export interface HeldAdds {
  /** Hub replies to `addPreset` held back so far. */
  held: () => number;
  /** Delivers the held replies and passes later ones through. */
  release: () => void;
}

/** Routes the page's WebSockets through the test, holding back the hub's reply to every `addPreset` until released. */
export const holdAddReplies = async (page: Page): Promise<HeldAdds> => {
  const adds = new Set<number>();
  const held: (string | Buffer)[] = [];
  let release = (): void => undefined;
  await page.routeWebSocket(
    (url) => url.pathname === '/ws',
    (ws) => {
      const server = ws.connectToServer();
      let released = false;
      ws.onMessage((message) => {
        if (typeof message === 'string') {
          const m = decodeMessage('browserToHub', message);
          if (m.t === 'addPreset') adds.add(m.req);
        }
        server.send(message);
      });
      server.onMessage((message) => {
        if (!released && typeof message === 'string') {
          const m = decodeMessage('hubToBrowser', message);
          if (m.t === 'done' && adds.has(m.req)) {
            held.push(message);
            return;
          }
        }
        ws.send(message);
      });
      release = () => {
        released = true;
        for (const message of held.splice(0)) ws.send(message);
      };
    },
  );
  return {
    held: () => held.length,
    release: () => {
      release();
    },
  };
};

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
