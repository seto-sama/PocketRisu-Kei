import { UAParser } from 'ua-parser-js'
import { createEntityId } from './id'

const CLIENT_ID_KEY = 'risu-client-id'
const FLUSH_DELAY_MS = 500
const DEDUPE_WINDOW_MS = 1000
const MAX_BUFFER = 1000

export type LogLevel = 'error' | 'warning' | 'info'

export interface LogEntry {
    timestamp: number
    level: LogLevel
    message: string
    description?: string
    source?: string
    count?: number
    platform?: string
    clientId?: string
    userAgent?: string
}

export interface AddLogInput {
    level: LogLevel
    message: string
    description?: string
    source?: string
}

let cachedClientId: string | null = null
export function getLogClientId(): string {
    if (cachedClientId) return cachedClientId
    // Keep a session-only ID when browser storage is unavailable.
    let id: string | null = null
    try {
        id = localStorage.getItem(CLIENT_ID_KEY)
    } catch { /* storage unavailable */ }
    if (!id) {
        id = createEntityId()
        try {
            localStorage.setItem(CLIENT_ID_KEY, id)
        } catch { /* storage unavailable — id stays session-only */ }
    }
    cachedClientId = id.slice(0, 6)
    return cachedClientId
}

let cachedPlatform: string | null = null
function getPlatform(): string {
    if (cachedPlatform) return cachedPlatform
    try {
        const parser = new UAParser(navigator.userAgent).getResult()
        const browser = parser.browser.name || 'Other'
        const os = parser.os.name || 'Other'
        cachedPlatform = `${browser} · ${os}`
    } catch {
        cachedPlatform = 'Unknown'
    }
    return cachedPlatform
}

const buffer: LogEntry[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null

export function addLog(input: AddLogInput) {
    const now = Date.now()
    // Dedupe: same (message + source + level) within window → bump count.
    for (let i = buffer.length - 1; i >= 0; i--) {
        const e = buffer[i]
        if (now - e.timestamp > DEDUPE_WINDOW_MS) break
        if (e.message === input.message && e.source === input.source && e.level === input.level) {
            e.count = (e.count ?? 1) + 1
            return
        }
    }

    const entry: LogEntry = {
        timestamp: now,
        level: input.level,
        message: input.message,
        description: input.description,
        source: input.source,
        count: 1,
        platform: getPlatform(),
        clientId: getLogClientId(),
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
    }
    buffer.push(entry)

    // Hard cap to prevent runaway memory if the server is unreachable.
    if (buffer.length > MAX_BUFFER) {
        buffer.splice(0, buffer.length - MAX_BUFFER)
    }

    if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_DELAY_MS)
}

async function flush() {
    flushTimer = null
    if (buffer.length === 0) return
    const batch = buffer.splice(0, Math.min(buffer.length, MAX_BUFFER))
    try {
        // Keep storage dependencies out of console-capture initialization.
        const { forageStorage } = await import('./storage/autoStorage')
        const auth = await forageStorage.createAuth()
        await fetch('/api/logs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'risu-auth': auth },
            body: JSON.stringify(batch),
        })
    } catch {
        // Drop on network failure without retrying or persisting the batch.
    }

    if (buffer.length > 0 && !flushTimer) {
        // Entries may arrive while the request is in flight.
        flushTimer = setTimeout(flush, FLUSH_DELAY_MS)
    }
}
