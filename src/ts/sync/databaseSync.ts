import { safeStructuredClone } from '../polyfill'
import {
    getDatabase,
    type character as Character,
    type Database,
} from '../storage/database.svelte'
import {
    convertStubsToPlaceholders,
    fetchChatFromServer,
    getChatServerEtag,
} from '../storage/chatStorage'
import {
    canApplyChatGenerationCanonical,
    isChatGenerationProjectionActive,
    isChatAwaitingGenerationCanonical,
    resolveChatGenerationCanonical,
    isChatWorkingCopyDirty,
} from '../storage/chatWorkingCopy'
import { forageStorage } from '../storage/autoStorage'
import { decodeRisuSave } from '../storage/risuSave'

export type SyncChatTarget = {
    characterId: string
    chatId: string
}

export type SyncedDatabaseOptions = {
    authoritativeChatReset?: boolean
    serverAppliedChats?: SyncChatTarget[]
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

/** Reconcile one database stub snapshot with page-local hydrated chat bodies. */
export async function reconcileServerDatabase(
    changedChats: ReadonlySet<string>,
    refreshAllChats: boolean,
    terminalCanonicalChats: ReadonlySet<string> = new Set(),
) {
    const raw = await forageStorage.getItem('database/database.bin') as unknown as Uint8Array
    if (!raw?.length) return

    const remote = await decodeRisuSave(raw) as Database
    const local = safeStructuredClone(getDatabase()) as Database
    const localCharacters = new Map<string, Character>(
        (local.characters ?? []).map(character => [character.chaId, character] as const),
    )
    const serverAppliedChats: SyncChatTarget[] = []

    for (const character of remote.characters ?? []) {
        character.chats = convertStubsToPlaceholders(character.chats ?? [])
        const localCharacter = localCharacters.get(character.chaId)

        // Chat selection is page-local UI state, resolved by stable id.
        const localSelectedChatId = localCharacter?.chats?.[localCharacter.chatPage]?.id
        if (localSelectedChatId) {
            const remoteSelectedIndex = character.chats.findIndex(
                chat => chat?.id === localSelectedChatId,
            )
            character.chatPage = remoteSelectedIndex >= 0
                ? remoteSelectedIndex
                : Math.max(0, Math.min(
                    localCharacter?.chatPage ?? 0,
                    character.chats.length - 1,
                ))
        } else if (localCharacter) {
            character.chatPage = Math.max(
                0,
                Math.min(localCharacter.chatPage ?? 0, character.chats.length - 1),
            )
        }

        for (let index = 0; index < character.chats.length; index++) {
            const remoteChat = character.chats[index]
            if (!remoteChat?.id) continue
            const localChat = localCharacter?.chats?.find(chat => chat?.id === remoteChat.id)
            const localDirty = isChatWorkingCopyDirty(character.chaId, remoteChat.id)
            const chatKey = syncChatKey(character.chaId, remoteChat.id)
            const generationProjectionActive = isChatGenerationProjectionActive(
                character.chaId,
                remoteChat.id,
            )
            const awaitingCanonical = isChatAwaitingGenerationCanonical(
                character.chaId,
                remoteChat.id,
            )
            const acceptsTargetedCanonical = generationProjectionActive
                ? canApplyChatGenerationCanonical(
                    character.chaId,
                    remoteChat.id,
                    terminalCanonicalChats.has(chatKey),
                )
                : !localDirty
            const shouldHydrate = (
                changedChats.has(chatKey) && acceptsTargetedCanonical
            ) || (refreshAllChats && localChat && !localChat._placeholder)

            if (shouldHydrate) {
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

    await applySyncedDatabase(remote, forageStorage.getDbEtag(), {
        authoritativeChatReset: refreshAllChats,
        serverAppliedChats,
    })
}
