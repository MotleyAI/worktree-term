import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['src/**/*.test.ts'] } },
      { test: { name: 'process', include: ['test/process/**/*.test.ts'], globalSetup: ['test/process/global-setup.ts'] } },
      { test: { name: 'architecture', include: ['test/architecture/**/*.test.ts'], testTimeout: 300_000, hookTimeout: 120_000 } },
      { test: { name: 'integration', include: ['test/integration/**/*.test.ts'] } },
    ],
  },
});
