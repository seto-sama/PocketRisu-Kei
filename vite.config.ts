import { defineConfig } from "vite";
import { svelte, vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import wasm from "vite-plugin-wasm";
import strip from '@rollup/plugin-strip';
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

// https://vitejs.dev/config/
export default defineConfig(({command}) => {
  return {
    plugins: [
      localFontsPlugin(),
      svelte({
        configFile: false,
        preprocess: vitePreprocess(),
        onwarn: (warning, handler) => {
          // disable a11y warnings
          if (warning.code.startsWith("a11y-")) return;
          handler(warning);
        },
      }),
      tailwindcss(),
      wasm(),
      command === 'build' ? strip({
        include: '**/*.(mjs|js|svelte|ts)',
        functions: ['console.log', 'console.debug', 'console.table', 'assert.*'],
      }) : null
    ],

    // Keep the development server on a predictable port.
    clearScreen: false,
    server: {
      host: '0.0.0.0', // listen on all addresses
      port: 5174,
      strictPort: true,
      // hmr: false,
    },
    build: {
      target:'baseline-widely-available',
      minify: 'oxc',
      // The largest remaining JS chunk is lazy-loaded tiktoken vocabulary data.
      chunkSizeWarningLimit: 2500,
      rolldownOptions: {
        checks: {
          // This check reports relative plugin time, not an actionable build
          // failure. WASM parsing naturally dominates builds that include tiktoken.
          pluginTimings: false,
        },
        onwarn(warning, handler) {
          // These browser-capable WASM libraries also ship guarded Node.js
          // branches. Rolldown sees their built-in imports statically even
          // though those branches are unreachable in the browser.
          if (isExpectedBrowserExternalization(warning)) return
          // util.ts intentionally defers alert UI to avoid making file-selection
          // helpers depend eagerly on the alert/database cycle.
          if (
            warning.code === 'INEFFECTIVE_DYNAMIC_IMPORT'
            && warning.message.includes('src/ts/alert.ts')
          ) return
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
}
});
