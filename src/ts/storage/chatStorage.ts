import { forageStorage } from "./autoStorage"
import type { Chat, ChatStub, ChatOrStub } from "./database.svelte"
import { isChatStub } from "./chatStub"
import { tick } from "svelte"
import { writable, type Readable } from 'svelte/store'
import { DeltaSave } from './deltaSave'
import { chatToStub as toChatStub, optionalChatMetadataFields, chatMetadataFields, runtimeOnlyChatFields } from '../../../shared/chatShape.mjs'
import { ConflictError } from './storageRequest'
import { chooseSaveConflict } from './saveConflict'
import {
    acknowledgeChatCommit,
    createChatCommitSnapshot as createWorkingCopyCommitSnapshot,
    isChatWorkingCopyDirty,
    getChatServerState,
    recordChatServerState,
    shouldPersistTrackedChat,
    markChatWorkingCopyDirty,
    rebaseChatWorkingCopy,
    type ChatCommitSnapshot,
} from './chatWorkingCopy'

/** Keep explicit metadata clears while marking a missing body for hydration. */
export function stubToPlaceholder(stub: ChatStub): Chat {
    const placeholder: Chat = {
        message: [],
        note: '',
        name: stub.name,
        localLore: [],
        id: stub.id,
        fmIndex: -1,
        _placeholder: true,
    }
    for (const field of optionalChatMetadataFields) {
        if (field in stub) placeholder[field] = stub[field]
    }
    return placeholder
}

/** Preserve omitted versus explicitly cleared metadata when encoding a stub. */
export function chatToStub(chat: Chat | ChatStub): ChatStub {
    return toChatStub(chat) as ChatStub
}

/** Keep a hydrated body while adopting the complete merged list metadata. */
export function mergeHydratedChatWithMetadata(chat: Chat, metadata: Chat | ChatStub): Chat {
    const merged = { ...chat } as Record<string, any>
    for (const key of Object.keys(chatToStub(chat))) delete merged[key]
    Object.assign(merged, chatToStub(metadata))
    delete merged._stub
    delete merged._placeholder
    return merged as Chat
}

/** Keep full messages even if a malformed chat also carries the stub flag. */
export function convertStubsToPlaceholders(chats: ChatOrStub[]): Chat[] {
    return chats.map(c => {
        if (!c) return c as Chat
        if ((c as any)._stub === true && Array.isArray((c as any).message)) {
            const { _stub: _drop, ...rest } = c as any
            return rest as Chat
        }
        return isChatStub(c) ? stubToPlaceholder(c) : (c as Chat)
    })
}

export type ChatShape = 'stub' | 'placeholder' | 'hybrid' | 'full' | 'empty' | 'neither'

export function classifyChat(c: any): ChatShape {
    if (!c) return 'empty'
    const isStub = c._stub === true
    const isPh = c._placeholder === true
    const hasMessage = Array.isArray(c.message)
    if (isStub && hasMessage) return 'hybrid'
    if (isStub) return 'stub'
    if (isPh) return 'placeholder'
    if (hasMessage) return 'full'
    return 'neither'
}


function chatKey(chaId: string, chatId: string): string {
    return `${chaId}/${chatId}`
}

export type ChatHydrationFailure = 'missing' | 'error'

const chatHydrationFailureStore = writable<ReadonlyMap<string, ChatHydrationFailure>>(new Map())

/** Transient hydration failures, kept in this client only. */
export const chatHydrationFailures: Readable<ReadonlyMap<string, ChatHydrationFailure>> = chatHydrationFailureStore

export function chatHydrationKey(chaId: string, chatId: string): string {
    return chatKey(chaId, chatId)
}

function setChatHydrationFailure(key: string, failure: ChatHydrationFailure | null): void {
    chatHydrationFailureStore.update(current => {
        if ((current.get(key) ?? null) === failure) return current
        const next = new Map(current)
        if (failure) next.set(key, failure)
        else next.delete(key)
        return next
    })
}

/** Hydration in progress, through the Svelte update after apply — suppress dirty tracking */
const hydrationInFlight = new Set<string>()

