// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import {
    acknowledgeChatCommit,
    acknowledgeProjectionOnlyChatConflict,
    awaitChatGenerationCanonical,
    beginChatGenerationProjection,
    consumeServerAppliedChat,
    createChatCommitSnapshot,
    discardAllChatWorkingCopies,
    isChatWorkingCopyDirty,
    isChatAwaitingGenerationCanonical,
    listDirtyChatWorkingCopies,
    markChatWorkingCopyDirty,
    markChatServerApplied,
    observeChatGenerationProjection,
    resolveChatGenerationCanonical,
} from './chatWorkingCopy'

describe('chat working copies', () => {
    beforeEach(() => discardAllChatWorkingCopies())

    it('binds the first server etag to every later revision of a dirty body', () => {
        markChatWorkingCopyDirty('character', 'room', 'base-etag')
        markChatWorkingCopyDirty('character', 'room', 'newer-fetched-etag')

        const snapshot = createChatCommitSnapshot('character', {
            id: 'room', message: [{ role: 'user', data: 'local' }],
        } as any, 'latest-etag')

        expect(snapshot.expectedEtag).toBe('base-etag')
        expect(snapshot.chat.message[0].data).toBe('local')
    })

    it('only cleans the exact revision acknowledged by the server', () => {
        markChatWorkingCopyDirty('character', 'room', 'base-etag')
        const first = createChatCommitSnapshot('character', {
            id: 'room', message: [],
        } as any, 'base-etag')
        markChatWorkingCopyDirty('character', 'room', 'base-etag')

        acknowledgeChatCommit(first, 'first-commit-etag')
        expect(isChatWorkingCopyDirty('character', 'room')).toBe(true)

        const latest = createChatCommitSnapshot('character', {
            id: 'room', message: [],
        } as any, 'ignored-latest-etag')
        expect(latest.expectedEtag).toBe('first-commit-etag')
        acknowledgeChatCommit(latest)
        expect(listDirtyChatWorkingCopies()).toEqual([])
    })

    it('does not discard an unrelated dirty edit when a server projection is observed', () => {
        const chat = { id: 'room', message: [] } as any
        markChatWorkingCopyDirty('character', 'room', 'base-etag')
        markChatServerApplied('character', chat)

        expect(isChatWorkingCopyDirty('character', 'room')).toBe(true)
    })

    it('suppresses repeated reactive passes until a server-applied chat is actually edited', () => {
        const chat = {
            id: 'room',
            message: [{ chatId: 'message', role: 'char', data: 'cancelled partial' }],
        } as any
        markChatServerApplied('character', chat)

        expect(consumeServerAppliedChat(chat)).toBe(true)
        expect(consumeServerAppliedChat(chat)).toBe(true)

        chat.message[0].data = 'user edit'
        expect(consumeServerAppliedChat(chat)).toBe(false)
        expect(consumeServerAppliedChat(chat)).toBe(false)
    })

    it('ends generation ownership only when its awaited canonical body is applied', () => {
        const base = {
            id: 'room',
            message: [{ chatId: 'before', role: 'user', data: 'input' }],
        } as any
        beginChatGenerationProjection('character', base, { messageChatId: 'generated' })

        const inputCommitFetch = structuredClone(base)
        markChatServerApplied('character', inputCommitFetch)
        expect(observeChatGenerationProjection('character', inputCommitFetch)).toBe('projection')

        awaitChatGenerationCanonical('character', 'room')
        const terminalCanonical = {
            ...structuredClone(base),
            message: [
                ...base.message,
                { chatId: 'generated', role: 'char', data: 'partial' },
            ],
        }
        markChatServerApplied('character', terminalCanonical as any)
        expect(observeChatGenerationProjection('character', terminalCanonical as any)).toBe('inactive')
    })

    it('pins an absent base version instead of adopting a later fetch', () => {
        markChatWorkingCopyDirty('character', 'new-room')
        markChatWorkingCopyDirty('character', 'new-room', 'unexpected-server-etag')

        const snapshot = createChatCommitSnapshot('character', {
            id: 'new-room', message: [],
        } as any, 'unexpected-server-etag')

        expect(snapshot.expectedEtag).toBeUndefined()
    })

    it('ignores the owned response projection but detects edits to earlier messages', () => {
        const base = {
            id: 'room',
            message: [{ chatId: 'earlier', role: 'user', data: 'before' }],
        } as any
        beginChatGenerationProjection('character', base, { messageChatId: 'generated' })

        const live = structuredClone(base)
        live.isStreaming = true
        live.message.push({ chatId: 'generated', role: 'char', data: 'partial' })
        expect(observeChatGenerationProjection('character', live)).toBe('projection')

        live.message[0].data = 'edited while receiving'
        expect(observeChatGenerationProjection('character', live)).toBe('edit')

        live.message[1].data = 'longer partial'
        expect(observeChatGenerationProjection('character', live)).toBe('projection')
    })

    it('treats reroll target and trailing comments as one owned projection', () => {
        const target = { chatId: 'target', role: 'char', data: 'old' }
        const trailing = { chatId: 'comment', role: 'user', data: 'note', isComment: true }
        const base = {
            id: 'room',
            message: [{ chatId: 'earlier', role: 'user', data: 'before' }, target, trailing],
        } as any
        beginChatGenerationProjection('character', base, {
            messageChatId: 'generated',
            rerollSnapshot: {
                targetMessage: target,
                trailingMessages: [trailing],
            },
        })

        const rerollProjection = {
            ...base,
            isStreaming: true,
            message: [base.message[0], { chatId: 'generated', role: 'char', data: 'partial' }],
        }
        expect(observeChatGenerationProjection('character', rerollProjection)).toBe('projection')
    })

    it('installs a cancelled reroll swipe even when its local projection was marked dirty', () => {
        const target = {
            chatId: 'target', role: 'char', data: 'old', swipes: ['old'], swipeId: 0,
        }
        const base = {
            id: 'room',
            message: [{ chatId: 'earlier', role: 'user', data: 'before' }, target],
        } as any
        beginChatGenerationProjection('character', base, {
            messageChatId: 'generated',
            rerollSnapshot: { targetMessage: target },
        })
        const local = structuredClone(base)
        local.message[1] = { chatId: 'generated', role: 'char', data: 'live partial' }
        markChatWorkingCopyDirty('character', 'room', 'input-etag')
        awaitChatGenerationCanonical('character', 'room')

        const canonical = structuredClone(base)
        canonical.message[1] = {
            chatId: 'generated', role: 'char', data: 'cancelled partial',
            swipes: ['old', 'cancelled partial'], swipeId: 1,
        }
        const resolved = resolveChatGenerationCanonical(
            'character', local, canonical, 'canonical-etag',
        )

        expect(resolved.message[1]).toEqual(canonical.message[1])
        expect(isChatWorkingCopyDirty('character', 'room')).toBe(false)
        expect(isChatAwaitingGenerationCanonical('character', 'room')).toBe(false)
    })

    it('rebases a real earlier-message edit over the terminal canonical target', () => {
        const base = {
            id: 'room',
            message: [
                { chatId: 'earlier', role: 'user', data: 'before' },
                { chatId: 'target', role: 'char', data: 'old' },
            ],
        } as any
        beginChatGenerationProjection('character', base, {
            messageChatId: 'generated',
            rerollSnapshot: { targetMessage: base.message[1] },
        })
        const local = structuredClone(base)
        local.message[0].data = 'edited locally'
        local.message[1] = { chatId: 'generated', role: 'char', data: 'live partial' }
        expect(observeChatGenerationProjection('character', local)).toBe('edit')
        markChatWorkingCopyDirty('character', 'room', 'input-etag')
        awaitChatGenerationCanonical('character', 'room')

        const canonical = structuredClone(base)
        canonical.message[1] = { chatId: 'generated', role: 'char', data: 'server partial' }
        const resolved = resolveChatGenerationCanonical(
            'character', local, canonical, 'canonical-etag',
        )

        expect(resolved.message).toEqual([
            { chatId: 'earlier', role: 'user', data: 'edited locally' },
            { chatId: 'generated', role: 'char', data: 'server partial' },
        ])
        expect(createChatCommitSnapshot('character', resolved, 'ignored').expectedEtag)
            .toBe('canonical-etag')
    })

    it('turns a projection-only CAS conflict into canonical refresh instead of a failed save', () => {
        const base = {
            id: 'room',
            message: [{ chatId: 'target', role: 'char', data: 'old' }],
        } as any
        beginChatGenerationProjection('character', base, {
            messageChatId: 'generated',
            rerollSnapshot: { targetMessage: base.message[0] },
        })
        const projection = structuredClone(base)
        projection.message[0] = { chatId: 'generated', role: 'char', data: 'partial' }
        markChatWorkingCopyDirty('character', 'room', 'old-etag')

        expect(acknowledgeProjectionOnlyChatConflict('character', projection)).toBe(true)
        expect(isChatWorkingCopyDirty('character', 'room')).toBe(false)

        projection.message.unshift({ chatId: 'earlier', role: 'user', data: 'real edit' })
        markChatWorkingCopyDirty('character', 'room', 'new-etag')
        expect(acknowledgeProjectionOnlyChatConflict('character', projection)).toBe(false)
        expect(isChatWorkingCopyDirty('character', 'room')).toBe(true)
    })
})
