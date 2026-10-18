import { defineConfig } from "vite";
import { svelte, vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import wasm from "vite-plugin-wasm";
import tailwindcss from '@tailwindcss/vite'
import { localFontsPlugin } from './vite.localFonts';

const browserCompatibleNodeImporters = [
  '/node_modules/@browsermt/bergamot-translator/',
  '/node_modules/wasmoon/',
]

function isExpectedBrowserExternalization(warning: { message: string }) {
  const message = warning.message.replaceAll('\\', '/')
  return message.includes('has been externalized for browser compatibility')
    && browserCompatibleNodeImporters.some(importer => message.includes(importer))
}

export default defineConfig({
    plugins: [
      localFontsPlugin(),
      svelte({
        configFile: false,
        preprocess: vitePreprocess(),
        onwarn: (warning, handler) => {
          if (warning.code.startsWith("a11y-")) return;
          handler(warning);
        },
      }),
      tailwindcss(),
      wasm(),
    ],

    clearScreen: false,
    server: {
      host: '0.0.0.0',
      port: 5174,
      strictPort: true,
    },
    build: {
      target:'baseline-widely-available',
      minify: 'oxc',
      // The tiktoken vocabulary chunk is large but lazy-loaded.
      chunkSizeWarningLimit: 2500,
      rolldownOptions: {
        // App debug arguments are guarded; remove debug calls from bundled libraries.
        treeshake: {
          manualPureFunctions: ['console.log', 'console.debug', 'console.table'],
        },
        checks: {
          // Plugin timings vary with WASM parsing and are not actionable build checks.
          pluginTimings: false,
        },
        onwarn(warning, handler) {
          // These browser-capable WASM libraries also ship guarded Node.js
          // branches. Rolldown sees their built-in imports statically even
          // though those branches are unreachable in the browser.
          if (isExpectedBrowserExternalization(warning)) return
          if (warning.code === 'INEFFECTIVE_DYNAMIC_IMPORT') return
          handler(warning)
        },
      },
    },
    
    optimizeDeps:{
      exclude: [
        "@browsermt/bergamot-translator"
      ]
    },

    resolve:{
      alias:{
        'src':'/src',
        '$lib':'/src/lib',
      }
    },
    worker: {
      format: 'es',
      rolldownOptions: {
        checks: {
          pluginTimings: false,
        },
        onwarn(warning, handler) {
          if (isExpectedBrowserExternalization(warning)) return
          handler(warning)
        },
      },
    }
});
