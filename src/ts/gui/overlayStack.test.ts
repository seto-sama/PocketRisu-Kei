import { describe, expect, it } from 'vitest'
import { acquireOverlayLayer } from './overlayStack'

describe('overlay stack', () => {
    it('places newer overlays above existing overlays and their parent', () => {
        const dialog = acquireOverlayLayer()
        const menu = acquireOverlayLayer({ parent: dialog.zIndex })
        const confirmation = acquireOverlayLayer()

        expect(menu.zIndex).toBeGreaterThan(dialog.zIndex)
        expect(confirmation.zIndex).toBeGreaterThan(menu.zIndex)

        confirmation.release()
        menu.release()
        dialog.release()
    })

    it('collapses after overlays close instead of increasing forever', () => {
        const first = acquireOverlayLayer()
        first.release()
        const second = acquireOverlayLayer()

        expect(second.zIndex).toBe(first.zIndex)
        second.release()
    })
})
