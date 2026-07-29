import type {
    AdapterKind,
    AuthKind,
    ModelPreset,
    RegistryAuth,
    RegistryCapability,
} from '../types'
import { resolveThinkingBudget } from './thinkingBudget'

export const CUSTOM_ADAPTER_KIND = 'custom'
export const CUSTOM_FORMAT_KEY = 'customFormat'
export const CUSTOM_AUTH_KIND_KEY = 'customAuthKind'
export const CUSTOM_STOP_KEY = 'stopSequences'
export const CUSTOM_FLAG_PREFIX = 'customFlag_'

export type CustomFormat =
    | 'openai-chat'
    | 'openai-responses'
    | 'anthropic-messages'
    | 'google-gemini'

const FORMAT_ADAPTERS: Record<CustomFormat, AdapterKind> = {
    'openai-chat': 'openai-compatible',
    'openai-responses': 'openai-responses',
    'anthropic-messages': 'anthropic-messages',
    'google-gemini': 'google-gemini',
}

const CUSTOM_AUTH_KINDS = new Set<AuthKind>([
    'none',
    'bearer',
    'x-api-key',
    'x-goog-api-key',
    'query',
])

export function isCustomPreset(preset: ModelPreset): boolean {
    return preset.profileSnapshot.adapterKind === CUSTOM_ADAPTER_KIND
}

export function resolveCustomFormat(preset: ModelPreset): CustomFormat {
    const value = preset.userValues?.[CUSTOM_FORMAT_KEY]
    return typeof value === 'string' && value in FORMAT_ADAPTERS
        ? value as CustomFormat
        : 'openai-chat'
}

export function resolveCustomAdapterKind(preset: ModelPreset): AdapterKind | undefined {
    return isCustomPreset(preset)
        ? FORMAT_ADAPTERS[resolveCustomFormat(preset)]
        : undefined
}

export function resolvePresetAuth(preset: ModelPreset): RegistryAuth {
    if (!isCustomPreset(preset)) return preset.profileSnapshot.auth
    const value = preset.userValues?.[CUSTOM_AUTH_KIND_KEY]
    const kind = typeof value === 'string' && CUSTOM_AUTH_KINDS.has(value as AuthKind)
        ? value as AuthKind
        : 'bearer'
    return {
        kind,
        fields: preset.profileSnapshot.auth.fields,
    }
}

export function hasCustomFlag(preset: ModelPreset, name: string): boolean {
    return isCustomPreset(preset) && hasPresetFlag(preset, name)
}

export function hasPresetFlag(preset: ModelPreset, name: string): boolean {
    return preset.userValues?.[`${CUSTOM_FLAG_PREFIX}${name}`] === true
}

export function hasFixedImageOutput(preset: ModelPreset): boolean {
    return !isCustomPreset(preset)
        && preset.profileSnapshot.capabilities?.includes('image-output') === true
}

export function hasPresetImageOutput(preset: ModelPreset): boolean {
    return hasFixedImageOutput(preset)
        || (isCustomPreset(preset) && hasPresetFlag(preset, 'hasImageOutput'))
}

export function hasCustomModelIdToken(preset: ModelPreset, token: string): boolean {
    if (!isCustomPreset(preset)) return false
    const modelId = preset.userValues?.modelId
    if (typeof modelId !== 'string') return false
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    return new RegExp(`(?:^|[/:._-])${escaped}(?:$|[/:._-])`, 'iu').test(modelId)
}

/**
 * Turns the Custom profile's compatibility/capability switches into the
 * ordinary ModelPreset fields consumed by request.ts. The persisted preset is
 * never mutated: this is a request-scoped view.
 */
