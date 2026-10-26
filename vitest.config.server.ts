import { defineConfig } from 'vitest/config'

// Standalone entry point for the server suite, also included in vitest.config.ts.
export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['vitest.setup.server.ts'],
    include: ['server/**/*.test.ts'],
    testTimeout: 30_000,
  },
})
