import { describe, expect, test } from 'vitest'
import type { PromptItem } from '../../process/prompt'
import { createOpenAiPromptCacheKey } from './openaiPromptCacheKey'

const roomId = '12345678-abcd-4abc-8abc-1234567890ab'

describe('OpenAI prompt cache key', () => {
    test('uses the requested room and preset-hash shape', async () => {
        const key = await createOpenAiPromptCacheKey(roomId, [{
            type: 'plain',
            type2: 'main',
            role: 'system',
            text: 'Stable instructions',
        }])

        expect(key).toMatch(/^rk-12345678-[0-9a-f]{12}$/)
    })

    test('hashes only raw cards before the final explicit cache card', async () => {
        const prefix: PromptItem[] = [{
            type: 'plain',
            type2: 'main',
            role: 'system',
            text: '{{raw prompt}}',
        }]
        const first = await createOpenAiPromptCacheKey(roomId, [
            ...prefix,
            { type: 'cache', name: 'first', depth: 1, role: 'all' },
            { type: 'plain', type2: 'normal', role: 'user', text: 'ignored A' },
            { type: 'cache', name: 'last A', depth: 1, role: 'all' },
            { type: 'plain', type2: 'normal', role: 'user', text: 'ignored B' },
        ])
        const second = await createOpenAiPromptCacheKey(roomId, [
            ...prefix,
            { type: 'cache', name: 'changed earlier marker', depth: 3, role: 'user' },
            { type: 'plain', type2: 'normal', role: 'user', text: 'ignored A' },
            { type: 'cache', name: 'last B', depth: 3, role: 'user' },
            { type: 'plain', type2: 'normal', role: 'user', text: 'different suffix' },
        ])

        expect(first).toBe(second)
    })

    test('hashes the complete raw template when no cache card exists', async () => {
        const first = await createOpenAiPromptCacheKey(roomId, [{
            type: 'plain', type2: 'main', role: 'system', text: 'A',
        }])
        const second = await createOpenAiPromptCacheKey(roomId, [{
            type: 'plain', type2: 'main', role: 'system', text: 'B',
        }])

        expect(first).not.toBe(second)
    })

    test('does not generate an automatic key without a room or raw template', async () => {
        expect(await createOpenAiPromptCacheKey(undefined, [])).toBeUndefined()
        expect(await createOpenAiPromptCacheKey(roomId, undefined)).toBeUndefined()
    })
})
