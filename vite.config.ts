import { defineConfig } from 'vite'
import { svelte, vitePreprocess } from '@sveltejs/vite-plugin-svelte'
import wasm from 'vite-plugin-wasm'
import tailwindcss from '@tailwindcss/vite'
import { localFontsPlugin } from './vite.localFonts.ts'

const browserCompatibleNodeImporters = [
  '/node_modules/@browsermt/bergamot-translator/',
  '/node_modules/wasmoon/',
]

function isExpectedBrowserExternalization(warning: { message: string }) {
  const message = warning.message.replaceAll('\\', '/')
  return message.includes('has been externalized for browser compatibility')
    && browserCompatibleNodeImporters.some(importer => message.includes(importer))
}

const rolldownOptions = {
  checks: {
    // WASM parsing makes build timing warnings noisy.
    bundlerTimings: false,
    ineffectiveDynamicImport: false,
  },
}

export default defineConfig({
  plugins: [
    localFontsPlugin(),
    svelte({
      configFile: false,
      preprocess: vitePreprocess(),
      onwarn(warning, handler) {
        if (warning.code.startsWith('a11y-')) return
        handler(warning)
      },
    }),
    tailwindcss(),
    wasm(),
  ],
  clearScreen: false,
  build: {
    sourcemap: true,
    // The tiktoken vocabulary chunk is large but lazy-loaded.
    chunkSizeWarningLimit: 2500,
    rolldownOptions: {
      ...rolldownOptions,
      onwarn(warning, handler) {
        // These WASM libraries guard their Node.js-only imports at runtime.
        if (isExpectedBrowserExternalization(warning)) return
        handler(warning)
      },
    },
  },
  optimizeDeps: {
    exclude: ['@browsermt/bergamot-translator'],
  },
  resolve: {
    alias: {
      src: '/src',
      $lib: '/src/lib',
    },
  },
  worker: {
    format: 'es',
    rolldownOptions,
  },
})
