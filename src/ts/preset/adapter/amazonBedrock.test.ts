import { describe, expect, test, vi } from 'vitest'
import type { ModelPreset, ResolvedModelProfileSnapshot } from '../types'
import {
    parseAmazonBedrockResponse,
    parseAmazonBedrockStreamEvent,
    parseAwsEventStream,
    parseBedrockCredential,
    previewAmazonBedrockChatRequest,
    sendAmazonBedrockChatRequest,
    streamAmazonBedrockChatRequest,
} from './amazonBedrock'
import { ModelPresetAdapterError } from './error'

function preset(
    credential: string,
    region = 'ap-northeast-2',
): { preset: ModelPreset; credential: { apiKey: string } } {
    const snapshot: ResolvedModelProfileSnapshot = {
        profileId: 'amazon-bedrock:global.anthropic.claude-sonnet',
        providerBaseId: 'amazon-bedrock',
        adapterKind: 'amazon-bedrock',
        auth: { kind: 'aws-bedrock', fields: ['bedrockCredential'] },
        endpoint: { kind: 'amazon-bedrock' },
        modelId: 'global.anthropic.claude-sonnet:0',
        schema: [
            {
                key: 'bedrockCredential',
                type: 'string',
                label: 'Credential',
                secret: true,
                mapsTo: { target: 'auth', path: 'apiKey' },
            },
            {
                key: 'bedrockRegion',
                type: 'string',
                label: 'AWS Region',
                default: 'us-east-1',
                mapsTo: { target: 'custom', path: 'bedrockRegion' },
            },
            {
                key: 'maxTokens',
                type: 'integer',
                label: 'Max Tokens',
                mapsTo: { target: 'body', path: 'inferenceConfig.maxTokens' },
            },
        ],
        uiSchema: { groups: [], fields: [] },
        defaults: {},
        capabilities: ['streaming', 'vision', 'tools', 'reasoning'],
    }
    return {
        preset: {
            id: 'bedrock',
            name: 'Bedrock',
            profileSnapshot: snapshot,
            userValues: { bedrockRegion: region, maxTokens: 4096 },
            createdAt: 1,
            updatedAt: 1,
        },
        credential: { apiKey: credential },
    }
}

describe('Amazon Bedrock credentials', () => {
    test('treats a plain value as a Bedrock bearer API key', () => {
        expect(parseBedrockCredential(' bedrock-api-key ')).toEqual({
            kind: 'api-key',
            apiKey: 'bedrock-api-key',
        })
    })

    test('parses IAM credentials JSON with an optional session token', () => {
        expect(parseBedrockCredential(JSON.stringify({
            accessKeyId: 'AKIAEXAMPLE',
            secretAccessKey: 'secret',
            sessionToken: 'session',
        }))).toEqual({
            kind: 'iam',
            accessKeyId: 'AKIAEXAMPLE',
            secretAccessKey: 'secret',
            sessionToken: 'session',
        })
    })

    test('rejects incomplete IAM JSON', () => {
        expect(() => parseBedrockCredential('{"accessKeyId":"AKIA"}'))
            .toThrowError(ModelPresetAdapterError)
    })
})

describe('Amazon Bedrock request wire', () => {
    test('builds a bearer-authenticated Converse request with system, image, and tools', async () => {
        const input = preset('bedrock-api-key')
        const prepared = await previewAmazonBedrockChatRequest(
            input.preset,
            {
                messages: [
                    { role: 'system', content: 'Be concise.' },
                    {
                        role: 'user',
                        content: 'Describe this.',
                        images: [{ kind: 'image', mime: 'image/png', base64: 'aW1hZ2U=' }],
                    },
                ],
                tools: [{
                    name: 'lookup',
                    description: 'Look something up',
                    parameters: { type: 'object', properties: {} },
                }],
            },
            input.credential,
        )

        expect(prepared.url).toBe(
            'https://bedrock-runtime.ap-northeast-2.amazonaws.com/model/global.anthropic.claude-sonnet%3A0/converse',
        )
        expect(prepared.headers.Authorization).toBe('Bearer bedrock-api-key')
        expect(prepared.body).toMatchObject({
            inferenceConfig: { maxTokens: 4096 },
            system: [{ text: 'Be concise.' }],
            messages: [{
                role: 'user',
                content: [
                    { text: 'Describe this.' },
                    { image: { format: 'png', source: { bytes: 'aW1hZ2U=' } } },
                ],
            }],
            toolConfig: {
                tools: [{
                    toolSpec: {
                        name: 'lookup',
                        description: 'Look something up',
                        inputSchema: { json: { type: 'object', properties: {} } },
                    },
                }],
            },
        })
    })

    test('signs the final Converse body with AWS SigV4 for IAM JSON', async () => {
        const input = preset(JSON.stringify({
            accessKeyId: 'AKIAEXAMPLE',
            secretAccessKey: 'secret',
            sessionToken: 'session',
        }))
        const prepared = await previewAmazonBedrockChatRequest(
            input.preset,
            { messages: [{ role: 'user', content: 'Hello' }] },
            input.credential,
        )

        expect(prepared.headers.authorization).toMatch(
            /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\//,
        )
        expect(prepared.headers['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/)
        expect(prepared.headers['x-amz-security-token']).toBe('session')
        expect(Object.keys(prepared.headers).some((key) => key.toLowerCase() === 'host')).toBe(false)
    })

    test('sends and parses a non-streaming Converse response', async () => {
        const input = preset('api-key')
        const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
            output: {
                message: {
                    role: 'assistant',
                    content: [
                        { reasoningContent: { reasoningText: { text: 'Think', signature: 'sig' } } },
                        { text: 'Answer' },
                        { toolUse: { toolUseId: 'tool-1', name: 'lookup', input: { q: 'x' } } },
                    ],
                },
            },
            stopReason: 'tool_use',
            usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
        }), { status: 200 }))

        const result = await sendAmazonBedrockChatRequest(
            input.preset,
            { messages: [{ role: 'user', content: 'Hello' }], fetchImpl },
            input.credential,
        )

        expect(result.text).toBe('Answer')
        expect(result.reasoning).toEqual([{ text: 'Think', signature: 'sig' }])
        expect(result.toolCalls).toEqual([{
            id: 'tool-1',
            name: 'lookup',
            arguments: '{"q":"x"}',
        }])
        expect(result.usage).toEqual({
            promptTokens: 10,
            completionTokens: 4,
            totalTokens: 14,
        })
    })
})