/** Track in-flight hydration promises to avoid duplicate fetches */
const hydrationPromises = new Map<string, Promise<Chat | null>>()
export type FetchedChatState = {
    etag?: string
    isCurrent: () => boolean
}

const fetchedChats = new WeakMap<Chat, FetchedChatState>()
const chatSaveQueues = new Map<string, Promise<void>>()
const chatDeltaSaves = new Map<string, DeltaSave<ChatCommitSnapshot, { etag: string }>>()

function chatDeltaSave(chaId: string, chatIndex: number, chatId: string) {
    const key = chatKey(chaId, chatId)
    let save = chatDeltaSaves.get(key)
    if (!save) {
        save = new DeltaSave(
            request => forageStorage.realStorage.patchChatContent(chaId, chatIndex, chatId, request),
            (snapshot, result) => acknowledgeChatCommit(snapshot, result.etag),
        )
        chatDeltaSaves.set(key, save)
    }
    return save
}

export function discardPendingChatSaves() {
    for (const save of chatDeltaSaves.values()) save.clear()
    chatDeltaSaves.clear()
}


async function queueChatSave(key: string, save: () => Promise<void>) {
    const previous = chatSaveQueues.get(key)
    const queued = (previous ? previous.catch(() => {}) : Promise.resolve()).then(save)
    chatSaveQueues.set(key, queued)
    try { await queued }
    finally {
        if (chatSaveQueues.get(key) === queued) {
            chatSaveQueues.delete(key)
            if (!chatDeltaSaves.get(key)?.hasPending) chatDeltaSaves.delete(key)
        }
    }
}

export async function fetchChatFromServer(
    chaId: string, chatIndex: number, chatId: string, options?: { trackBaseline?: boolean },
): Promise<Chat | null> {
    let baseline = getChatServerState(chaId, chatId)
    const state = await forageStorage.realStorage.fetchChatState(chaId, chatIndex, chatId)
    if (state) {
        // Keep a newer baseline accepted from a save or another read.
        if (options?.trackBaseline !== false && baseline === getChatServerState(chaId, chatId)) {
            baseline = recordChatServerState(chaId, state.baseline ?? state.chat, state.etag)
        }
        fetchedChats.set(state.chat, {
            etag: state.etag,
            isCurrent: () => baseline === getChatServerState(chaId, chatId),
        })
    }
    return state?.chat ?? null
}

export function getFetchedChatState(chat: Chat) { return fetchedChats.get(chat) }

export async function saveChatToServer(
    chaId: string,
    chatIndex: number,
    chatId: string,
    chat: Chat,
    options?: { getChat?: () => Chat | undefined, tracked?: boolean },
): Promise<void> {
    if (chat.id !== chatId) {
        throw new Error('Chat save target does not match the payload id')
    }
    const key = chatKey(chaId, chatId)
    await queueChatSave(key, async () => {
        const getChat = options?.getChat ?? (() => chat)
        while (true) {
            const current = getChat()
            if (!current || current._placeholder) return
            try {
                await chatDeltaSave(chaId, chatIndex, chatId).flush()
                // Re-read live edits and the accepted baseline after earlier writes settle.
                const latest = getChat()
                if (!latest || latest._placeholder) return
                if (latest.id !== chatId) throw new Error('Chat save target does not match the payload id')
                if (options?.tracked && !shouldPersistTrackedChat(chaId, latest)) return
                await saveChatCommitToServer(chatIndex, createChatCommitSnapshot(chaId, latest))
                return
            } catch (error) {
                if (!(error instanceof ConflictError)) throw error
                const local = getChat()
                if (!local || local._placeholder) throw error
                const snapshot = createChatCommitSnapshot(chaId, local)
                const fetched = await forageStorage.realStorage.fetchChatState(chaId, chatIndex, chatId)
                if (!fetched) throw error
                const canonical = fetched.baseline ?? fetched.chat
                const resolved = await chooseSaveConflict(snapshot.baseChat, snapshot.changes, canonical, local.name)
                const live = getChat()
                if (!live || live._placeholder) return
                recordChatServerState(chaId, canonical, fetched.etag)
                rebaseChatWorkingCopy(chaId, chatId, fetched.etag)
                const excluded = new Set([...chatMetadataFields, ...runtimeOnlyChatFields])
                for (const field of new Set([...Object.keys(live), ...Object.keys(resolved)])) {
                    if (excluded.has(field)) continue
                    if (Object.hasOwn(resolved, field)) live[field] = resolved[field]
                    else delete live[field]
                }
                markChatWorkingCopyDirty(chaId, chatId, fetched.etag)
                await tick()
            }
        }
    })
}

