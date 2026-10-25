import type { Chat } from './database.svelte'
import { createDelta, valuesEqual as chatValuesEqual } from '../../../shared/guardedDelta.mjs'
import { reconcilePendingChanges } from './patchRebase'
import { chatMetadataFields, runtimeOnlyChatFields } from '../../../shared/chatShape.mjs'
export { valuesEqual as chatValuesEqual } from '../../../shared/guardedDelta.mjs'

export function cloneChatValue<T>(value: T): T {
    try {
        return structuredClone(value)
    } catch {
        return JSON.parse(JSON.stringify(value)) as T
    }
}

export type ChatWorkingCopyTarget = {
    characterId: string
    chatId: string
}

export type ChatCommitSnapshot = ChatWorkingCopyTarget & {
    chat: Chat
    baseChat?: Chat
    expectedEtag?: string
    revision?: number
    changes: ReturnType<typeof createDelta>
}

type DirtyChat = ChatWorkingCopyTarget & {
    baseEtag?: string
    revision: number
    baseChat?: Chat
}

const dirtyChats = new Map<string, DirtyChat>()
const serverChats = new Map<string, { chat: Chat, etag?: string }>()
const syncAppliedChats = new WeakMap<object, Chat>()
let nextRevision = 1

function chatWorkingCopyKey(characterId: string, chatId: string) {
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
    const server = serverChats.get(key)
    dirtyChats.set(key, {
        characterId,
        chatId,
        baseEtag: existing ? existing.baseEtag : server?.etag ?? currentServerEtag,
        revision: nextRevision++,
        baseChat: existing ? existing.baseChat : server?.chat,
    })
}

export function isChatWorkingCopyDirty(characterId: string, chatId: string) {
    return dirtyChats.has(chatWorkingCopyKey(characterId, chatId))
}

/**
 * A clean streaming body is a server-owned display projection, not a user
 * edit. A dirty streaming body may still contain edits outside the generated
 * message range and must continue through the canonical merge boundary.
 */
export function shouldPersistTrackedChat(characterId: string, chat: Chat) {
    return chat.isStreaming !== true || isChatWorkingCopyDirty(characterId, chat.id)
}

export function listDirtyChatWorkingCopies(): ChatWorkingCopyTarget[] {
    return [...dirtyChats.values()].map(({ characterId, chatId }) => ({
        characterId,
        chatId,
    }))
}

/** Capture an edit and its pre-edit values together after queue admission. */
export function createChatCommitSnapshot(
    characterId: string,
    chat: Chat,
    currentServerEtag?: string,
): ChatCommitSnapshot {
    const key = chatWorkingCopyKey(characterId, chat.id)
    const dirty = dirtyChats.get(key)
    const server = serverChats.get(key)
    const base = dirty ? dirty.baseChat : server?.chat
    const baseChat = base ? JSON.parse(JSON.stringify(base)) as Chat : undefined
    const edited = JSON.parse(JSON.stringify(chat)) as Chat
    for (const field of runtimeOnlyChatFields) delete (edited as any)[field]
    return {
        characterId,
        chatId: chat.id,
        chat: cloneChatValue(chat),
        baseChat,
        expectedEtag: dirty ? dirty.baseEtag : server?.etag ?? currentServerEtag,
        ...(dirty ? { revision: dirty.revision } : {}),
        changes: createDelta(baseChat, edited, {
            ignoredRootKeys: [...runtimeOnlyChatFields, ...(baseChat ? chatMetadataFields : [])],
            ignoredMessageIds: [...(serverProjections.get(key)?.ownedMessageIds ?? [])],
        }),
    }
}

