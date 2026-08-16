import type { Chat } from './database.svelte'

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

const dirtyChats = new Map<string, DirtyChat>()
const serverAppliedChats = new WeakMap<object, Chat>()
const serverProjections = new Map<string, ServerProjection>()
let nextRevision = 1

function workingCopyKey(characterId: string, chatId: string) {
    return `${characterId}\u0000${chatId}`
}

function cloneChat<T>(value: T): T {
    try {
        return structuredClone(value)
    } catch {
        return JSON.parse(JSON.stringify(value)) as T
    }
}

function deepEqual(left: unknown, right: unknown): boolean {
    if (left === right) return true
    if (left === null || right === null || typeof left !== typeof right) return false
    if (Array.isArray(left) || Array.isArray(right)) {
        if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
        return left.every((value, index) => deepEqual(value, right[index]))
    }
    if (typeof left === 'object' && typeof right === 'object') {
        const leftRecord = left as Record<string, unknown>
        const rightRecord = right as Record<string, unknown>
        const leftKeys = Object.keys(leftRecord)
        const rightKeys = Object.keys(rightRecord)
        return leftKeys.length === rightKeys.length
            && leftKeys.every(key => Object.prototype.hasOwnProperty.call(rightRecord, key)
                && deepEqual(leftRecord[key], rightRecord[key]))
    }
    return false
}

function userOwnedProjectionView(chat: Chat, ownedMessageIds: Set<string>) {
    const view = cloneChat(chat)
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

/**
 * Register the one message range owned by a generation. Everything outside
 * this projection remains an ordinary editable working copy.
 */
export function beginChatGenerationProjection(
    characterId: string,
    baseChat: Chat,
    operation: ChatGenerationProjection,
) {
    if (!baseChat.id || !operation.messageChatId) return
    const key = workingCopyKey(characterId, baseChat.id)
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
        baseChat: cloneChat(baseChat),
        baseUserOwnedView: userOwnedProjectionView(baseChat, ownedMessageIds),
        userOwnedView: userOwnedProjectionView(baseChat, ownedMessageIds),
        awaitingCanonical: false,
    })
}

/** Classify a reactive chat mutation against the active target ownership. */
export function observeChatGenerationProjection(
    characterId: string,
    chat: Chat,
): ChatProjectionObservation {
    if (!chat.id) return 'inactive'
    const projection = serverProjections.get(workingCopyKey(characterId, chat.id))
    if (!projection) return 'inactive'
    const nextView = userOwnedProjectionView(chat, projection.ownedMessageIds)
    if (deepEqual(nextView, projection.userOwnedView)) return 'projection'
    projection.userOwnedView = nextView
    return 'edit'
}

export function endChatGenerationProjection(characterId: string, chatId: string) {
    serverProjections.delete(workingCopyKey(characterId, chatId))
}

/** Keep terminal UI cleanup projection-owned until the canonical fetch lands. */
export function awaitChatGenerationCanonical(characterId: string, chatId: string) {
    const projection = serverProjections.get(workingCopyKey(characterId, chatId))
    if (projection) projection.awaitingCanonical = true
}

export function isChatAwaitingGenerationCanonical(characterId: string, chatId: string) {
    return serverProjections.get(workingCopyKey(characterId, chatId))?.awaitingCanonical === true
}

/**
 * A CAS conflict caused solely by the live/cleanup projection is not a failed
 * user save. Drop that false dirty marker and let canonical sync own the
 * target; real edits outside the owned range still return false and retry.
 */
export function acknowledgeProjectionOnlyChatConflict(
    characterId: string,
    chat: Chat,
) {
    const key = workingCopyKey(characterId, chat.id)
    const projection = serverProjections.get(key)
    if (!projection) return false
    const hasLocalEdits = !deepEqual(
        userOwnedProjectionView(chat, projection.ownedMessageIds),
        projection.baseUserOwnedView,
    )
    if (hasLocalEdits) return false
    dirtyChats.delete(key)
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
            messages.splice(anchor + 1, 0, cloneChat(message))
            return
        }
    }
    for (let index = localIndex + 1; index < localMessages.length; index++) {
        const anchor = messageIndexById(messages, localMessages[index]?.chatId)
        if (anchor >= 0) {
            messages.splice(anchor, 0, cloneChat(message))
            return
        }
    }
    messages.push(cloneChat(message))
}

/**
 * Complete the generation ownership handoff. The server-owned response range
 * always comes from the fetched canonical chat; only real edits outside that
 * range are replayed from the local working copy.
 */
