import type { Chat } from './database.svelte'

export function cloneChatValue<T>(value: T): T {
    try {
        return structuredClone(value)
    } catch {
        return JSON.parse(JSON.stringify(value)) as T
    }
}

export function chatValuesEqual(left: unknown, right: unknown): boolean {
    if (left === right) return true
    if (left === null || right === null || typeof left !== typeof right) return false
    if (Array.isArray(left) || Array.isArray(right)) {
        if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
        return left.every((value, index) => chatValuesEqual(value, right[index]))
    }
    if (typeof left === 'object' && typeof right === 'object') {
        const leftRecord = left as Record<string, unknown>
        const rightRecord = right as Record<string, unknown>
        const leftKeys = Object.keys(leftRecord)
        const rightKeys = Object.keys(rightRecord)
        return leftKeys.length === rightKeys.length
            && leftKeys.every(key => Object.prototype.hasOwnProperty.call(rightRecord, key)
                && chatValuesEqual(leftRecord[key], rightRecord[key]))
    }
    return false
}

export type ChatWorkingCopyTarget = {
    characterId: string
    chatId: string
}

export type ChatCommitSnapshot = ChatWorkingCopyTarget & {
    chat: Chat
    expectedEtag?: string
    revision?: number
}

type DirtyChat = ChatWorkingCopyTarget & {
    baseEtag?: string
    revision: number
}

const dirtyChats = new Map<string, DirtyChat>()
const syncAppliedChats = new WeakMap<object, Chat>()
let nextRevision = 1

export function chatWorkingCopyKey(characterId: string, chatId: string) {
    return `${characterId}\u0000${chatId}`
}

/** Pin the first server version on which a local edit was based. */
export function markChatWorkingCopyDirty(
    characterId: string,
    chatId: string,
    currentServerEtag?: string,
) {
    if (!characterId || !chatId) return
    const key = chatWorkingCopyKey(characterId, chatId)
    const existing = dirtyChats.get(key)
    dirtyChats.set(key, {
        characterId,
        chatId,
        baseEtag: existing ? existing.baseEtag : currentServerEtag,
        revision: nextRevision++,
    })
}

export function isChatWorkingCopyDirty(characterId: string, chatId: string) {
    return dirtyChats.has(chatWorkingCopyKey(characterId, chatId))
}

export function listDirtyChatWorkingCopies(): ChatWorkingCopyTarget[] {
    return [...dirtyChats.values()].map(({ characterId, chatId }) => ({
        characterId,
        chatId,
    }))
}

/** Bind a payload and its compare-and-swap base into one immutable commit. */
export function createChatCommitSnapshot(
    characterId: string,
    chat: Chat,
    currentServerEtag?: string,
): ChatCommitSnapshot {
    const dirty = dirtyChats.get(chatWorkingCopyKey(characterId, chat.id))
    return {
        characterId,
        chatId: chat.id,
        chat: cloneChatValue(chat),
        expectedEtag: dirty ? dirty.baseEtag : currentServerEtag,
        ...(dirty ? { revision: dirty.revision } : {}),
    }
}

/** Only the exact revision accepted by the server becomes clean. */
export function acknowledgeChatCommit(snapshot: ChatCommitSnapshot, committedEtag?: string) {
    if (snapshot.revision == null) return
    const key = chatWorkingCopyKey(snapshot.characterId, snapshot.chatId)
    const current = dirtyChats.get(key)
    if (current?.revision === snapshot.revision) {
        dirtyChats.delete(key)
    } else if (current && committedEtag) {
        dirtyChats.set(key, { ...current, baseEtag: committedEtag })
    }
}

/** Used by canonical handoff after generation-owned fields are excluded. */
export function clearChatWorkingCopy(characterId: string, chatId: string) {
    dirtyChats.delete(chatWorkingCopyKey(characterId, chatId))
}

/** Advance a still-dirty local copy onto a freshly fetched canonical base. */
export function rebaseChatWorkingCopy(characterId: string, chatId: string, baseEtag?: string) {
    const key = chatWorkingCopyKey(characterId, chatId)
    const dirty = dirtyChats.get(key)
    if (dirty) dirtyChats.set(key, { ...dirty, baseEtag })
}

