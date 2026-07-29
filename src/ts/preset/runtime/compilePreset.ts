import {
    getModelPresetAdapterDefinition,
    type HttpAdapterKind,
    type ModelPresetAdapterDefinition,
} from '../adapter/registry'
import {
    hasCustomFlag,
    hasPresetFlag,
    hasPresetImageOutput,
    isCustomPreset,
    resolveCustomRuntimePreset,
    resolvePresetAuth,
} from '../adapter/customPreset'
import { resolveModelPresetAdapterKind } from '../adapter/openaiApiMode'
import type {
    AdapterKind,
    ModelPreset,
    RegistryAuth,
    RegistryCapability,
} from '../types'
import {
    getEffectivePresetSemanticValue,
    getPresetMaxOutputTokens,
    getPresetModelIdValue,
} from './effectiveConfig'

export type ModelPresetBackend = 'http' | 'plugin' | 'echo'

export interface CompiledPresetFeatures {
    /** The concrete wire has an implementation and the profile permits it. */
    readonly streaming: boolean
    readonly tools: boolean
    readonly vision: boolean
    readonly audioInput: boolean
    readonly videoInput: boolean
    readonly imageOutput: boolean
    readonly audioOutput: boolean
    readonly mediaOutput: boolean
    readonly cache: boolean
    /** JSON Schema is supported, declared by the profile, and requested now. */
    readonly jsonSchema: boolean
}

export interface CompiledPresetAvailability {
    readonly streaming: boolean
    readonly tools: boolean
    readonly vision: boolean
    readonly cache: boolean
    /** JSON Schema is supported by both the wire and the snapshotted profile. */
    readonly jsonSchema: boolean
}

export interface CompiledPresetBehavior {
    readonly canFoldSystemPrompt: boolean
    readonly foldSystemPrompt: boolean
    readonly keepFirstSystemPrompt: boolean
    readonly alternateRole: boolean
    readonly startWithUserInput: boolean
    readonly developerRole: boolean
    readonly deepSeekThinkingInput: boolean
}

interface CompiledModelPresetBase {
    /** The persisted object. It is never mutated by compilation. */
    readonly sourcePreset: ModelPreset
    /** Request-scoped normalized view, primarily for the Developer/Custom profile. */
    readonly preset: ModelPreset
    readonly backend: ModelPresetBackend
    readonly adapterKind: AdapterKind
    readonly auth: RegistryAuth
    readonly modelId: unknown
    readonly profileCapabilities: readonly RegistryCapability[]
    readonly availability: CompiledPresetAvailability
    readonly features: CompiledPresetFeatures
    readonly behavior: CompiledPresetBehavior
    readonly generation: {
        readonly maxOutputTokens?: number
        readonly temperature?: number
        readonly reasoningEffort?: string
        readonly thinkingBudgetTokens?: number
    }
}

export interface CompiledHttpModelPreset extends CompiledModelPresetBase {
    readonly backend: 'http'
    readonly adapterKind: HttpAdapterKind
    readonly adapter: ModelPresetAdapterDefinition
}

export interface CompiledPluginModelPreset extends CompiledModelPresetBase {
    readonly backend: 'plugin'
    readonly adapterKind: 'plugin'
}

export interface CompiledEchoModelPreset extends CompiledModelPresetBase {
    readonly backend: 'echo'
    readonly adapterKind: 'echo'
}

export type CompiledModelPreset =
    | CompiledHttpModelPreset
    | CompiledPluginModelPreset
    | CompiledEchoModelPreset

export interface CompileModelPresetOptions {
    /** Request-scoped opt-in from the prompt/global JSON Schema setting. */
    jsonSchemaRequested?: boolean
}

/**
 * Compile a persisted, self-contained preset snapshot into the one runtime
 * representation consumed by request orchestration and editor policy.
 *
 * Catalog lookup intentionally does not happen here. Existing presets stay
 * pinned to their snapshot; old pre-release shapes are normalized at the DB
 * load boundary before reaching this compiler.
 */
