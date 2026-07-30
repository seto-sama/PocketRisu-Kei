import { describe, expect, test } from 'vitest'
import {
    applyAdditionalParameters,
    parseAdditionalParametersText,
} from './additionalParameters'

describe('additional request parameters', () => {
    test('parses the preset textarea without losing equals signs', () => {
        expect(parseAdditionalParametersText(`
            # ignored
            nested.value=json::{"url":"https://example.test?a=b"}
            header::X-Trace=abc=def
        `)).toEqual([
            ['nested.value', 'json::{"url":"https://example.test?a=b"}'],
            ['header::X-Trace', 'abc=def'],
        ])
    })

    test('applies the syntax shared by classic and model-preset requests', () => {
        const body: Record<string, unknown> = {
            removed: true,
            nested: { keep: true },
        }
        const headers = { Existing: 'remove-me' }

        applyAdditionalParameters(body, headers, [
            ['removed', '{{none}}'],
            ['header::Existing', '{{none}}'],
            ['nested.count', '2'],
            ['enabled', 'true'],
            ['nullable', 'null'],
            ['quoted', '"two words"'],
            ['payload', 'json::{"ok":true}'],
        ])

        expect(body).toEqual({
            nested: { keep: true, count: 2 },
            enabled: true,
            nullable: null,
            quoted: 'two words',
            payload: { ok: true },
        })
        expect(headers).toEqual({})
    })
})
