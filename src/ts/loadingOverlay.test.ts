import { describe, test, expect } from 'vitest'
import { get } from 'svelte/store'
import { claimLoadingOverlay, dismissClaimedLoadingOverlay, loadingOverlayStore } from './stores.svelte'

describe('claimLoadingOverlay', () => {
    test('a release from a superseded load leaves the newer overlay up', () => {
        const releaseFirst = claimLoadingOverlay('first')
        const releaseSecond = claimLoadingOverlay('second')
        releaseFirst()
        expect(get(loadingOverlayStore)).toMatchObject({ active: true, text: 'second' })
        releaseSecond()
        expect(get(loadingOverlayStore).active).toBe(false)
    })

    test('switching to a hydrated chat dismisses the old load overlay', () => {
        const releaseChatA = claimLoadingOverlay('chat A')
        dismissClaimedLoadingOverlay()
        expect(get(loadingOverlayStore).active).toBe(false)

        releaseChatA()
        expect(get(loadingOverlayStore).active).toBe(false)
    })

    test('an overlay set by other code is not hidden by a chat load release', () => {
        const release = claimLoadingOverlay('chat')
        loadingOverlayStore.set({ active: true, text: 'backup', onCancel: null })
        release()
        expect(get(loadingOverlayStore)).toMatchObject({ active: true, text: 'backup' })
        loadingOverlayStore.set({ active: false, text: '', onCancel: null })
    })
})