export function compileModelPreset(
    sourcePreset: ModelPreset,
    options: CompileModelPresetOptions = {},
): CompiledModelPreset {
    const preset = resolveCustomRuntimePreset(sourcePreset)
    const adapterKind = resolveModelPresetAdapterKind(preset)
    const adapter = getModelPresetAdapterDefinition(adapterKind)
    const capabilitiesDeclared = preset.profileSnapshot.capabilities !== undefined
    const profileCapabilities = Object.freeze([
        ...(preset.profileSnapshot.capabilities ?? []),
    ])
    const declared = new Set(profileCapabilities)
    const custom = isCustomPreset(preset)

    const foldingPolicy = adapter?.support.systemPromptFolding
    const canFoldSystemPrompt = adapterKind === 'plugin'
        || foldingPolicy === 'always'
        || (foldingPolicy === 'custom-only' && custom)
    const imageOutput = adapterKind === 'google-gemini'
        && hasPresetImageOutput(preset)
    const audioOutput = adapterKind === 'google-gemini'
        && hasPresetFlag(preset, 'hasAudioOutput')
    const availability: CompiledPresetAvailability = {
        streaming: adapterKind === 'plugin'
            ? declared.has('streaming')
            : adapter?.support.streaming === true
                && (!capabilitiesDeclared || declared.has('streaming')),
        tools: adapter?.support.tools === true && declared.has('tools'),
        vision: adapter?.support.vision === true,
        cache: adapterKind === 'google-gemini' && declared.has('cache'),
        jsonSchema: adapter?.support.jsonSchema === true && declared.has('json'),
    }

    const features: CompiledPresetFeatures = {
        streaming: availability.streaming,
        tools: availability.tools && preset.toolUse === true,
        vision: availability.vision
            && (declared.has('vision') || preset.imageInput === true),
        audioInput: adapterKind === 'google-gemini'
            && hasPresetFlag(preset, 'hasAudioInput'),
        videoInput: adapterKind === 'google-gemini'
            && hasPresetFlag(preset, 'hasVideoInput'),
        imageOutput,
        audioOutput,
        mediaOutput: imageOutput
            || audioOutput
            || (
                adapterKind === 'openai-compatible'
                && preset.profileSnapshot.providerBaseId === 'openai'
                && preset.profileSnapshot.endpoint.url?.includes('/images/generations') === true
            ),
        cache: availability.cache && preset.promptCaching?.enabled === true,
        jsonSchema:
            availability.jsonSchema
            && options.jsonSchemaRequested === true,
    }
    const behavior: CompiledPresetBehavior = {
        canFoldSystemPrompt,
        foldSystemPrompt: canFoldSystemPrompt && preset.foldSystemPrompt === true,
        keepFirstSystemPrompt:
            canFoldSystemPrompt
            && preset.foldSystemPrompt === true
            && preset.keepFirstSystemPrompt === true,
        alternateRole: preset.alternateRole === true,
        startWithUserInput: preset.startWithUserInput === true,
        developerRole:
            hasCustomFlag(preset, 'DeveloperRole')
            && (
                adapterKind === 'openai-compatible'
                || adapterKind === 'openai-responses'
            ),
        deepSeekThinkingInput:
            adapterKind === 'openai-compatible'
            && hasPresetFlag(preset, 'deepSeekThinkingInput'),
    }
    const common = {
        sourcePreset,
        preset,
        adapterKind,
        auth: resolvePresetAuth(preset),
        modelId: getPresetModelIdValue(preset),
        profileCapabilities,
        availability,
        features,
        behavior,
        generation: {
            maxOutputTokens: getPresetMaxOutputTokens(preset),
            temperature: finiteNumber(getEffectivePresetSemanticValue(
                preset,
                'temperature',
                ['temperature'],
            )),
            reasoningEffort: nonEmptyString(getEffectivePresetSemanticValue(
                preset,
                'reasoningEffort',
                ['reasoning_effort', 'effort', 'thinkingLevel'],
            )),
            thinkingBudgetTokens: finiteNumber(getEffectivePresetSemanticValue(
                preset,
                'thinkingBudgetTokens',
                ['thinking_tokens', 'thinkingBudget', 'thinking_budget', 'budget_tokens'],
            )),
        },
    }

    if (adapterKind === 'plugin') {
        return { ...common, backend: 'plugin', adapterKind }
    }
    if (adapterKind === 'echo') {
        return { ...common, backend: 'echo', adapterKind }
    }
    if (!adapter) {
        // `custom` should always resolve to a concrete protocol. Retaining a
        // hard error here makes malformed imported snapshots fail at the single
        // compile boundary rather than much later in a transport switch.
        throw new Error(
            `Model preset adapter "${adapterKind}" does not have an HTTP implementation.`,
        )
    }
    return {
        ...common,
        backend: 'http',
        adapterKind: adapter.kind,
        adapter,
    }
}

function finiteNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value)
        ? value
        : undefined
}

function nonEmptyString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0
        ? value
        : undefined
}
