import { defineConfig } from '@playwright/test';
import { availableParallelism } from 'node:os';

export default defineConfig({
  testDir: 'test/e2e',
  globalSetup: './test/e2e/global-setup.ts',
  // Over 8 workers (each a Chrome, hub and daemon) exhaust the default 128 inotify instances; local runs use half the CPUs.
  workers: Math.min(8, process.env['CI'] ? availableParallelism() : Math.max(1, Math.floor(availableParallelism() / 2))),
  timeout: 60_000,
  use: {
    channel: 'chrome',
    headless: true,
    // Hardware WebGL in headless Chrome (design D13); the perf spec fails on a software renderer.
    launchOptions: { args: ['--enable-gpu', '--use-angle=vulkan'] },
  },
  projects: [
    { name: 'e2e', testIgnore: /perf\.spec\.ts$/, fullyParallel: true },
    // Timed after the rest and in one worker, so neither e2e workers nor other perf copies skew the budgets.
    { name: 'perf', testMatch: /perf\.spec\.ts$/, dependencies: ['e2e'], workers: 1 },
  ],
});
