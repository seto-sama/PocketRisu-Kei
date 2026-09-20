import { writable } from "svelte/store"

export interface PublicStats {
    dau: number
    yesterdayDau: number
    visits: number
    timezone: string
}

export const publicStatsStore = writable<PublicStats | null>(null)
let visibilityRevision = 0

async function fetchPublicStats(revision: number): Promise<void> {
    try {
        const res = await fetch('/api/public-stats')
        if (!res.ok) return
        const data: PublicStats = await res.json()
        if (revision === visibilityRevision) publicStatsStore.set(data)
    } catch {
        // silently ignore
    }
}

export async function syncPublicStatsVisibility(hidden: boolean): Promise<void> {
    const revision = ++visibilityRevision
    if (hidden) {
        publicStatsStore.set(null)
        return
    }
    await fetchPublicStats(revision)
}
