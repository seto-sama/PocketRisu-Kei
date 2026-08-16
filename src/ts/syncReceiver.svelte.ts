import { applySyncedDatabase, forageStorage } from './globalApi.svelte'
import { getDatabase, type character as Character, type Database } from './storage/database.svelte'
import {
    convertStubsToPlaceholders,
    fetchChatFromServer,
    getChatServerEtag,
} from './storage/chatStorage'
import { decodeRisuSave } from './storage/risuSave'
import { getSyncClientId } from './storage/nodeStorage'
import { safeStructuredClone } from './polyfill'
import {
    awaitChatGenerationCanonical,
    isChatAwaitingGenerationCanonical,
    isChatWorkingCopyDirty,
    resolveChatGenerationCanonical,
} from './storage/chatWorkingCopy'
import {
    emitRevenantWorkflowSyncReady,
    emitRevenantWorkflowUpdate,
} from './process/revenant/workflow'

type SyncChatTarget = {
    characterId: string
    chatId: string
}

type SyncMessage = {
    type: string
    etag?: string
    chats?: SyncChatTarget[]
    allChats?: boolean
    workflowId?: string
    characterId?: string
    roomId?: string
    status?: string
}

let socket: WebSocket | null = null
let stopped = false
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let refreshTimer: ReturnType<typeof setTimeout> | null = null
let refreshInFlight: Promise<void> | null = null
const pendingChats = new Set<string>()
let pendingAllChats = false

function chatKey(characterId: string, chatId: string) {
    return `${characterId}\u0000${chatId}`
}

async function refreshFromServer() {
    if (refreshInFlight) return refreshInFlight
    const changedChats = new Set(pendingChats)
    const refreshAllChats = pendingAllChats
    const serverAppliedChats: SyncChatTarget[] = []
    pendingChats.clear()
    pendingAllChats = false

    refreshInFlight = (async () => {
        const raw = await forageStorage.getItem('database/database.bin') as unknown as Uint8Array
        if (!raw?.length) return

        const remote = await decodeRisuSave(raw) as Database
        const local = safeStructuredClone(getDatabase()) as Database
        const localCharacters = new Map<string, Character>(
            (local.characters ?? []).map(character => [character.chaId, character] as const),
        )

        for (const character of remote.characters ?? []) {
            character.chats = convertStubsToPlaceholders(character.chats ?? [])
            const localCharacter = localCharacters.get(character.chaId)

            // Navigation is page-local UI state. Keep the chat this tab is
            // currently viewing instead of following another tab's chatPage.
            // Resolve by stable chat id because the remote chats array may
            // have been reordered.
            const localSelectedChatId = localCharacter?.chats?.[localCharacter.chatPage]?.id
            if (localSelectedChatId) {
                const remoteSelectedIndex = character.chats.findIndex(
                    chat => chat?.id === localSelectedChatId,
                )
                if (remoteSelectedIndex >= 0) {
                    character.chatPage = remoteSelectedIndex
                } else {
                    character.chatPage = Math.max(
                        0,
                        Math.min(localCharacter?.chatPage ?? 0, character.chats.length - 1),
                    )
                }
            } else if (localCharacter) {
                character.chatPage = Math.max(
                    0,
                    Math.min(localCharacter.chatPage ?? 0, character.chats.length - 1),
                )
            }

            for (let index = 0; index < character.chats.length; index++) {
                const remoteChat = character.chats[index]
                if (!remoteChat?.id) continue
                const key = chatKey(character.chaId, remoteChat.id)

                const localChat = localCharacter?.chats?.find(chat => chat?.id === remoteChat.id)
                const localDirty = isChatWorkingCopyDirty(character.chaId, remoteChat.id)
                const awaitingCanonical = isChatAwaitingGenerationCanonical(
                    character.chaId,
                    remoteChat.id,
                )
                if (
                    (changedChats.has(key) && (!localDirty || awaitingCanonical))
                    || (refreshAllChats && localChat && !localChat._placeholder)
                ) {
                    const full = await fetchChatFromServer(character.chaId, index, remoteChat.id)
                    if (full) {
                        character.chats[index] = localChat && awaitingCanonical
                            ? resolveChatGenerationCanonical(
                                character.chaId,
                                localChat,
                                full,
                                getChatServerEtag(character.chaId, remoteChat.id),
                            )
                            : full
                        serverAppliedChats.push({
                            characterId: character.chaId,
                            chatId: remoteChat.id,
                        })
                    }
                    continue
                }

                // database.bin intentionally contains chat stubs. Preserve an
                // already hydrated local chat unless the server explicitly
                // reported a clean working copy as changed. Dirty bodies keep
                // their pinned base ETag and resolve through the commit CAS.
                if (localChat && !localChat._placeholder) {
                    character.chats[index] = localChat
                }
            }

            // A new local chat may not have reached the server's stub list yet.
            // Carry dirty working copies across ordinary sync by stable id.
            if (!refreshAllChats && localCharacter) {
                for (const localChat of localCharacter.chats ?? []) {
                    if (
                        localChat?.id
                        && !localChat._placeholder
                        && isChatWorkingCopyDirty(character.chaId, localChat.id)
                        && !character.chats.some(chat => chat?.id === localChat.id)
                    ) {
                        character.chats.push(localChat)
                    }
                }
            }
        }

        await applySyncedDatabase(remote, forageStorage.getDbEtag(), {
            authoritativeChatReset: refreshAllChats,
            serverAppliedChats,
        })

    })().finally(() => {
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

async function connect() {
    if (stopped) return
    try {
        const auth = await forageStorage.createAuth()
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
        const url = `${protocol}//${location.host}/sync?client-id=${encodeURIComponent(getSyncClientId())}&risu-auth=${encodeURIComponent(auth)}`
        socket = new WebSocket(url)

        socket.onmessage = event => {
            let message: SyncMessage
            try {
                message = JSON.parse(String(event.data))
            } catch {
                return
            }
            if (message.type === 'sync-ready') {
                emitRevenantWorkflowSyncReady()
                return
            }
            if (message.type === 'generation-workflow-updated') {
                if (
                    message.workflowId
                    && message.characterId
                    && message.roomId
                    && ['active', 'completed', 'cancelled', 'failed'].includes(message.status ?? '')
                ) {
                    if (message.status !== 'active') {
                        // Arm ownership handoff, but do not synthesize a DB
                        // refresh from workflow state. The server publishes a
                        // targeted database-invalidated event only after the
                        // canonical terminal chat is ready.
                        awaitChatGenerationCanonical(message.characterId, message.roomId)
                    }
                    emitRevenantWorkflowUpdate({
                        workflowId: message.workflowId,
                        characterId: message.characterId,
                        roomId: message.roomId,
                        status: message.status as 'active' | 'completed' | 'cancelled' | 'failed',
                    })
                }
                return
            }
            if (message.type !== 'database-invalidated') return
            if (message.allChats === true) pendingAllChats = true
            for (const chat of message.chats ?? []) {
                if (chat.characterId && chat.chatId) {
                    pendingChats.add(chatKey(chat.characterId, chat.chatId))
                }
            }
            scheduleRefresh()
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

export function startSyncReceiver() {
    stopped = false
    const refreshRequested = () => scheduleRefresh()
    window.addEventListener('risu-sync-refresh-requested', refreshRequested)
    void connect()
    return () => {
        stopped = true
        window.removeEventListener('risu-sync-refresh-requested', refreshRequested)
        if (reconnectTimer) clearTimeout(reconnectTimer)
        if (refreshTimer) clearTimeout(refreshTimer)
        socket?.close()
        socket = null
    }
}
