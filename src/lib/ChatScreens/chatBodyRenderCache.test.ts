import { beforeEach, describe, expect, it } from 'vitest'
import {
    clearChatBodyRenderCache,
    getChatBodyRenderCache,
    setChatBodyRenderCache,
} from './chatBodyRenderCache'

describe('chatBodyRenderCache', () => {
    beforeEach(clearChatBodyRenderCache)

    it('reuses a translated render only for the same source and cache revision', () => {
        setChatBodyRenderCache('room:message', {
            sourceData: 'source',
            html: '<p>translated</p>',
            translated: true,
            translationCacheKey: 'translation-key',
            translationCacheRevision: 3,
        })

        expect(getChatBodyRenderCache('room:message', 'source', 3)?.html)
            .toBe('<p>translated</p>')
        expect(getChatBodyRenderCache('room:message', 'edited', 3)).toBeNull()
        expect(getChatBodyRenderCache('room:message', 'source', 4)).toBeNull()
    })

    it('replaces an older render for the same message', () => {
        setChatBodyRenderCache('room:message', {
            sourceData: 'source',
            html: 'old',
            translated: false,
            translationCacheKey: 'translation-key',
            translationCacheRevision: 1,
        })
        setChatBodyRenderCache('room:message', {
            sourceData: 'source',
            html: 'new',
            translated: true,
            translationCacheKey: 'translation-key',
            translationCacheRevision: 2,
        })

        expect(getChatBodyRenderCache('room:message', 'source', 1)).toBeNull()
        expect(getChatBodyRenderCache('room:message', 'source', 2)?.html).toBe('new')
    })
})
