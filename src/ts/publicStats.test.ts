import { beforeEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'
import {
    publicStatsStore,
    syncPublicStatsVisibility,
} from './publicStats'

describe('public statistics visibility', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        publicStatsStore.set(null)
    })

    it('clears existing statistics without making a request when hidden', async () => {
        publicStatsStore.set({ dau: 10, yesterdayDau: 9, visits: 15, timezone: 'UTC' })
        const fetchMock = vi.spyOn(globalThis, 'fetch')

        await syncPublicStatsVisibility(true)

        expect(fetchMock).not.toHaveBeenCalled()
        expect(get(publicStatsStore)).toBeNull()
    })

    it('loads statistics when they are visible', async () => {
        const stats = { dau: 10, yesterdayDau: 9, visits: 15, timezone: 'UTC' }
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(JSON.stringify(stats), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            }),
        )

        await syncPublicStatsVisibility(false)

        expect(fetchMock).toHaveBeenCalledOnce()
        expect(fetchMock).toHaveBeenCalledWith('/api/public-stats')
        expect(get(publicStatsStore)).toEqual(stats)
    })

    it('ignores a response that finishes after statistics are hidden', async () => {
        let resolveResponse!: (response: Response) => void
        vi.spyOn(globalThis, 'fetch').mockReturnValue(new Promise(resolve => {
            resolveResponse = resolve
        }))

        const loading = syncPublicStatsVisibility(false)
        await syncPublicStatsVisibility(true)
        resolveResponse(new Response(JSON.stringify({ dau: 10, yesterdayDau: 9, visits: 15, timezone: 'UTC' })))
        await loading

        expect(get(publicStatsStore)).toBeNull()
    })
})
