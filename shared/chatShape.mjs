import persistenceShape from './persistenceShape.json' with { type: 'json' }

export const chatMetadataFields = persistenceShape.chatMetadataFields
export const runtimeOnlyChatFields = persistenceShape.runtimeOnlyChatFields
export const optionalChatMetadataFields = chatMetadataFields.filter(field => field !== 'id' && field !== 'name')

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
