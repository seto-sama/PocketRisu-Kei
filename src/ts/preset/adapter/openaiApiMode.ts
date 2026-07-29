import type {
    AdapterKind,
    ModelPreset,
} from '../types'
import type { AdapterPreparedRequest } from './types'
import { resolveCustomAdapterKind } from './customPreset'

export const OPENAI_API_MODE_KEY = 'openaiApiMode'

export type OpenAiApiMode = 'completions' | 'responses'

export function resolveOpenAiApiMode(preset: ModelPreset): OpenAiApiMode | undefined {
    const field = preset.profileSnapshot.schema.find(
        candidate => candidate.key === OPENAI_API_MODE_KEY,
    )
    if (!field) return undefined

    const selected = preset.userValues[OPENAI_API_MODE_KEY] ?? field.default
    return selected === 'completions' || selected === 'responses'
        ? selected
        : undefined
}

export function resolveModelPresetAdapterKind(preset: ModelPreset): AdapterKind {
    const customKind = resolveCustomAdapterKind(preset)
    if (customKind) return customKind
    const mode = resolveOpenAiApiMode(preset)
    if (mode === 'completions') return 'openai-compatible'
    if (mode === 'responses') return 'openai-responses'
    return preset.profileSnapshot.adapterKind
}

export function applyOpenAiApiModeEndpoint(
    preset: ModelPreset,
    prepared: AdapterPreparedRequest,
): void {
    const mode = resolveOpenAiApiMode(preset)
    if (!mode) return

    const targetPath = mode === 'responses' ? 'responses' : 'chat/completions'
    const match = prepared.url.match(/^([^?#]*?)([?#].*)?$/)
    const path = match?.[1] ?? prepared.url
    const suffix = match?.[2] ?? ''
    const base = path
        .replace(/\/(?:chat\/completions|responses)\/?$/, '')
        .replace(/\/+$/, '')
    prepared.url = `${base}/${targetPath}${suffix}`
}

/**
 * GPT profiles are generated with Chat Completions-shaped fields because that
 * is their default. Translate those few mode-dependent fields when the same
 * profile is sent through the Responses adapter.
 */
export function normalizeOpenAiResponsesBodyForMode(
    preset: ModelPreset,
    body: Record<string, unknown>,
): void {
    if (resolveOpenAiApiMode(preset) !== 'responses') return

    const maxOutput = body.max_completion_tokens ?? body.max_tokens
    if (body.max_output_tokens === undefined && maxOutput !== undefined) {
        body.max_output_tokens = maxOutput
    }
    delete body.max_completion_tokens
    delete body.max_tokens

    const effort = body.reasoning_effort
    if (effort !== undefined) {
        const reasoning = isPlainObject(body.reasoning) ? body.reasoning : {}
        if (reasoning.effort === undefined) reasoning.effort = effort
        body.reasoning = reasoning
        delete body.reasoning_effort
    }

    const verbosity = body.verbosity
    if (verbosity !== undefined) {
        const text = isPlainObject(body.text) ? body.text : {}
        if (text.verbosity === undefined) text.verbosity = verbosity
        body.text = text
        delete body.verbosity
    }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value)
}
