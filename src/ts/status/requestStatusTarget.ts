import type { Database } from '../storage/database.svelte'

export interface RequestStatusChatTarget {
    characterIndex: number
    chatIndex: number
    messageIndex: number | null
}

export function findRequestStatusChatTarget(
    db: Database,
    requestChatId: string,
): RequestStatusChatTarget | null {
    let roomFallback: RequestStatusChatTarget | null = null

    for (let characterIndex = 0; characterIndex < db.characters.length; characterIndex++) {
        const character = db.characters[characterIndex]
        if (!character) continue
        for (let chatIndex = 0; chatIndex < character.chats.length; chatIndex++) {
            const chat = character.chats[chatIndex]
            if (!chat) continue

            if (chat._placeholder) {
                if (chat.id === requestChatId) {
                    roomFallback = { characterIndex, chatIndex, messageIndex: null }
                }
                continue
            }

            const messageIndex = chat.message.findIndex(message =>
                message?.chatId === requestChatId
                || message?.generationInfo?.generationId === requestChatId)
            if (messageIndex >= 0) {
                return { characterIndex, chatIndex, messageIndex }
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
                    characterIndex,
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
