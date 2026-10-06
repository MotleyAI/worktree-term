import { defineConfig } from '@playwright/test';
import { availableParallelism } from 'node:os';

export default defineConfig({
  testDir: 'test/e2e',
  globalSetup: './test/e2e/global-setup.ts',
  // Each worker runs a Chrome, a hub and a daemon; more than 8 exhausts the default 128 inotify instances per user.
  workers: Math.min(8, Math.max(1, Math.floor(availableParallelism() / 2))),
  timeout: 60_000,
  use: {
    channel: 'chrome',
    headless: true,
    // Hardware WebGL in headless Chrome (design D13); the perf spec fails on a software renderer.
    launchOptions: { args: ['--enable-gpu', '--use-angle=vulkan'] },
  },
  projects: [
    // Every test has its own hub, so tests within a file run in parallel too.
    { name: 'e2e', testIgnore: /perf\.spec\.ts$/, fullyParallel: true },
    // Timed after the rest, so other workers' load does not skew the budgets.
    { name: 'perf', testMatch: /perf\.spec\.ts$/, dependencies: ['e2e'] },
  ],
});