/**
 * Settle a pending user edit before generation replaces the live chat with a
 * temporary reroll projection. This is a no-op for an already-clean chat.
 */
export async function flushDirtyChatToServer(
    chaId: string,
    chatIndex: number,
    chat: Chat,
): Promise<boolean> {
    if (!isChatWorkingCopyDirty(chaId, chat.id)) return false
    await saveChatToServer(chaId, chatIndex, chat.id, chat)
    return true
}

export function createChatCommitSnapshot(chaId: string, chat: Chat): ChatCommitSnapshot {
    return createWorkingCopyCommitSnapshot(chaId, chat, getChatServerEtag(chaId, chat.id))
}

async function saveChatCommitToServer(
    chatIndex: number,
    snapshot: ChatCommitSnapshot,
): Promise<void> {
    if (!snapshot.changes) throw new Error('Chat commit has no delta baseline')
    if (snapshot.changes.length === 0) {
        acknowledgeChatCommit(snapshot, snapshot.expectedEtag)
        return
    }
    await chatDeltaSave(snapshot.characterId, chatIndex, snapshot.chatId)
        .save({ changes: snapshot.changes }, snapshot)
}

export function getChatServerEtag(chaId: string, chatId: string): string | undefined {
    return forageStorage.realStorage.getChatEtag(chaId, chatId)
}

export function setChatServerEtag(chaId: string, chatId: string, etag: string): void {
    forageStorage.realStorage.setChatEtag(chaId, chatId, etag)
}


/**
 * Check if a specific chat is currently being hydrated (for dirty tracking suppression).
 */
export function isHydrating(chaId: string, chatId: string): boolean {
    return hydrationInFlight.has(chatKey(chaId, chatId))
}

/** Character fields hydration needs; `chats` is re-read because callers may replace the array. */
type ChatOwner = { chaId: string, chats: Chat[] }

/**
 * Hydrate a placeholder Chat in-place on the character's chats array.
 * If the slot is already a real Chat (not placeholder), returns it as-is.
 * Returns the hydrated Chat, or null if its body is missing.
 */
export async function ensureChatHydrated(
    character: ChatOwner,
    index: number,
): Promise<Chat | null> {
    const { chaId } = character
    const slot = character.chats[index]
    if (!slot) return null
    if (!slot._placeholder) return slot

    const chatId = slot.id
    if (!chatId) return null
    const key = chatKey(chaId, chatId)

    // Deduplicate concurrent hydration for the same chat
    const existing = hydrationPromises.get(key)
    if (existing) return existing

    // Starting a new attempt returns the UI to its loading state.
    setChatHydrationFailure(key, null)

    const promise = (async () => {
        hydrationInFlight.add(key)
        try {
            const full = await fetchChatFromServer(chaId, index, chatId).catch(error => {
                setChatHydrationFailure(key, 'error')
                throw error
            })
            if (!full) {
                setChatHydrationFailure(key, 'missing')
                console.error(`[chatStorage] hydrate failed: chat not found on server (${key})`)
                return null
            }

            // Schedule the large chat update for the next animation frame.
            await new Promise<void>(r => requestAnimationFrame(() => r()))

            // Resolve against the live array: deleting or moving a chat replaces it.
            const chats = character.chats
            const currentIndex = chats.findIndex(chat => chat?.id === chatId)
            if (currentIndex === -1) {
                console.warn(`[chatStorage] hydrate skipped: chat removed before apply (${key})`)
                return null
            }

            const currentSlot = chats[currentIndex]
            if (!currentSlot?._placeholder) {
                return currentSlot
            }

            chats[currentIndex] = full

            // Keep suppression through Svelte's next update.
            await tick()
            return full
        } finally {
            hydrationInFlight.delete(key)
            hydrationPromises.delete(key)
        }
    })()

    hydrationPromises.set(key, promise)
    return promise
}