/** Only the exact revision accepted by the server becomes clean. */
export function acknowledgeChatCommit(snapshot: ChatCommitSnapshot, committedEtag?: string) {
    recordChatServerState(snapshot.characterId, snapshot.chat, committedEtag)
    if (snapshot.revision == null) return
    const key = chatWorkingCopyKey(snapshot.characterId, snapshot.chatId)
    const current = dirtyChats.get(key)
    if (current?.revision === snapshot.revision) {
        dirtyChats.delete(key)
    } else if (current && committedEtag) {
        dirtyChats.set(key, { ...current, baseEtag: committedEtag, baseChat: cloneChatValue(snapshot.chat) })
    }
}

/** Used by canonical handoff after generation-owned fields are excluded. */
function clearChatWorkingCopy(characterId: string, chatId: string) {
    dirtyChats.delete(chatWorkingCopyKey(characterId, chatId))
}

/** Advance a still-dirty local copy onto a freshly fetched canonical base. */
export function rebaseChatWorkingCopy(characterId: string, chatId: string, baseEtag?: string) {
    const key = chatWorkingCopyKey(characterId, chatId)
    const dirty = dirtyChats.get(key)
    const server = serverChats.get(key)
    if (dirty) dirtyChats.set(key, {
        ...dirty, baseEtag,
        baseChat: server?.etag === baseEtag ? server.chat : dirty.baseChat,
    })
}

/** Keep the accepted body used to derive the next set of changes. */
export function recordChatServerState(characterId: string, chat: Chat, etag?: string) {
    const key = chatWorkingCopyKey(characterId, chat.id)
    const state = { chat: cloneChatValue(chat), etag }
    serverChats.set(key, state)
    return state
}

export function getChatServerState(characterId: string, chatId: string) {
    return serverChats.get(chatWorkingCopyKey(characterId, chatId))
}

export function reconcileChatWorkingCopy(characterId: string, local: Chat, canonical: Chat, etag?: string): Chat {
    const key = chatWorkingCopyKey(characterId, local.id)
    const dirty = dirtyChats.get(key)
    if (!dirty?.baseChat) return dirty ? local : canonical
    const { mergedValue, baseline } = reconcilePendingChanges(
        dirty.baseChat, JSON.parse(JSON.stringify(local)), canonical, true,
    )
    dirtyChats.set(key, { ...dirty, baseChat: baseline, baseEtag: etag })
    return mergedValue
}

/** Release baselines for chats that are no longer hydrated in this page. */
export function pruneChatServerStates(hydratedTargets: ChatWorkingCopyTarget[]) {
    const retained = new Set(hydratedTargets.map(target => chatWorkingCopyKey(target.characterId, target.chatId)))
    for (const key of serverChats.keys()) {
        if (!retained.has(key) && !dirtyChats.has(key)) serverChats.delete(key)
    }
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
    const ownedMessageIds = new Set([
        operation.messageChatId,
        operation.rerollSnapshot?.targetMessage?.chatId,
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

export function isChatGenerationProjectionActive(characterId: string, chatId: string) {
    return serverProjections.has(chatWorkingCopyKey(characterId, chatId))
}

/** Active display ownership yields only to an explicitly terminal snapshot. */
export function canApplyChatGenerationCanonical(
    characterId: string,
    chatId: string,
    terminalCanonical: boolean,
) {
    const projection = serverProjections.get(chatWorkingCopyKey(characterId, chatId))
    return !projection || (projection.awaitingCanonical && terminalCanonical)
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
    serverProjections.delete(key)
    if (!hasLocalEdits) {
        clearChatWorkingCopy(characterId, canonicalChat.id)
        return canonicalChat
    }

    const dirty = dirtyChats.get(key)
    const { mergedValue, baseline } = reconcilePendingChanges(
        userOwnedProjectionView(dirty?.baseChat ?? projection.baseChat, projection.ownedMessageIds),
        userOwnedProjectionView(localChat, projection.ownedMessageIds),
        canonicalChat,
        true,
    )
    if (dirty) dirtyChats.set(key, { ...dirty, baseChat: baseline as Chat, baseEtag: canonicalEtag })
    return mergedValue as Chat
}
