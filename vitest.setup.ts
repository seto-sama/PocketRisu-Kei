import { vi } from 'vitest'
import { Storage as HappyDOMStorage } from 'happy-dom'

// Suppress warning
vi.mock(import('katex'), () => ({}))

// Node 26 exposes a global localStorage accessor whose value is undefined unless
// --localstorage-file is set. That accessor can shadow happy-dom's localStorage
// when Vitest installs the browser globals, so provide the browser implementation
// explicitly for a stable, in-memory test environment.
Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    enumerable: true,
    value: new HappyDOMStorage(),
})

// Browsers define nodeName once on Node.prototype, and DOMPurify reads it
// through that getter to resist clobbering. happy-dom returns '' there and
// overrides it per subclass, so every node would sanitize as nameless: hooks
// see an empty tagName and allowed elements are dropped. Forward to the
// subclass getter instead. Files on the node environment have no DOM.
if (typeof Node !== 'undefined') {
    Object.defineProperty(Node.prototype, 'nodeName', {
        configurable: true,
        get(this: Node) {
            for (let proto = Object.getPrototypeOf(this); proto && proto !== Node.prototype; proto = Object.getPrototypeOf(proto)) {
                const getter = Object.getOwnPropertyDescriptor(proto, 'nodeName')?.get
                if (getter) return getter.call(this)
            }
            return ''
        },
    })
}
