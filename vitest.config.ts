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
    environment: 'happy-dom',
    setupFiles: ['vitest.setup.ts'],
    // compat suite has its own node-environment config (vitest.config.compat.ts);
    // exclude here so `pnpm test` doesn't pick them up under the wrong environment.
    exclude: ['node_modules/**', 'test/compat/**'],
  },
})
