import type { ServerResponse } from 'node:http';
import { defineConfig, type Plugin, type ProxyOptions, type UserConfig } from 'vite';
import pkg from './package.json' with { type: 'json' };
import { readHubRecord, readToken, requestCode } from './src/hub/server/index.js';
import { currentHostPaths } from './src/platform/files/index.js';

const LOGIN_PATH = '/login';

/** The dev server's port: `WTD_VITE_PORT`, else 5173. */
const devPort = (): number => Number(process.env['WTD_VITE_PORT'] ?? '5173');

/** The running hub's port and token; `pnpm dev` needs a hub started by `wtd ui` or `wtd hub`. */
const runningHub = async (): Promise<{ port: number; token: string }> => {
  const paths = currentHostPaths();
  const [record, token] = await Promise.all([readHubRecord(paths.hubRecord), readToken(paths.hubToken)]);
  if (record === null || token === null) throw new Error('no hub is running; start one with `node dist/wtd.mjs ui`');
  return { port: record.port, token };
};

/** The dev page's own origin. */
const devOrigin = (): string => `http://127.0.0.1:${String(devPort())}`;

/** Responses the dev server sends may not be framed, so no other site can overlay the signed-in page. */
const NO_FRAMES: Readonly<Record<string, string>> = { 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'" };

/** Proxies `/ws` to the hub with its Host; only the dev page's own Origin becomes the hub's, so other sites stay refused. */
const hubProxy = (port: number): Record<string, ProxyOptions> => {
  const target = `http://127.0.0.1:${String(port)}`;
  return {
    '/ws': {
      target,
      ws: true,
      changeOrigin: true,
      configure: (proxy) => {
        proxy.on('proxyReqWs', (proxyReq, req) => {
          if (req.headers.origin === devOrigin()) proxyReq.setHeader('origin', target);
        });
      },
    },
  };
};

/** Whether a request may sign in: anything but a request another site made, which browsers mark `cross-site` or `same-site`. */
const loginAllowed = (site: string | string[] | undefined): boolean => site === undefined || site === 'none' || site === 'same-origin';

/** `/login` gets a fresh one-time code from the hub and redirects to the page with it. */
const hubLogin = (port: number, token: string): Plugin => ({
  name: 'wtd-hub-login',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use(LOGIN_PATH, (req, res: ServerResponse) => {
      if (!loginAllowed(req.headers['sec-fetch-site'])) {
        res.writeHead(403, { 'Content-Type': 'text/plain' }).end('sign in from the address bar, not from another site\n');
        return;
      }
      requestCode(port, token).then(
        (code) => {
          res.writeHead(302, { Location: `/#code=${code}` }).end();
        },
        (error: unknown) => {
          res.writeHead(502, { 'Content-Type': 'text/plain' }).end(`hub refused a code: ${String(error)}\n`);
        },
      );
    });
    server.httpServer?.once('listening', () => {
      setTimeout(() => {
        server.config.logger.info(`  wtd login: http://127.0.0.1:${String(server.config.server.port)}${LOGIN_PATH}`);
      });
    });
  },
});

export default defineConfig(async ({ command }): Promise<UserConfig> => {
  const hub = command === 'serve' ? await runningHub() : null;
  return {
    root: 'src/web',
    define: { __WTD_VERSION__: JSON.stringify(pkg.version) },
    esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
    // esbuild's minifier keeps string literals quoted, so the version stays findable in the bundle.
    build: { outDir: '../../dist/web', emptyOutDir: true, minify: 'esbuild' },
    plugins: hub === null ? [] : [hubLogin(hub.port, hub.token)],
    server: hub === null ? {} : { host: '127.0.0.1', port: devPort(), strictPort: true, headers: NO_FRAMES, proxy: hubProxy(hub.port) },
  };
});