describe('Amazon Bedrock response and event stream parsing', () => {
    test('parses response blocks without a network request', () => {
        expect(parseAmazonBedrockResponse({
            output: { message: { content: [{ text: 'hello' }] } },
            stopReason: 'end_turn',
        })).toMatchObject({ text: 'hello', finishReason: 'end_turn' })
    })

    test('parses text, reasoning, finish, and usage stream events', () => {
        expect(parseAmazonBedrockStreamEvent('contentBlockDelta', {
            delta: { text: 'hi', reasoningContent: { text: 'think' } },
        })).toMatchObject({ textDelta: 'hi', reasoningDelta: 'think' })
        expect(parseAmazonBedrockStreamEvent('messageStop', { stopReason: 'end_turn' }))
            .toMatchObject({ finishReason: 'end_turn' })
        expect(parseAmazonBedrockStreamEvent('metadata', {
            usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
        })).toMatchObject({
            usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
        })
    })

    test('decodes fragmented AWS event-stream frames', async () => {
        const frame = eventFrame(
            {
                ':message-type': 'event',
                ':event-type': 'contentBlockDelta',
                ':content-type': 'application/json',
            },
            { delta: { text: 'hello' } },
        )
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(frame.slice(0, 9))
                controller.enqueue(frame.slice(9))
                controller.close()
            },
        })
        const messages = []
        for await (const message of parseAwsEventStream(stream)) messages.push(message)

        expect(messages).toHaveLength(1)
        expect(messages[0].headers[':event-type']).toBe('contentBlockDelta')
        expect(JSON.parse(new TextDecoder().decode(messages[0].payload)))
            .toEqual({ delta: { text: 'hello' } })
    })

    test('uses the converse-stream endpoint and yields decoded deltas', async () => {
        const frame = eventFrame(
            { ':message-type': 'event', ':event-type': 'contentBlockDelta' },
            { delta: { text: 'hello' } },
        )
        const fetchImpl = vi.fn(async (url: string | URL | Request) => {
            expect(String(url)).toContain('/converse-stream')
            return new Response(new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(frame)
                    controller.close()
                },
            }), { status: 200 })
        })
        const input = preset('api-key')
        const deltas = []
        for await (const delta of streamAmazonBedrockChatRequest(
            input.preset,
            { messages: [{ role: 'user', content: 'Hi' }], fetchImpl: fetchImpl as typeof fetch },
            input.credential,
        )) {
            deltas.push(delta)
        }
        expect(deltas).toEqual([expect.objectContaining({ textDelta: 'hello' })])
    })
})

function eventFrame(headers: Record<string, string>, payload: unknown): Uint8Array {
    const encoder = new TextEncoder()
    const headerParts: Uint8Array[] = []
    for (const [name, value] of Object.entries(headers)) {
        const nameBytes = encoder.encode(name)
        const valueBytes = encoder.encode(value)
        const part = new Uint8Array(1 + nameBytes.length + 1 + 2 + valueBytes.length)
        let offset = 0
        part[offset++] = nameBytes.length
        part.set(nameBytes, offset)
        offset += nameBytes.length
        part[offset++] = 7
        part[offset++] = (valueBytes.length >> 8) & 0xff
        part[offset++] = valueBytes.length & 0xff
        part.set(valueBytes, offset)
        headerParts.push(part)
    }
    const headerLength = headerParts.reduce((sum, part) => sum + part.length, 0)
    const payloadBytes = encoder.encode(JSON.stringify(payload))
    const totalLength = 12 + headerLength + payloadBytes.length + 4
    const frame = new Uint8Array(totalLength)
    const view = new DataView(frame.buffer)
    view.setUint32(0, totalLength, false)
    view.setUint32(4, headerLength, false)
    let offset = 12
    for (const part of headerParts) {
        frame.set(part, offset)
        offset += part.length
    }
    frame.set(payloadBytes, offset)
    return frame
}
