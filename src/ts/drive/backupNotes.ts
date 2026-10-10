import { forageStorage } from 'src/ts/globalApi.svelte'
import { getSyncClientId } from 'src/ts/storage/nodeStorage'
import { apiRequestError } from 'src/ts/network/apiError'

export type BackupNoteKind = 'server' | 'manual'

async function backupNoteRequest(path: string, method: 'PUT' | 'POST', body: object) {
    const auth = await forageStorage.createAuth()
    const response = await fetch(path, {
        method,
        headers: {
            'content-type': 'application/json',
            'risu-auth': auth,
            'x-sync-client-id': getSyncClientId(),
        },
        body: JSON.stringify(body),
    })
    if (!response.ok) throw await apiRequestError(response)
    const json = await response.json().catch(() => ({}))
    return json
}

export async function updateBackupNote(kind: BackupNoteKind, id: string, note: string): Promise<string> {
    const json = await backupNoteRequest('/api/backup/notes', 'PUT', { kind, id, note })
    return typeof json.note === 'string' ? json.note : ''
}

export async function promoteAutomaticSnapshot(key: string, note: string): Promise<void> {
    await backupNoteRequest('/api/db/snapshots/promote', 'POST', { key, note })
}
