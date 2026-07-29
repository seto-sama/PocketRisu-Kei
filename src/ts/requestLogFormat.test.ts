import { describe, expect, it } from 'vitest'
import { formatRequestBody, formatResponseBody, getResponseBodyDetails } from './requestLogFormat'

describe('formatRequestBody', () => {
    it('pretty-prints nested JSON and displays decoded newlines', () => {
        const body = '{"messages":[{"role":"user","content":"First\\n\\nSecond"}],"literal":"\\\\n"}'
        const formatted = formatRequestBody(body)

        expect(formatted).toContain('"messages": [')
        expect(formatted).toContain('"content": |\n        First\n        \n        Second')
        expect(formatted).toContain('"literal": |\n    \\n')
    })

    it('leaves non-JSON request bodies unchanged', () => {
        expect(formatRequestBody('plain request body')).toBe('plain request body')
    })
})

describe('formatResponseBody', () => {
    it('formats plain JSON responses and displays nested text without JSON escapes', () => {
        const formatted = formatResponseBody({
            response: '{"candidates":[{"content":{"role":"model","parts":[{"text":"First\\n\\nA \\"quoted\\" line"}]}}]}',
            url: 'https://example.test/generate',
            body: '{}',
        })

        expect(formatted).toContain('"candidates": [')
        expect(formatted).toContain('"text": |')
        expect(formatted).toContain('First\n')
        expect(formatted).toContain('A "quoted" line')
        expect(formatted).not.toContain('\\"quoted\\"')
        expect(formatted).not.toContain('First\\n')
    })
})

describe('getResponseBodyDetails', () => {
    it('groups verbose output-text delta events and keeps other events visible', () => {
        const response = [
            'event: response.created\ndata: {"type":"response.created"}',
            'event: response.in_progress\ndata: {"type":"response.in_progress"}',
            'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"id":"item-1"}}',
            'event: response.content_part.added\ndata: {"type":"response.content_part.added"}',
            'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"A\\n"}',
            'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"B"}',
            'event: response.output_text.done\ndata: {"type":"response.output_text.done"}',
            'event: response.content_part.done\ndata: {"type":"response.content_part.done"}',
            'event: response.output_item.done\ndata: {"type":"response.output_item.done"}',
            'event: response.completed\ndata: {"type":"response.completed","response":{"output":[{"content":[{"type":"output_text","text":"First line\\n\\nSecond line"}]}]}}',
        ].join('\n\n')

        const details = getResponseBodyDetails({
            response,
            url: 'https://api.openai.com/v1/responses',
            body: '{}',
        })

        expect(details?.groups.map(group => group.summary)).toEqual([
            'response.created × 1',
            'response.in_progress × 1',
            'response.output_item.added × 1',
            'response.content_part.added × 1',
            'response.output_text.delta × 2',
            'response.output_text.done × 1',
            'response.content_part.done × 1',
            'response.output_item.done × 1',
        ])
        expect(details?.groups[2]?.readable).toContain('"id": "item-1"')
        expect(details?.groups[4]?.readable).toBe('A\nB')
        expect(details?.groups[4]?.raw).toContain('"delta":"A\\n"')
        expect(details?.groups[4]?.raw).toContain('"delta":"B"')
        expect(details?.remainder).toContain('response.completed')
        expect(details?.remainder).toContain('"text": |')
        expect(details?.remainder).toContain('First line\n')
        expect(details?.remainder).toContain('Second line')
        expect(details?.remainder).not.toContain('First line\\n\\nSecond line')
        expect(details?.rawRemainder).toContain('event: response.completed')
        expect(details?.rawRemainder).toContain('First line\\n\\nSecond line')
        expect(details?.remainder).not.toContain('response.created')
        expect(details?.remainder).not.toContain('response.in_progress')
        expect(details?.remainder).not.toContain('response.content_part.added')
        expect(details?.remainder).not.toContain('response.output_item.added')
        expect(details?.remainder).not.toContain('response.output_text.delta')
        expect(details?.remainder).not.toContain('response.output_text.done')
        expect(details?.remainder).not.toContain('response.content_part.done')
        expect(details?.remainder).not.toContain('response.output_item.done')
    })

    it('does not add details when the target event is absent', () => {
        expect(getResponseBodyDetails({
            response: 'event: response.completed\ndata: {"type":"response.completed"}',
            url: 'https://api.openai.com/v1/responses',
            body: '{}',
        })).toBeNull()
    })
})
