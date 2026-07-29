import type { AdapterKind, ModelPreset } from '../types'
import {
    previewAmazonBedrockChatRequest,
    sendAmazonBedrockChatRequest,
    streamAmazonBedrockChatRequest,
} from './amazonBedrock'
import {
    previewAnthropicChatRequest,
    sendAnthropicChatRequest,
    streamAnthropicChatRequest,
} from './anthropicMessages'
import {
    previewGoogleChatRequest,
    sendGoogleChatRequest,
    streamGoogleChatRequest,
} from './googleGemini'
import {
    previewChatRequest,
    sendChatRequest,
    streamChatRequest,
} from './openaiCompatible'
import {
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
    /** Editor/runtime policy for rewriting system messages into user turns. */
    readonly systemPromptFolding: 'always' | 'custom-only' | 'never'
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
}

/**
 * Single source of truth for concrete adapter dispatch and wire features that
 * are implemented by PocketRisu. Profile capabilities and per-preset switches
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
    },
    'google-gemini': {
        kind: 'google-gemini',
        support: {
            streaming: true,
            tools: true,
            vision: true,
            jsonSchema: true,
            systemPromptFolding: 'never',
        },
        send: sendGoogleChatRequest,
        stream: streamGoogleChatRequest,
        preview: previewGoogleChatRequest,
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
