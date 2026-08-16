import { awaitChatGenerationCanonical } from './storage/chatWorkingCopy'
import { forageStorage } from './storage/autoStorage'
import { getSyncClientId } from './storage/nodeStorage'
import {
    emitRevenantWorkflowSyncReady,
    emitRevenantWorkflowUpdate,
} from './process/revenant/workflow'
import {
    reconcileServerDatabase,
    syncChatKey,
    type SyncChatTarget,
} from './sync/databaseSync'

type SyncMessage = {
    type: string
    etag?: string
    chatEtag?: string
    chats?: SyncChatTarget[]
    allChats?: boolean
    workflowId?: string
    characterId?: string
    roomId?: string
    status?: string
}

function startSyncTransport(onMessage: (message: SyncMessage) => void) {
    let socket: WebSocket | null = null
    let stopped = false
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null

    async function connect() {
        if (stopped) return
        try {
            const auth = await forageStorage.createAuth()
            const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
            const url = `${protocol}//${location.host}/sync?client-id=${encodeURIComponent(getSyncClientId())}&risu-auth=${encodeURIComponent(auth)}`
            socket = new WebSocket(url)
            socket.onmessage = event => {
                try {
                    onMessage(JSON.parse(String(event.data)) as SyncMessage)
                } catch {
                    // Ignore malformed or unsupported sync frames.
                }
            }
            socket.onclose = () => {
                socket = null
                if (!stopped) reconnectTimer = setTimeout(() => void connect(), 2_000)
            }
            socket.onerror = () => socket?.close()
        } catch {
            if (!stopped) reconnectTimer = setTimeout(() => void connect(), 2_000)
        }
    }

    void connect()
    return () => {
        stopped = true
        if (reconnectTimer) clearTimeout(reconnectTimer)
        socket?.close()
        socket = null
    }
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null
let refreshInFlight: Promise<void> | null = null
const pendingChats = new Set<string>()
let pendingAllChats = false

async function refreshFromServer() {
    if (refreshInFlight) return refreshInFlight
    const changedChats = new Set(pendingChats)
    const refreshAllChats = pendingAllChats
    pendingChats.clear()
    pendingAllChats = false

    refreshInFlight = reconcileServerDatabase(changedChats, refreshAllChats)
        .finally(() => {
            refreshInFlight = null
            if (pendingChats.size > 0 || pendingAllChats) scheduleRefresh()
        })
    return refreshInFlight
}

function scheduleRefresh() {
    if (refreshTimer) clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => {
        refreshTimer = null
        void refreshFromServer().catch(error => {
            console.error('[Sync] Failed to apply server update:', error)
        })
    }, 80)
}

function handleWorkflowUpdate(message: SyncMessage) {
    if (
        !message.workflowId
        || !message.characterId
        || !message.roomId
        || !['active', 'completed', 'cancelled', 'failed'].includes(message.status ?? '')
    ) return

    if (message.status !== 'active') {
        // The matching targeted invalidation is sent only after canonical
        // materialization; this merely arms the ownership handoff.
        awaitChatGenerationCanonical(message.characterId, message.roomId)
    }
    emitRevenantWorkflowUpdate({
        workflowId: message.workflowId,
        characterId: message.characterId,
        roomId: message.roomId,
        status: message.status as 'active' | 'completed' | 'cancelled' | 'failed',
    })
}

function handleSyncMessage(message: SyncMessage) {
    if (message.type === 'sync-ready') {
        emitRevenantWorkflowSyncReady()
        return
    }
    if (message.type === 'generation-workflow-updated') {
        handleWorkflowUpdate(message)
        return
    }
    if (message.type !== 'database-invalidated') return

    if (message.allChats === true) pendingAllChats = true
    for (const chat of message.chats ?? []) {
        if (chat.characterId && chat.chatId) {
            pendingChats.add(syncChatKey(chat.characterId, chat.chatId))
        }
    }
    scheduleRefresh()
}

export function startSyncReceiver() {
    const stopTransport = startSyncTransport(handleSyncMessage)
    const refreshRequested = () => scheduleRefresh()
    window.addEventListener('risu-sync-refresh-requested', refreshRequested)
    return () => {
        window.removeEventListener('risu-sync-refresh-requested', refreshRequested)
        if (refreshTimer) clearTimeout(refreshTimer)
        stopTransport()
    }
}