export function resolveChatGenerationCanonical(
    characterId: string,
    localChat: Chat,
    canonicalChat: Chat,
    canonicalEtag?: string,
): Chat {
    const key = workingCopyKey(characterId, canonicalChat.id)
    const projection = serverProjections.get(key)
    if (!projection?.awaitingCanonical || localChat.id !== canonicalChat.id) {
        return canonicalChat
    }

    const hasLocalEdits = !deepEqual(
        userOwnedProjectionView(localChat, projection.ownedMessageIds),
        projection.baseUserOwnedView,
    )
    const merged = cloneChat(canonicalChat)

    if (hasLocalEdits) {
        const base = projection.baseChat as Chat & Record<string, unknown>
        const local = localChat as Chat & Record<string, unknown>
        const output = merged as Chat & Record<string, unknown>
        const keys = new Set([...Object.keys(base), ...Object.keys(local)])
        keys.delete('message')
        keys.delete('isStreaming')
        keys.delete('_placeholder')
        for (const field of keys) {
            if (deepEqual(base[field], local[field])) continue
            if (Object.prototype.hasOwnProperty.call(local, field)) {
                output[field] = cloneChat(local[field])
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
            if (deepEqual(before, after)) continue
            const currentIndex = messageIndexById(mergedMessages, before.chatId)
            if (!after) {
                if (currentIndex >= 0) mergedMessages.splice(currentIndex, 1)
            } else if (currentIndex >= 0) {
                mergedMessages[currentIndex] = cloneChat(after)
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
    const dirty = dirtyChats.get(key)
    if (hasLocalEdits && dirty) {
        dirtyChats.set(key, { ...dirty, baseEtag: canonicalEtag })
    } else if (!hasLocalEdits) {
        dirtyChats.delete(key)
    }
    return merged
}

/**
 * Mark a chat body as locally modified. The first mutation pins the server
 * version that this working copy was based on; later sync fetches must not
 * move that boundary underneath the local body.
 */
export function markChatWorkingCopyDirty(
    characterId: string,
    chatId: string,
    currentServerEtag?: string,
) {
    if (!characterId || !chatId) return
    const key = workingCopyKey(characterId, chatId)
    const existing = dirtyChats.get(key)
    dirtyChats.set(key, {
        characterId,
        chatId,
        baseEtag: existing ? existing.baseEtag : currentServerEtag,
        revision: nextRevision++,
    })
}

export function isChatWorkingCopyDirty(characterId: string, chatId: string) {
    return dirtyChats.has(workingCopyKey(characterId, chatId))
}

export function listDirtyChatWorkingCopies(): ChatWorkingCopyTarget[] {
    return [...dirtyChats.values()].map(({ characterId, chatId }) => ({
        characterId,
        chatId,
    }))
}

/** Register a chat object that was actually fetched/materialized by the server. */
export function markChatServerApplied(characterId: string, chat: Chat) {
    const projectionKey = workingCopyKey(characterId, chat.id)
    if (serverProjections.get(projectionKey)?.awaitingCanonical) {
        serverProjections.delete(projectionKey)
    }
    serverAppliedChats.set(chat, cloneChat(chat))
}

/**
 * Ignore any number of reactive passes while the concrete object still
 * matches the server-applied snapshot. The first real user mutation removes
 * the marker and resumes ordinary dirty tracking.
 */
export function consumeServerAppliedChat(chat: Chat) {
    const snapshot = serverAppliedChats.get(chat)
    if (!snapshot) return false
    if (deepEqual(snapshot, chat)) return true
    serverAppliedChats.delete(chat)
    return false
}

/** Bind a payload and its compare-and-swap base into one immutable commit. */
export function createChatCommitSnapshot(
    characterId: string,
    chat: Chat,
    currentServerEtag?: string,
): ChatCommitSnapshot {
    const dirty = dirtyChats.get(workingCopyKey(characterId, chat.id))
    return {
        characterId,
        chatId: chat.id,
        chat: cloneChat(chat),
        expectedEtag: dirty ? dirty.baseEtag : currentServerEtag,
        ...(dirty ? { revision: dirty.revision } : {}),
    }
}

/**
 * A save only cleans the working copy it actually committed. If the user
 * edited again while the request was in flight, the newer revision remains.
 */
export function acknowledgeChatCommit(snapshot: ChatCommitSnapshot, committedEtag?: string) {
    if (snapshot.revision == null) return
    const key = workingCopyKey(snapshot.characterId, snapshot.chatId)
    const current = dirtyChats.get(key)
    if (current?.revision === snapshot.revision) {
        dirtyChats.delete(key)
    } else if (current && committedEtag) {
        // A newer local edit was made while this commit was in flight. Keep it
        // dirty, but advance its CAS base to the version just accepted.
        dirtyChats.set(key, { ...current, baseEtag: committedEtag })
    }
}

/** Snapshot restore is the sole authoritative operation that discards locals. */
export function discardAllChatWorkingCopies() {
    dirtyChats.clear()
    serverProjections.clear()
}
