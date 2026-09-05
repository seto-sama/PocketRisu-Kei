import { svelte } from "@sveltejs/vite-plugin-svelte"
import { defineConfig } from 'vitest/config'
import { localFontsPlugin } from './vite.localFonts'

export default defineConfig({
  plugins: [
    localFontsPlugin(),
    svelte(),
  ],
  resolve: {
    alias: {
      src: '/src',
    },
    conditions: ['browser'],
  },
  test: {
    pool: 'threads',
    setupFiles: ['vitest.setup.ts'],
    projects: [
      {
        extends: true,
        test: {
          name: 'client',
          environment: 'happy-dom',
          include: ['src/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'server',
          environment: 'node',
          include: ['server/node/**/*.test.ts', 'test/*.test.ts'],
          setupFiles: [],
          testTimeout: 30_000,
        },
      },
    ],
    // The compat suite remains separate because it has longer hook timeouts.
    exclude: ['node_modules/**', 'test/compat/**'],
  },
})