export function resolveCustomRuntimePreset(preset: ModelPreset): ModelPreset {
    if (!isCustomPreset(preset)) return preset

    const capabilities: RegistryCapability[] = ['streaming', 'tools', 'json']
    if (preset.imageInput) capabilities.push('vision')
    const reasoningEffort = nonEmptyString(preset.userValues?.reasoning_effort)
    if (reasoningEffort && reasoningEffort !== 'none') {
        capabilities.push('reasoning')
    }

    return {
        ...preset,
        profileSnapshot: {
            ...preset.profileSnapshot,
            capabilities,
        },
        imageInput: preset.imageInput ?? false,
        foldSystemPrompt: preset.foldSystemPrompt ?? false,
        keepFirstSystemPrompt: !!preset.foldSystemPrompt && (preset.keepFirstSystemPrompt ?? false),
        alternateRole: preset.alternateRole ?? false,
        startWithUserInput: preset.startWithUserInput ?? false,
    }
}

/**
 * Applies Custom-only generation fields after ordinary schema mapping and
 * before the freeform additional-parameters textarea. This keeps
 * format switching safe: only fields understood by the selected wire format
 * are emitted, while the user's values for other formats remain stored.
 */
export function applyCustomRequestValues(
    preset: ModelPreset,
    body: Record<string, unknown>,
    headers: Record<string, string>,
): void {
    if (!isCustomPreset(preset)) return

    const values = preset.userValues ?? {}
    const format = resolveCustomFormat(preset)
    const maxTokens = finiteNumber(values.max_tokens)
    const temperature = finiteNumber(values.temperature)
    const topP = finiteNumber(values.top_p)
    const topK = finiteNumber(values.top_k)
    const frequencyPenalty = finiteNumber(values.frequency_penalty)
    const presencePenalty = finiteNumber(values.presence_penalty)
    const repetitionPenalty = finiteNumber(values.repetition_penalty)
    const minP = finiteNumber(values.min_p)
    const topA = finiteNumber(values.top_a)
    const seed = finiteNumber(values.seed)
    const stop = stringArray(values[CUSTOM_STOP_KEY])
    const rawReasoningEffort = nonEmptyString(values.reasoning_effort)
    const budgetReasoning = rawReasoningEffort === 'budget'
    const reasoningEffort = rawReasoningEffort === 'none' || budgetReasoning
        ? undefined
        : rawReasoningEffort
    const thinkingTokens = resolveThinkingBudget(preset, 'reasoning_effort') ?? 1024
    const verbosity = nonEmptyString(values.verbosity)
    const promptCacheMode = values.prompt_cache_mode === 'implicit'
        || values.prompt_cache_mode === 'explicit'
        ? values.prompt_cache_mode
        : undefined

    if (format === 'google-gemini') {
        const generationConfig = isPlainObject(body.generationConfig)
            ? { ...body.generationConfig }
            : {}
        assignDefined(generationConfig, 'maxOutputTokens', maxTokens)
        assignDefined(generationConfig, 'temperature', temperature)
        assignDefined(generationConfig, 'topP', topP)
        assignDefined(generationConfig, 'topK', topK)
        assignDefined(generationConfig, 'frequencyPenalty', frequencyPenalty)
        assignDefined(generationConfig, 'presencePenalty', presencePenalty)
        assignDefined(generationConfig, 'seed', seed)
        if (
            reasoningEffort
            && ['minimal', 'low', 'medium', 'high'].includes(reasoningEffort)
        ) {
            const thinkingConfig = isPlainObject(generationConfig.thinkingConfig)
                ? { ...generationConfig.thinkingConfig }
                : {}
            thinkingConfig.thinkingLevel = reasoningEffort
            generationConfig.thinkingConfig = thinkingConfig
        } else if (budgetReasoning) {
            const thinkingConfig = isPlainObject(generationConfig.thinkingConfig)
                ? { ...generationConfig.thinkingConfig }
                : {}
            thinkingConfig.thinkingBudget = thinkingTokens
            generationConfig.thinkingConfig = thinkingConfig
        }
        if (stop) generationConfig.stopSequences = stop
        if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig
    } else {
        const maxKey = format === 'openai-responses'
            ? 'max_output_tokens'
            : format === 'openai-chat' && hasCustomFlag(preset, 'OAICompletionTokens')
                ? 'max_completion_tokens'
                : 'max_tokens'
        assignDefined(body, maxKey, maxTokens)
        assignDefined(body, 'temperature', temperature)
        assignDefined(body, 'top_p', topP)
        assignDefined(body, 'top_k', topK)
        if (format !== 'anthropic-messages') {
            assignDefined(body, 'frequency_penalty', frequencyPenalty)
            assignDefined(body, 'presence_penalty', presencePenalty)
            assignDefined(body, 'repetition_penalty', repetitionPenalty)
            assignDefined(body, 'min_p', minP)
            assignDefined(body, 'top_a', topA)
            assignDefined(body, 'seed', seed)
        }
        if (stop) body[format === 'anthropic-messages' ? 'stop_sequences' : 'stop'] = stop

        if (format === 'anthropic-messages' && (budgetReasoning || reasoningEffort)) {
            body.thinking = budgetReasoning
                ? { type: 'enabled', budget_tokens: thinkingTokens }
                : { type: 'adaptive' }
        }
        if (
            format === 'anthropic-messages'
            && !budgetReasoning
            && reasoningEffort
            && ['low', 'medium', 'high', 'max', 'xhigh'].includes(reasoningEffort)
        ) {
            const outputConfig = isPlainObject(body.output_config)
                ? { ...body.output_config }
                : {}
            outputConfig.effort = reasoningEffort
            body.output_config = outputConfig
        } else if (format === 'openai-responses') {
            if (reasoningEffort) {
                const reasoning = isPlainObject(body.reasoning) ? { ...body.reasoning } : {}
                reasoning.effort = reasoningEffort
                body.reasoning = reasoning
            }
            if (verbosity) {
                const text = isPlainObject(body.text) ? { ...body.text } : {}
                text.verbosity = verbosity
                body.text = text
            }
        } else if (format === 'openai-chat') {
            assignDefined(body, 'reasoning_effort', reasoningEffort)
            assignDefined(body, 'verbosity', verbosity)
        }

        if (
            (format === 'openai-chat' || format === 'openai-responses')
            && promptCacheMode
        ) {
            const options = isPlainObject(body.prompt_cache_options)
                ? { ...body.prompt_cache_options }
                : {}
            options.mode = promptCacheMode
            body.prompt_cache_options = options
        }
    }
    if (format === 'anthropic-messages' && !hasHeader(headers, 'anthropic-version')) {
        headers['anthropic-version'] = '2023-06-01'
    }

}

