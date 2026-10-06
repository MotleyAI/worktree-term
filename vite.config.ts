import { defineConfig } from 'vite';
import pkg from './package.json' with { type: 'json' };

export default defineConfig({
  root: 'src/web',
  define: { __WTD_VERSION__: JSON.stringify(pkg.version) },
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  // esbuild's minifier keeps string literals quoted, so the version stays findable in the bundle.
  build: { outDir: '../../dist/web', emptyOutDir: true, minify: 'esbuild' },
});
