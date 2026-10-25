import {
    getDatabase,
    type character as Character,
    type Database,
} from '../storage/database.svelte'
import {
    convertStubsToPlaceholders,
    fetchChatFromServer,
    getFetchedChatState,
    mergeHydratedChatWithMetadata,
    type FetchedChatState,
} from '../storage/chatStorage'
import {
    canApplyChatGenerationCanonical,
    isChatGenerationProjectionActive,
    resolveChatGenerationCanonical,
    isChatWorkingCopyDirty,
    reconcileChatWorkingCopy,
} from '../storage/chatWorkingCopy'
import { forageStorage } from '../storage/autoStorage'

export type SyncChatTarget = {
    characterId: string
    chatId: string
    terminalCanonical?: boolean
    read?: FetchedChatState
}

export type SyncedDatabaseOptions = {
    authoritativeChatReset?: boolean
    serverAppliedChats?: SyncChatTarget[]
    revision?: number
}

type SyncedDatabaseHandler = (
    data: Database,
    etag: string | null,
    options?: SyncedDatabaseOptions,
) => Promise<void>

let syncedDatabaseHandler: SyncedDatabaseHandler | null = null

export function registerSyncedDatabaseHandler(handler: SyncedDatabaseHandler) {
    syncedDatabaseHandler = handler
}

async function applySyncedDatabase(
    data: Database,
    etag: string | null,
    options?: SyncedDatabaseOptions,
) {
    while (!syncedDatabaseHandler) {
        await new Promise(resolve => setTimeout(resolve, 20))
    }
    await syncedDatabaseHandler(data, etag, options)
}

export function syncChatKey(characterId: string, chatId: string) {
    return `${characterId}\u0000${chatId}`
}

/** Apply fetched bodies against the live edits at installation time, after queued saves settle. */
export function reconcileHydratedChats(remote: Database, targets: SyncChatTarget[]) {
    const fetched = new Map(targets.map(target => [syncChatKey(target.characterId, target.chatId), target]))
    const localCharacters = new Map(getDatabase().characters.map(character => [character.chaId, character]))
    for (const character of remote.characters ?? []) {
        const localChats = new Map((localCharacters.get(character.chaId)?.chats ?? []).map(chat => [chat.id, chat]))
        character.chats = character.chats.map(chat => {
            const live = localChats.get(chat.id)
            if (!live || live._placeholder) return chat
            const target = fetched.get(syncChatKey(character.chaId, chat.id))
            if (!target || chat._placeholder) return mergeHydratedChatWithMetadata(live, chat)
            if (target.read && !target.read.isCurrent()) {
                window.dispatchEvent(new CustomEvent('risu-sync-refresh-requested', {
                    detail: { characterId: character.chaId, chatId: chat.id, terminalCanonical: target.terminalCanonical },
                }))
                return mergeHydratedChatWithMetadata(live, chat)
            }
            if (isChatGenerationProjectionActive(character.chaId, chat.id)) {
                return canApplyChatGenerationCanonical(character.chaId, chat.id, target.terminalCanonical === true)
                    ? resolveChatGenerationCanonical(character.chaId, live, chat, target.read?.etag)
                    : mergeHydratedChatWithMetadata(live, chat)
            }
            return reconcileChatWorkingCopy(character.chaId, live, chat, target.read?.etag)
        })
    }
}

/** Reconcile one database stub snapshot with page-local hydrated chat bodies. */
export async function reconcileServerDatabase(
    changedChats: ReadonlySet<string>,
    refreshAllChats: boolean,
    terminalCanonicalChats: ReadonlySet<string> = new Set(),
) {
    const projection = await forageStorage.getDatabaseProjection<Database>()
    if (!projection.database) return

    const remote = projection.database
    const local = structuredClone(getDatabase()) as Database
    const localCharacters = new Map<string, Character>(
        (local.characters ?? []).map(character => [character.chaId, character] as const),
    )
    const serverAppliedChats: SyncChatTarget[] = []

    for (const character of remote.characters ?? []) {
        character.chats = convertStubsToPlaceholders(character.chats ?? [])
        const localCharacter = localCharacters.get(character.chaId)
        const localChats = new Map((localCharacter?.chats ?? []).map(chat => [chat.id, chat]))

        for (let index = 0; index < character.chats.length; index++) {
            const remoteChat = character.chats[index]
            if (!remoteChat?.id) continue
            const localChat = localChats.get(remoteChat.id)
            const chatKey = syncChatKey(character.chaId, remoteChat.id)
            const generationProjectionActive = isChatGenerationProjectionActive(
                character.chaId,
                remoteChat.id,
            )
            const acceptsTargetedCanonical = generationProjectionActive
                ? canApplyChatGenerationCanonical(
                    character.chaId,
                    remoteChat.id,
                    terminalCanonicalChats.has(chatKey),
                )
                : true
            const shouldHydrate = (
                changedChats.has(chatKey) && acceptsTargetedCanonical
            ) || (refreshAllChats && localChat && !localChat._placeholder)

            if (shouldHydrate) {
                const full = await fetchChatFromServer(character.chaId, index, remoteChat.id)
                if (full) {
                    character.chats[index] = full
                    serverAppliedChats.push({
                        characterId: character.chaId,
                        chatId: remoteChat.id,
                        terminalCanonical: terminalCanonicalChats.has(chatKey),
                        read: getFetchedChatState(full),
                    })
                }
                continue
            }

            // Preserve a hydrated local body until a targeted canonical fetch.
            if (localChat && !localChat._placeholder) {
                character.chats[index] = localChat
            }
        }

        // A newly created local chat may not be in the remote stub list yet.
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

    await applySyncedDatabase(remote, projection.etag, {
        authoritativeChatReset: refreshAllChats,
        serverAppliedChats,
        revision: projection.revision,
    })
}
