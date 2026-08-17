import { describe, expect, it } from 'vitest'
import type { Database } from '../storage/database.svelte'
import { findRequestStatusChatTarget } from './requestStatusTarget'

function databaseWithTargets(): Database {
    return {
        characters: [
            {
                chaId: 'character-1',
                chatPage: 0,
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
                chatPage: 0,
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
    it('finds a response by its message id', () => {
        expect(findRequestStatusChatTarget(databaseWithTargets(), 'message-1')).toEqual({
            characterIndex: 0,
            chatIndex: 0,
            messageIndex: 1,
        })
    })

    it('finds a response by its generation id', () => {
        expect(findRequestStatusChatTarget(databaseWithTargets(), 'generation-1')).toEqual({
            characterIndex: 0,
            chatIndex: 0,
            messageIndex: 1,
        })
    })

    it('falls back from a recovery room id to its latest character message', () => {
        expect(findRequestStatusChatTarget(databaseWithTargets(), 'room-2')).toEqual({
            characterIndex: 1,
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
            characterIndex: 1,
            chatIndex: 1,
            messageIndex: null,
        })
    })
})
