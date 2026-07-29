import { vi } from 'vitest'
import { Storage as HappyDOMStorage } from 'happy-dom'

// Suppress warning
vi.mock(import('katex'), () => ({}))

vi.stubGlobal('safeStructuredClone', (v: unknown) => JSON.parse(JSON.stringify(v)))

// Node 26 exposes a global localStorage accessor whose value is undefined unless
// --localstorage-file is set. That accessor can shadow happy-dom's localStorage
// when Vitest installs the browser globals, so provide the browser implementation
// explicitly for a stable, in-memory test environment.
Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    enumerable: true,
    value: new HappyDOMStorage(),
})
