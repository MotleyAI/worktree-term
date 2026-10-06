import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'test/e2e',
  globalSetup: './test/e2e/global-setup.ts',
  timeout: 60_000,
  use: {
    channel: 'chrome',
    headless: true,
    // Hardware WebGL in headless Chrome (design D13); the perf spec fails on a software renderer.
    launchOptions: { args: ['--enable-gpu', '--use-angle=vulkan'] },
  },
  projects: [
    { name: 'e2e', testIgnore: /perf\.spec\.ts$/ },
    // Timed after the rest, so other workers' load does not skew the budgets.
    { name: 'perf', testMatch: /perf\.spec\.ts$/, dependencies: ['e2e'] },
  ],
});
