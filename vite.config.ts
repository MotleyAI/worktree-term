import type { ServerResponse } from 'node:http';
import { defineConfig, type Plugin, type ProxyOptions, type UserConfig } from 'vite';
import pkg from './package.json' with { type: 'json' };
import { readHubRecord, readToken, requestCode } from './src/hub/server/index.js';
import { currentHostPaths } from './src/platform/files/index.js';

const LOGIN_PATH = '/login';

/** The running hub's port and token; `pnpm dev` needs a hub started by `wtd ui` or `wtd hub`. */
const runningHub = async (): Promise<{ port: number; token: string }> => {
  const paths = currentHostPaths();
  const [record, token] = await Promise.all([readHubRecord(paths.hubRecord), readToken(paths.hubToken)]);
  if (record === null || token === null) throw new Error('no hub is running; start one with `node dist/wtd.mjs ui`');
  return { port: record.port, token };
};

/** Proxies `/api` and `/ws` to the hub, rewriting Host and Origin to the hub's own. */
const hubProxy = (port: number): Record<string, ProxyOptions> => {
  const target = `http://127.0.0.1:${String(port)}`;
  const options: ProxyOptions = {
    target,
    changeOrigin: true,
    configure: (proxy) => {
      proxy.on('proxyReq', (req) => {
        if (req.getHeader('origin') !== undefined) req.setHeader('origin', target);
      });
      proxy.on('proxyReqWs', (req) => {
        req.setHeader('origin', target);
      });
    },
  };
  return { '/api': options, '/ws': { ...options, ws: true } };
};

/** `/login` gets a fresh one-time code from the hub and redirects to the page with it. */
const hubLogin = (port: number, token: string): Plugin => ({
  name: 'wtd-hub-login',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use(LOGIN_PATH, (_req, res: ServerResponse) => {
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
    server: hub === null ? {} : { host: '127.0.0.1', port: 5173, strictPort: true, proxy: hubProxy(hub.port) },
  };
});
