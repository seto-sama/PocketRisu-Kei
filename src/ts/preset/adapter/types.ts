import type { ServiceAccountTokenCache } from './googleServiceAccount/cache'
import type { ServerProviderAuth } from '../../network/transportTypes'
import type { GeminiPromptCachingConfig } from '../cache/geminiContextCache'
import type { ModelPreset } from '../types'
import type { ThoughtSignatureContext } from './thoughtSignatures'

export interface AdapterCredential {
    apiKey?: string
    inlineCredential?: unknown
}

export interface AdapterRequestContext {
    preset: ModelPreset
    credential?: AdapterCredential
    abortSignal?: AbortSignal
    stream?: boolean
    // Adapter-derived defaults that participate in the normal body precedence:
    // schema/user values < generated defaults < customBody < additional params.
    generatedBodyDefaults?: Record<string, unknown>
    // Raw Service Account JSON string as it stood BEFORE `resolveAdapterCredential`
    // swapped it for an OAuth access token. Threaded through by
    // `prepareAdapterRequest` so the Vertex endpoint builder can recover the GCP
    // `project_id` for pooled / inline SA credentials (where the JSON never lands
    // in `userValues.serviceAccountJson`). Only populated for the
    // google-service-account auth kind; ignored by every other endpoint kind.
    serviceAccountJson?: string
}

export interface AdapterPreparedRequest {
    serverProviderAuth?: ServerProviderAuth
    method: 'POST'
    url: string
    headers: Record<string, string>
    body: Record<string, unknown>
}

export type AdapterErrorKind =
    | 'network'
    | 'timeout'
    | 'aborted'
    | 'auth'
    | 'rate-limit'
    | 'invalid-request'
    | 'not-found'
    | 'server'
    | 'parse'
    | 'unsupported'
    | 'unknown'

export interface AdapterError {
    kind: AdapterErrorKind
    message: string
    status?: number
    retryAfterMs?: number
    retryable: boolean
    fallbackEligible: boolean
    cause?: unknown
}

export interface AdapterStreamEvent {
    event?: string
    data: string
    id?: string
}

export type AdapterChatRole = 'system' | 'developer' | 'user' | 'assistant' | 'tool'

// Tool arguments retain the provider's JSON string.
export interface AdapterToolCall {
    id: string
    name: string
    arguments: string
    // Gemini thoughtSignature echoed alongside the function call.
    signature?: string
}

// Provider reasoning text and opaque tokens retained for tool follow-ups.
export interface AdapterReasoningPart {
    text?: string
    signature?: string
    redactedData?: string
}

// Image payloads omit the data URL prefix; MIME is sent separately.
export interface AdapterImagePart {
    kind: 'image'
    base64: string
    mime?: string
}

export interface AdapterMediaPart {
    kind: 'audio' | 'video'
    base64: string
    mime?: string
}

export interface AdapterGeneratedMedia {
    kind: 'image' | 'audio'
    base64: string
    mime: string
}

export interface AdapterChatMessage {
    role: AdapterChatRole
    content: string
    name?: string
    toolCallId?: string                 // role:'tool' — which call this answers
    toolCalls?: AdapterToolCall[]        // role:'assistant' — calls the model made
    reasoning?: AdapterReasoningPart[]   // role:'assistant' — thinking blocks to echo back
    responseId?: string
    thoughtContext?: ThoughtSignatureContext
    // Raw provider payload for exact replay during the active tool loop.
    providerEcho?: unknown
    images?: AdapterImagePart[]          // role:'user' — image attachments (vision)
    media?: AdapterMediaPart[]           // role:'user' — enabled audio/video attachments
    // Native prompt-cache boundary flag, preserved from OpenAIChat.cachePoint
    // (cache prompt card / automaticCachePoint — the same infra Anthropic
    // caching consumes). The google-gemini adapter folds the LAST flagged
    // position into its single explicit-cache boundary.
    cachePoint?: boolean
}

// A tool the model may call. `parameters` is a JSON schema already simplified by
// the caller for the target provider (simplifySchema lives in util.ts, which
// pulls getDatabase + Svelte components — importing it here would create the SSR
// cycle the adapter layer deliberately avoids). Adapters only reshape the
// envelope around it.
export interface AdapterToolDef {
    name: string
    description?: string
    parameters: unknown
}

export interface AdapterUsage {
    promptTokens?: number
    completionTokens?: number
    totalTokens?: number
    // Prompt tokens served from a context cache (Gemini usageMetadata
    // .cachedContentTokenCount). Basis for the hit/savings display.
    cachedTokens?: number
}

export interface AdapterChatResponse {
    text: string
    media?: AdapterGeneratedMedia[]       // generated image/audio payloads
    toolCalls?: AdapterToolCall[]        // calls the model requested this turn
    reasoning?: AdapterReasoningPart[]   // thinking blocks emitted this turn (echo + display)
    providerEcho?: unknown               // raw assistant payload for verbatim re-send (see AdapterChatMessage)
    finishReason?: string
    usage?: AdapterUsage
    /**
     * A persistent generation job whose initial response did not contain usage.
     * Anthropic Message Batches populate this so the final result usage can be
     * reported back into the same usage row.
     */
    deferredUsageJobId?: string
    raw: unknown
}

export interface AdapterChatStreamDelta {
    textDelta: string
    // Reasoning (thinking) text for this chunk, kept SEPARATE from textDelta so it
    // can be wrapped in <Thoughts> for display instead of leaking into the answer.
    reasoningDelta?: string
    finishReason?: string
    usage?: AdapterUsage
    raw: unknown
}

// Context for Gemini explicit context caching. Supplied by request.ts only when
// the request is cache-eligible (main chat, google-gemini adapter, AI Studio key
// auth, caching enabled, no tools); adapters other than googleGemini ignore it.
// Carries everything the cache layer needs so the adapter never reads the
// database (SSR rule). See .agent/notes/gemini-cache-keeper-internalization.md.
export interface AdapterCacheContext {
    promptCaching: GeminiPromptCachingConfig
    chatKey: string      // chat.id — cache state key component
    task: string         // request mode ('model' in v1)
    presetId: string
    // The request's generationId, so the cache layer can key a future
    // hit/savings badge to this exact request (request-status channel).
    generationId?: string
}

export interface AdapterChatOptions {
    /** Execution host supplies token exchange; omitted by browser callers. */
    tokenCache?: ServiceAccountTokenCache
    messages: AdapterChatMessage[]
    // Automatically derived GPT-5.6 prompt-cache routing key. The Responses
    // adapter applies it only when the preset did not explicitly configure
    // prompt_cache_key through custom body / additional parameters.
    promptCacheKey?: string
    tools?: AdapterToolDef[]             // when present, enables tool use on the request
    // Prompt → Advanced JSON Schema, resolved once by request.ts and translated
    // to each provider's structured-output wire by the adapter.
    structuredOutput?: {
        schema: Record<string, unknown>
        strict: boolean
    }
    abortSignal?: AbortSignal
    fetchImpl?: typeof fetch
    // Message UUID used by request status and context caching.
    generationId?: string
    // Gemini context caching (see AdapterCacheContext).
    cache?: AdapterCacheContext
}
