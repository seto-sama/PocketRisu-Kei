import { getSyncClientId } from './storage/nodeStorage'

export interface FetchLog {
    id: string
    body: string
    header: string
    response: string
    success: boolean,
    date: string
    timestamp: number
    url: string
    responseType?: string
    chatId?: string
    status?: number
    clientId?: string
    platform?: string
}

const CLIENT_ID_KEY = 'risu-client-id'

function createFetchLogId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function getFetchLogClientId(): string {
    try {
        let id = localStorage.getItem(CLIENT_ID_KEY)
        if (!id) {
            id = typeof crypto !== 'undefined' && crypto.randomUUID
                ? crypto.randomUUID()
                : Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2)
            localStorage.setItem(CLIENT_ID_KEY, id)
        }
        return id.slice(0, 6)
    } catch {
        return 'session'
    }
}

function getFetchLogPlatform(): string {
    if (typeof navigator === 'undefined') return 'Unknown'
    const ua = navigator.userAgent || ''
    const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua)
    return mobile ? 'Mobile' : 'Desktop'
}

export function createFetchLogEntry(log: Omit<FetchLog, 'id' | 'timestamp' | 'clientId' | 'platform'> & {
    id?: string
    timestamp?: number
    clientId?: string
    platform?: string
}): FetchLog {
    return {
        ...log,
        id: log.id ?? createFetchLogId(),
        timestamp: log.timestamp ?? Date.now(),
        clientId: log.clientId ?? getFetchLogClientId(),
        platform: log.platform ?? getFetchLogPlatform(),
    }
}

export function formatFetchLogValue(value: any): string {
    if (typeof value === 'string') return value
    const formatted = JSON.stringify(value, null, 2)
    return formatted === undefined ? '' : formatted
}

type CreateAuth = () => Promise<string | undefined>

export async function getServerFetchLogs(createAuth: CreateAuth): Promise<FetchLog[]> {
    const auth = await createAuth()
    if (!auth) return []
    const res = await fetch('/api/request-logs', {
        headers: { 'risu-auth': auth },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = await res.json()
    return (json.content ?? []) as FetchLog[]
}

export async function getServerFetchLogByChatId(
    chatId: string,
    createAuth: CreateAuth,
): Promise<FetchLog | null> {
    const auth = await createAuth()
    if (!auth || !chatId) return null
    const res = await fetch(`/api/request-logs/chat/${encodeURIComponent(chatId)}`, {
        headers: { 'risu-auth': auth },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = await res.json()
    return (json.content ?? null) as FetchLog | null
}

export async function clearServerFetchLogs(createAuth: CreateAuth) {
    const auth = await createAuth()
    if (!auth) return
    const res = await fetch('/api/request-logs', {
        method: 'DELETE',
        headers: {
            'risu-auth': auth,
            'x-sync-client-id': getSyncClientId(),
        },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
}

export async function deleteServerFetchLog(id: string, createAuth: CreateAuth) {
    const auth = await createAuth()
    if (!auth) return
    const res = await fetch(`/api/request-logs/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: {
            'risu-auth': auth,
            'x-sync-client-id': getSyncClientId(),
        },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
}