/** Snapshot restore is the authoritative operation that discards local edits. */
export function discardAllChatWorkingCopies() {
    dirtyChats.clear()
}

/** Register a concrete object installed from a canonical server fetch. */
export function markChatSyncApplied(chat: Chat) {
    syncAppliedChats.set(chat, cloneChatValue(chat))
}

/** Suppress reactive passes until the canonical object is actually edited. */
export function consumeChatSyncApplied(chat: Chat) {
    const snapshot = syncAppliedChats.get(chat)
    if (!snapshot) return false
    if (chatValuesEqual(snapshot, chat)) return true
    syncAppliedChats.delete(chat)
    return false
}

export type ChatGenerationProjection = {
    messageChatId: string
    isContinuation?: boolean
    rerollSnapshot?: {
        targetMessage?: { chatId?: string }
        trailingMessages?: Array<{ chatId?: string }>
    }
}

export type ChatProjectionObservation = 'inactive' | 'projection' | 'edit'

type ServerProjection = {
    messageChatId: string
    ownedMessageIds: Set<string>
    baseChat: Chat
    baseUserOwnedView: unknown
    userOwnedView: unknown
    awaitingCanonical: boolean
}

const serverProjections = new Map<string, ServerProjection>()

function userOwnedProjectionView(chat: Chat, ownedMessageIds: Set<string>) {
    const view = cloneChatValue(chat)
    delete view.isStreaming
    delete view._placeholder
    view.message = (view.message ?? [])
        .filter(message => !message.chatId || !ownedMessageIds.has(message.chatId))
        .map(message => {
            delete message.isRecovering
            delete message.recoveryDisplayData
            return message
        })
    return view
}

/** Start tracking the server-owned message range for one generation. */
export function beginChatGenerationProjection(
    characterId: string,
    baseChat: Chat,
    operation: ChatGenerationProjection,
) {
    if (!baseChat.id || !operation.messageChatId) return
    const key = chatWorkingCopyKey(characterId, baseChat.id)
    const existing = serverProjections.get(key)
    if (existing?.messageChatId === operation.messageChatId) return
    const continuationTarget = operation.isContinuation
        ? [...baseChat.message].reverse().find(message => message?.role === 'char')
        : undefined
    const ownedMessageIds = new Set([
        operation.messageChatId,
        operation.rerollSnapshot?.targetMessage?.chatId,
        continuationTarget?.chatId,
        ...(operation.rerollSnapshot?.trailingMessages ?? []).map(message => message?.chatId),
    ].filter((id): id is string => !!id))
    serverProjections.set(key, {
        messageChatId: operation.messageChatId,
        ownedMessageIds,
        baseChat: cloneChatValue(baseChat),
        baseUserOwnedView: userOwnedProjectionView(baseChat, ownedMessageIds),
        userOwnedView: userOwnedProjectionView(baseChat, ownedMessageIds),
        awaitingCanonical: false,
    })
}

export function observeChatGenerationProjection(
    characterId: string,
    chat: Chat,
): ChatProjectionObservation {
    if (!chat.id) return 'inactive'
    const projection = serverProjections.get(chatWorkingCopyKey(characterId, chat.id))
    if (!projection) return 'inactive'
    const nextView = userOwnedProjectionView(chat, projection.ownedMessageIds)
    if (chatValuesEqual(nextView, projection.userOwnedView)) return 'projection'
    projection.userOwnedView = nextView
    return 'edit'
}

export function endChatGenerationProjection(characterId: string, chatId: string) {
    serverProjections.delete(chatWorkingCopyKey(characterId, chatId))
}

export function discardAllChatGenerationProjections() {
    serverProjections.clear()
}

export function awaitChatGenerationCanonical(characterId: string, chatId: string) {
    const projection = serverProjections.get(chatWorkingCopyKey(characterId, chatId))
    if (projection) projection.awaitingCanonical = true
}

export function isChatAwaitingGenerationCanonical(characterId: string, chatId: string) {
    return serverProjections.get(chatWorkingCopyKey(characterId, chatId))?.awaitingCanonical === true
}