/**
 * Gemini's curated profiles store an API base and let the adapter append
 * `/models/{id}:generateContent`. Custom users generally paste the complete
 * endpoint instead. Keep that URL intact, only swapping the method suffix when
 * streaming changes, while preserving auth/query parameters.
 */
export function resolveCustomGeminiEndpoint(
    preset: ModelPreset,
    preparedUrl: string,
    modelId: string,
    stream: boolean,
): string | undefined {
    if (!isCustomPreset(preset) || resolveCustomFormat(preset) !== 'google-gemini') {
        return undefined
    }
    const target = stream ? 'streamGenerateContent' : 'generateContent'
    const url = new URL(preparedUrl)
    if (/:(?:streamGenerateContent|generateContent)$/.test(url.pathname)) {
        url.pathname = url.pathname.replace(
            /:(?:streamGenerateContent|generateContent)$/,
            `:${target}`,
        )
    } else {
        const trimmed = url.pathname.replace(/\/+$/, '')
        url.pathname = `${trimmed}/models/${encodeURIComponent(modelId)}:${target}`
    }
    if (stream) url.searchParams.set('alt', 'sse')
    else url.searchParams.delete('alt')
    return url.toString()
}

function finiteNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function nonEmptyString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined
}

function stringArray(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) return undefined
    const items = value.filter((item): item is string => typeof item === 'string' && item.length > 0)
    return items.length > 0 ? items : undefined
}

function assignDefined(target: Record<string, unknown>, key: string, value: unknown): void {
    if (value !== undefined) target[key] = value
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
    const normalized = name.toLowerCase()
    return Object.keys(headers).some(key => key.toLowerCase() === normalized)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value)
}
