import { describe, expect, it } from 'vitest'
import {
    extractLuaLlmInlays,
    luaLlmResult,
    normalizeLuaLlmPrompt,
    normalizeLuaLlmResult,
    parseLuaLlmOptions,
    serializeLuaLlmResult,
} from './luaLlmCore'

describe('Lua LLM normalization', () => {
    it('normalizes prompt roles and content', () => {
        expect(normalizeLuaLlmPrompt(JSON.stringify([
            { role: 'sys', content: 'rules' },
            { role: 'char', content: 'answer' },
            { role: 'unknown', content: 3 },
        ]))).toEqual([
            { role: 'system', content: 'rules' },
            { role: 'assistant', content: 'answer' },
            { role: 'assistant', content: '3' },
        ])
    })

    it('normalizes options and multimodal references', () => {
        expect(parseLuaLlmOptions('{"streaming":true}')).toEqual({ streaming: true })
        expect(parseLuaLlmOptions('invalid')).toEqual({})
        expect(extractLuaLlmInlays({
            role: 'assistant', content: 'a{{inlay::skip}}b{{inlayeddata::keep}}',
        })).toEqual({ content: 'ab', inlayIds: ['keep'] })
    })

    it('keeps one response envelope for direct and replayed results', () => {
        expect(luaLlmResult(false, 'denied', true)).toEqual({ success: false, result: 'Error: denied' })
        expect(normalizeLuaLlmResult({ success: true, result: 3 })).toEqual({ success: true, result: '3' })
        expect(JSON.parse(serializeLuaLlmResult('done'))).toEqual({ success: true, result: 'done' })
    })
})
