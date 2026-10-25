import { describe, expect, it } from 'vitest'
import type { Database } from '../storage/database.svelte'
import { findRequestStatusChatTarget } from './requestStatusTarget'

function databaseWithTargets(): Database {
    return {
        characters: [
            {
                chaId: 'character-1',
                chats: [
                    {
                        id: 'room-1',
                        message: [
                            { role: 'user', data: 'question', chatId: 'user-1' },
                            {
                                role: 'char',
                                data: 'answer',
                                chatId: 'message-1',
                                generationInfo: { generationId: 'generation-1' },
                            },
                        ],
                    },
                ],
            },
            {
                chaId: 'character-2',
                chats: [
                    {
                        id: 'room-2',
                        message: [
                            { role: 'char', data: 'older', chatId: 'message-2' },
                            { role: 'user', data: 'latest question', chatId: 'user-2' },
                        ],
                    },
                ],
            },
        ],
    } as unknown as Database
}

describe('request status chat navigation', () => {
    it.each(['message-1', 'generation-1'])('finds a response by %s', id => {
        expect(findRequestStatusChatTarget(databaseWithTargets(), id)).toEqual({
            characterId: 'character-1',
            chatIndex: 0,
            messageIndex: 1,
        })
    })

    it('falls back from a recovery room id to its latest character message', () => {
        expect(findRequestStatusChatTarget(databaseWithTargets(), 'room-2')).toEqual({
            characterId: 'character-2',
            chatIndex: 0,
            messageIndex: 0,
        })
    })

    it('can navigate to an unloaded room before its messages are hydrated', () => {
        const db = databaseWithTargets()
        db.characters[1].chats.push({
            id: 'placeholder-room',
            _placeholder: true,
        } as never)

        expect(findRequestStatusChatTarget(db, 'placeholder-room')).toEqual({
            characterId: 'character-2',
            chatIndex: 1,
            messageIndex: null,
        })
    })
})
