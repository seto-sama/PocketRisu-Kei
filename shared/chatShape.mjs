import persistenceShape from './persistenceShape.json' with { type: 'json' }
import { assertUniqueEntityIds, EntityIdValidationError } from './entityIds.mjs'

export const chatMetadataFields = persistenceShape.chatMetadataFields
export const runtimeOnlyChatFields = persistenceShape.runtimeOnlyChatFields
export const optionalChatMetadataFields = chatMetadataFields.filter(field => field !== 'id' && field !== 'name')

export function assertChatIdentity(chat, chatId) {
    if (!chat || chat.id !== chatId || !Array.isArray(chat.message)) {
        throw new EntityIdValidationError('Chat must preserve its id and message list')
    }
    assertUniqueEntityIds(chat.message, 'chatId')
}

const CHAT_FIELD_PATH_RE = /^\/characters\/\d+\/chats\/\d+\/([^/]+)/

/**
 * A database patch may touch only list metadata on a `chats[i]` field; chat
 * bodies are written through the chat endpoint. Whole-slot ops carry no field
 * and pass. `from` is checked too, so move/copy cannot alias a body field.
 */
export function findChatInternalFieldOps(patch) {
    if (!Array.isArray(patch)) return []
    const violations = []
    for (const op of patch) {
        if (!op || typeof op !== 'object') continue
        for (const pointer of [op.path, op.from]) {
            const field = typeof pointer === 'string' ? pointer.match(CHAT_FIELD_PATH_RE)?.[1] : undefined
            if (field !== undefined && !chatMetadataFields.includes(field)) {
                violations.push({ op: op.op, path: op.path, field })
                break
            }
        }
    }
    return violations
}

/** Preserve key presence so explicit clears survive the metadata round trip. */
export function chatToStub(chat) {
    if (!chat) return chat
    if (chat._stub === true && !Array.isArray(chat.message)) return chat
    const stub = { id: chat.id ?? '', name: chat.name ?? '', _stub: true }
    for (const field of optionalChatMetadataFields) {
        if (field in chat) stub[field] = chat[field]
    }
    return stub
}
