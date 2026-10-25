import type { Database } from '../storage/database.svelte'

export interface RequestStatusChatTarget {
    characterId: string
    chatIndex: number
    messageIndex: number | null
}

export function findRequestStatusChatTarget(
    db: Database,
    requestChatId: string,
): RequestStatusChatTarget | null {
    let roomFallback: RequestStatusChatTarget | null = null

    for (const character of db.characters) {
        if (!character?.chaId || character.trashTime) continue
        const characterId = character.chaId
        for (let chatIndex = 0; chatIndex < character.chats.length; chatIndex++) {
            const chat = character.chats[chatIndex]
            if (!chat) continue

            if (chat._placeholder) {
                if (chat.id === requestChatId) {
                    roomFallback = { characterId, chatIndex, messageIndex: null }
                }
                continue
            }

            const messageIndex = chat.message.findIndex(message =>
                message?.chatId === requestChatId
                || message?.generationInfo?.generationId === requestChatId)
            if (messageIndex >= 0) {
                return { characterId, chatIndex, messageIndex }
            }

            if (chat.id === requestChatId) {
                let latestCharacterMessage = -1
                for (let index = chat.message.length - 1; index >= 0; index--) {
                    if (chat.message[index]?.role === 'char') {
                        latestCharacterMessage = index
                        break
                    }
                }
                roomFallback = {
                    characterId,
                    chatIndex,
                    messageIndex: latestCharacterMessage >= 0
                        ? latestCharacterMessage
                        : chat.message.length > 0 ? chat.message.length - 1 : null,
                }
            }
        }
    }

    return roomFallback
}