export function acknowledgeProjectionOnlyChatConflict(characterId: string, chat: Chat) {
    const projection = serverProjections.get(chatWorkingCopyKey(characterId, chat.id))
    if (!projection) return false
    const hasLocalEdits = !chatValuesEqual(
        userOwnedProjectionView(chat, projection.ownedMessageIds),
        projection.baseUserOwnedView,
    )
    if (hasLocalEdits) return false
    clearChatWorkingCopy(characterId, chat.id)
    return true
}

function messageIndexById(messages: Chat['message'], chatId?: string) {
    if (!chatId) return -1
    return messages.findIndex(message => message?.chatId === chatId)
}

function insertByLocalOrder(
    messages: Chat['message'],
    localMessages: Chat['message'],
    localIndex: number,
    message: Chat['message'][number],
) {
    for (let index = localIndex - 1; index >= 0; index--) {
        const anchor = messageIndexById(messages, localMessages[index]?.chatId)
        if (anchor >= 0) {
            messages.splice(anchor + 1, 0, cloneChatValue(message))
            return
        }
    }
    for (let index = localIndex + 1; index < localMessages.length; index++) {
        const anchor = messageIndexById(messages, localMessages[index]?.chatId)
        if (anchor >= 0) {
            messages.splice(anchor, 0, cloneChatValue(message))
            return
        }
    }
    messages.push(cloneChatValue(message))
}

/**
 * Install the canonical server-owned response range and replay only local
 * edits outside that range.
 */
export function resolveChatGenerationCanonical(
    characterId: string,
    localChat: Chat,
    canonicalChat: Chat,
    canonicalEtag?: string,
): Chat {
    const key = chatWorkingCopyKey(characterId, canonicalChat.id)
    const projection = serverProjections.get(key)
    if (!projection?.awaitingCanonical || localChat.id !== canonicalChat.id) {
        return canonicalChat
    }

    const hasLocalEdits = !chatValuesEqual(
        userOwnedProjectionView(localChat, projection.ownedMessageIds),
        projection.baseUserOwnedView,
    )
    const merged = cloneChatValue(canonicalChat)

    if (hasLocalEdits) {
        const base = projection.baseChat as Chat & Record<string, unknown>
        const local = localChat as Chat & Record<string, unknown>
        const output = merged as Chat & Record<string, unknown>
        const keys = new Set([...Object.keys(base), ...Object.keys(local)])
        keys.delete('message')
        keys.delete('isStreaming')
        keys.delete('_placeholder')
        for (const field of keys) {
            if (chatValuesEqual(base[field], local[field])) continue
            if (Object.prototype.hasOwnProperty.call(local, field)) {
                output[field] = cloneChatValue(local[field])
            } else {
                delete output[field]
            }
        }

        const baseMessages = base.message ?? []
        const localMessages = local.message ?? []
        const mergedMessages = merged.message ?? []
        const localById = new Map(localMessages
            .filter(message => message?.chatId)
            .map(message => [message.chatId, message] as const))
        const baseIds = new Set(baseMessages.map(message => message?.chatId).filter(Boolean))

        for (const before of baseMessages) {
            if (!before?.chatId || projection.ownedMessageIds.has(before.chatId)) continue
            const after = localById.get(before.chatId)
            if (chatValuesEqual(before, after)) continue
            const currentIndex = messageIndexById(mergedMessages, before.chatId)
            if (!after) {
                if (currentIndex >= 0) mergedMessages.splice(currentIndex, 1)
            } else if (currentIndex >= 0) {
                mergedMessages[currentIndex] = cloneChatValue(after)
            }
        }

        for (let index = 0; index < localMessages.length; index++) {
            const added = localMessages[index]
            if (
                !added?.chatId
                || baseIds.has(added.chatId)
                || projection.ownedMessageIds.has(added.chatId)
                || messageIndexById(mergedMessages, added.chatId) >= 0
            ) continue
            insertByLocalOrder(mergedMessages, localMessages, index, added)
        }
        merged.message = mergedMessages
    }

    serverProjections.delete(key)
    if (hasLocalEdits) rebaseChatWorkingCopy(characterId, canonicalChat.id, canonicalEtag)
    else clearChatWorkingCopy(characterId, canonicalChat.id)
    return merged
}
