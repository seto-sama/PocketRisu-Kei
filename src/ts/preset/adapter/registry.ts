import type { AdapterKind, ModelPreset } from '../types'
import {
    decodeAmazonBedrockResponse,
    decodeAmazonBedrockStream,
    previewAmazonBedrockChatRequest,
    sendAmazonBedrockChatRequest,
    streamAmazonBedrockChatRequest,
} from './amazonBedrock'
import {
    decodeAnthropicResponse,
    decodeAnthropicStream,
    previewAnthropicChatRequest,
    sendAnthropicChatRequest,
    streamAnthropicChatRequest,
} from './anthropicMessages'
import {
    decodeGeminiResponse,
    decodeGeminiStream,
    previewGoogleChatRequest,
    sendGoogleChatRequest,
    streamGoogleChatRequest,
} from './googleGemini'
import {
    decodeChatCompletionResponse,
    decodeChatCompletionStream,
    previewChatRequest,
    sendChatRequest,
    streamChatRequest,
} from './openaiCompatible'
import {
    decodeResponsesResponse,
    decodeResponsesStream,
    previewResponsesRequest,
    sendResponsesRequest,
    streamResponsesRequest,
} from './openaiResponses'
import type {
    AdapterChatOptions,
    AdapterChatResponse,
    AdapterChatStreamDelta,
    AdapterCredential,
    AdapterPreparedRequest,
    AdapterResponseDecoder,
} from './types'

/**
 * Adapter kinds backed by this package's concrete HTTP wire implementations.
 * Dispatch-only kinds are deliberately excluded: `custom` resolves to one of
 * these before dispatch, while `plugin` and `echo` have their own executors.
 */
export type HttpAdapterKind = Exclude<AdapterKind, 'custom' | 'plugin' | 'echo'>

export interface ModelPresetAdapterSupport {
    readonly streaming: boolean
    readonly tools: boolean
    readonly vision: boolean
    /** Whether this wire implementation can enforce a JSON Schema response. */
    readonly jsonSchema: boolean
    /** Folding availability, or required folding that preserves only the leading system block. */
    readonly systemPromptFolding: 'always' | 'custom-only' | 'never' | 'leading-only'
}

export interface ModelPresetAdapterDefinition {
    readonly kind: HttpAdapterKind
    readonly support: ModelPresetAdapterSupport
    readonly send: (
        preset: ModelPreset,
        options: AdapterChatOptions,
        credential?: AdapterCredential,
    ) => Promise<AdapterChatResponse>
    readonly stream: (
        preset: ModelPreset,
        options: AdapterChatOptions,
        credential?: AdapterCredential,
    ) => AsyncGenerator<AdapterChatStreamDelta, void, void>
    readonly preview: (
        preset: ModelPreset,
        options: AdapterChatOptions,
        credential?: AdapterCredential,
    ) => AdapterPreparedRequest | Promise<AdapterPreparedRequest>
    /** Decodes a complete chat response body; the server runs this for the adapter. */
    readonly decodeResponse: (
        body: string,
        decoder: AdapterResponseDecoder,
        onRaw?: (raw: unknown) => void,
    ) => AdapterChatResponse
    /** Decodes a streaming chat response body; the server runs this for the adapter. */
    readonly decodeStream: (
        body: ReadableStream<Uint8Array>,
        decoder: AdapterResponseDecoder,
        onRaw?: (raw: unknown) => void,
    ) => AsyncGenerator<AdapterChatStreamDelta, void, void>
}

/**
 * Single source of truth for concrete adapter dispatch and wire features that
 * are implemented by the application. Profile capabilities and per-preset switches
 * are separate policy gates layered on top by the compiler/request path.
 */
export const MODEL_PRESET_ADAPTER_REGISTRY = {
    'openai-compatible': {
        kind: 'openai-compatible',
        support: {
            streaming: true,
            tools: true,
            vision: true,
            jsonSchema: true,
            systemPromptFolding: 'always',
        },
        send: sendChatRequest,
        stream: streamChatRequest,
        preview: previewChatRequest,
        decodeResponse: decodeChatCompletionResponse,
        decodeStream: decodeChatCompletionStream,
    },
    'openai-responses': {
        kind: 'openai-responses',
        support: {
            streaming: true,
            tools: true,
            vision: true,
            jsonSchema: true,
            systemPromptFolding: 'custom-only',
        },
        send: sendResponsesRequest,
        stream: streamResponsesRequest,
        preview: previewResponsesRequest,
        decodeResponse: decodeResponsesResponse,
        decodeStream: decodeResponsesStream,
    },
    'anthropic-messages': {
        kind: 'anthropic-messages',
        support: {
            streaming: true,
            tools: true,
            vision: true,
            jsonSchema: true,
            systemPromptFolding: 'never',
        },
        send: sendAnthropicChatRequest,
        stream: streamAnthropicChatRequest,
        preview: previewAnthropicChatRequest,
        decodeResponse: decodeAnthropicResponse,
        decodeStream: decodeAnthropicStream,
    },
    'google-gemini': {
        kind: 'google-gemini',
        support: {
            streaming: true,
            tools: true,
            vision: true,
            jsonSchema: true,
            systemPromptFolding: 'leading-only',
        },
        send: sendGoogleChatRequest,
        stream: streamGoogleChatRequest,
        preview: previewGoogleChatRequest,
        decodeResponse: (body, _decoder, onRaw) => decodeGeminiResponse(body, onRaw),
        decodeStream: (body, _decoder, onRaw) => decodeGeminiStream(body, onRaw),
    },
    'amazon-bedrock': {
        kind: 'amazon-bedrock',
        support: {
            streaming: true,
            tools: true,
            vision: true,
            jsonSchema: false,
            systemPromptFolding: 'never',
        },
        send: sendAmazonBedrockChatRequest,
        stream: streamAmazonBedrockChatRequest,
        preview: previewAmazonBedrockChatRequest,
        decodeResponse: decodeAmazonBedrockResponse,
        decodeStream: decodeAmazonBedrockStream,
    },
} as const satisfies Record<HttpAdapterKind, ModelPresetAdapterDefinition>

export function getModelPresetAdapterDefinition(
    kind: HttpAdapterKind,
): ModelPresetAdapterDefinition
export function getModelPresetAdapterDefinition(
    kind: AdapterKind,
): ModelPresetAdapterDefinition | undefined
export function getModelPresetAdapterDefinition(
    kind: AdapterKind,
): ModelPresetAdapterDefinition | undefined {
    return kind in MODEL_PRESET_ADAPTER_REGISTRY
        ? MODEL_PRESET_ADAPTER_REGISTRY[kind as HttpAdapterKind]
        : undefined
}

export function isHttpAdapterKind(kind: AdapterKind): kind is HttpAdapterKind {
    return getModelPresetAdapterDefinition(kind) !== undefined
}
