import { forageStorage } from './autoStorage'
import { getSyncClientId } from './nodeStorage'

export interface OrphanAssetStats {
    count: number
    totalSize: number
    available: boolean
}

export interface OrphanAssetPurgeResult {
    ok: true
    deleted: number
    bytes: number
    scanned: number
}

/** Shared mutation used by both the storage dashboard and opt-in boot cleanup. */
export async function purgeOrphanAssets(): Promise<OrphanAssetPurgeResult> {
    const auth = await forageStorage.createAuth()
    const response = await fetch('/api/db/assets/purge-orphans', {
        method: 'POST',
        headers: {
            'risu-auth': auth,
            'x-sync-client-id': getSyncClientId(),
        },
    })
    const payload = await response.json().catch(() => ({}))
    if(!response.ok){
        throw new Error(payload?.error || `HTTP ${response.status}`)
    }
    return payload as OrphanAssetPurgeResult
}
