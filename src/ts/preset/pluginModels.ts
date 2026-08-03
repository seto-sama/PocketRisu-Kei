import type { LLMModel } from '../model/types'
import { LLMFlags, LLMTokenizer } from '../model/types'
import type {
    BaseProviderDefinition,
    ModelProfile,
    RegistryCache,
    RegistryFieldSchema,
    RegistryTokenizer,
    RegistryUiField,
} from './types'

export const PLUGIN_MODEL_ID_PREFIX = 'pluginmodel:::'
export const PLUGIN_REGISTRY_ID = 'plugins'
export const PLUGIN_PROVIDER_BASE_ID = 'developer-plugin'

const DEFAULT_PARAMETERS = [
    'temperature',
    'top_p',
    'frequency_penalty',
    'presence_penalty',
    'repetition_penalty',
    'min_p',
    'top_a',
    'top_k',
    'thinking_tokens',
] as const

const PARAMETER_SCHEMA: Record<string, Omit<RegistryFieldSchema, 'key'>> = {
    max_tokens: {
        semantic: 'maxOutputTokens',
        type: 'integer',
        label: 'Max response tokens',
        labelKey: 'maxResponseSize',
        helpKey: 'maxResponseSize',
        default: 4096,
        min: 1,
        max: 25600,
        step: 1,
    },
    temperature: {
        semantic: 'temperature',
        type: 'number',
        label: 'Temperature',
        labelKey: 'temperature',
        helpKey: 'tempature',
        default: 1,
        min: 0,
        max: 2,
        step: 0.01,
    },
    top_p: {
        type: 'number',
        label: 'Top P',
        helpKey: 'topP',
        default: 1,
        min: 0,
        max: 1,
        step: 0.01,
    },
    top_k: {
        type: 'integer',
        label: 'Top K',
        helpKey: 'topK',
        min: 0,
        max: 500,
        step: 1,
    },
    frequency_penalty: {
        type: 'number',
        label: 'Frequency penalty',
        labelKey: 'frequencyPenalty',
        helpKey: 'frequencyPenalty',
        default: 0,
        min: -2,
        max: 2,
        step: 0.01,
    },
    presence_penalty: {
        type: 'number',
        label: 'Presence penalty',
        labelKey: 'presensePenalty',
        helpKey: 'presensePenalty',
        default: 0,
        min: -2,
        max: 2,
        step: 0.01,
    },
    repetition_penalty: {
        type: 'number',
        label: 'Repetition penalty',
        helpKey: 'repetitionPenalty',
        default: 1,
        min: 0,
        max: 2,
        step: 0.01,
    },
    min_p: {
        type: 'number',
        label: 'Min P',
        helpKey: 'minP',
        default: 0,
        min: 0,
        max: 1,
        step: 0.01,
    },
    top_a: {
        type: 'number',
        label: 'Top A',
        helpKey: 'topA',
        default: 0,
        min: 0,
        max: 1,
        step: 0.01,
    },
    thinking_tokens: {
        semantic: 'thinkingBudgetTokens',
        type: 'integer',
        label: 'Thinking tokens',
        default: 0,
        min: 0,
        step: 1,
    },
    reasoning_effort: {
        semantic: 'reasoningEffort',
        type: 'string',
        label: 'Reasoning effort',
        labelKey: 'reasoningEffort',
        helpKey: 'reasoningEffort',
        default: 'medium',
        enum: [
            { value: 'minimal', label: 'Minimal' },
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
        ],
    },
    verbosity: {
        type: 'string',
        label: 'Verbosity',
        labelKey: 'verbosity',
        helpKey: 'verbosity',
        default: 'medium',
        enum: [
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
        ],
    },
}

export interface PluginModelDefinition {
    providerName: string
    modelId: string
    displayName: string
    metadata?: LLMModel
}

function providerNameFromModelId(id: string): string {
    return id.startsWith(PLUGIN_MODEL_ID_PREFIX)
        ? id.slice(PLUGIN_MODEL_ID_PREFIX.length)
        : id
}

/**
 * Build ModelPreset entries exclusively from API 3.0 registrations. addProvider
 * also exists in the legacy 2.x API, but those providers deliberately remain
 * confined to the classic Chat Bot settings for security compatibility.
 */
export function listPluginModels(metadata: readonly LLMModel[]): PluginModelDefinition[] {
    const byProvider = new Map<string, LLMModel>()
    for (const model of metadata) {
        const providerName = providerNameFromModelId(model.id)
        if (providerName) byProvider.set(providerName, model)
    }

    return [...byProvider.entries()].map(([providerName, model]) => {
        return {
            providerName,
            modelId: `${PLUGIN_MODEL_ID_PREFIX}${providerName}`,
            displayName: model.fullName || model.name || providerName,
            metadata: model,
        }
    })
}

function parameterKeys(model?: LLMModel): string[] {
    const supported = model?.parameters?.length ? model.parameters : [...DEFAULT_PARAMETERS]
    return ['max_tokens', ...supported].filter((key, index, all) =>
        PARAMETER_SCHEMA[key] !== undefined && all.indexOf(key) === index
    )
}

function buildSchema(model?: LLMModel): RegistryFieldSchema[] {
    return parameterKeys(model).map((key) => ({
        key,
        ...PARAMETER_SCHEMA[key],
        // Plugin arguments are not a provider HTTP body, but using the body
        // mapping lets the existing prompt-parameter override feature target
        // the same sampling keys before plugin dispatch.
        mapsTo: { target: 'body', path: key },
    }))
}

const BASIC_PARAMETER_ORDER = [
    'max_tokens',
    'temperature',
    'top_k',
    'top_p',
    'min_p',
    'top_a',
    'repetition_penalty',
    'frequency_penalty',
    'presence_penalty',
]

function buildUiFields(schema: RegistryFieldSchema[]): RegistryUiField[] {
    return schema.map((field, index) => {
        const parameterOrder = BASIC_PARAMETER_ORDER.indexOf(field.key)
        if (parameterOrder >= 0) {
            return {
                key: field.key,
                widget: 'slider',
                visibility: 'basic',
                layout: 'row',
                disableable: true,
                fixed: field.step !== undefined && field.step < 1 ? 2 : undefined,
                group: 'generation',
                order: parameterOrder + 1,
            }
        }
        if (field.key === 'reasoning_effort' || field.key === 'verbosity') {
            return {
                key: field.key,
                widget: 'select',
                visibility: 'basic',
                layout: 'row',
                group: 'connection',
                order: field.key === 'reasoning_effort' ? 1 : 2,
            }
        }
        return {
            key: field.key,
            widget: field.enum
                ? 'select'
                : field.key === 'thinking_tokens'
                    ? 'number-input'
                    : 'slider',
            visibility: 'advanced',
            group: 'advanced',
            order: index + 1,
        }
    })
}

function toRegistryTokenizer(tokenizer: LLMTokenizer | undefined): RegistryTokenizer | undefined {
    switch (tokenizer) {
        case LLMTokenizer.tiktokenCl100kBase:
        case LLMTokenizer.tiktokenO200Base: return 'tik'
        case LLMTokenizer.Mistral: return 'mistral'
        case LLMTokenizer.Llama: return 'llama'
        case LLMTokenizer.Llama3: return 'llama3'
        case LLMTokenizer.NovelAI: return 'novelai'
        case LLMTokenizer.Claude: return 'claude'
        case LLMTokenizer.NovelList: return 'novellist'
        case LLMTokenizer.Gemma: return 'gemma'
        case LLMTokenizer.Cohere: return 'cohere'
        case LLMTokenizer.DeepSeek: return 'deepseek'
        default: return undefined
    }
}

function profileId(providerName: string): string {
    return `plugin:${providerName}`
}

export function buildPluginRegistry(
    definitions: readonly PluginModelDefinition[],
    description: string,
): RegistryCache {
    const profiles: Record<string, ModelProfile> = {}

    for (const definition of definitions) {
        const schema = buildSchema(definition.metadata)
        const id = profileId(definition.providerName)
        profiles[id] = {
            id,
            displayName: definition.displayName,
            providerBaseId: PLUGIN_PROVIDER_BASE_ID,
            profileStatus: 'current',
            description,
            tags: ['developer', 'plugin'],
            modelId: definition.modelId,
            endpoint: { kind: 'static', url: `plugin://${encodeURIComponent(definition.providerName)}` },
            auth: { kind: 'none', fields: [] },
            defaults: Object.fromEntries(
                schema
                    .filter((field) => field.default !== undefined)
                    .map((field) => [field.key, field.default]),
            ),
            schema,
            uiSchema: {
                groups: [
                    { id: 'connection', label: 'Connection', labelI18n: { ko: '연결' }, order: 1 },
                    { id: 'generation', label: 'Parameters', labelI18n: { ko: '파라미터' }, order: 2 },
                    { id: 'advanced', label: 'Advanced', labelI18n: { ko: '고급' }, order: 3 },
                ],
                fields: buildUiFields(schema),
            },
            capabilities: definition.metadata?.flags.includes(LLMFlags.hasStreaming)
                ? ['streaming']
                : [],
            recommendedTokenizer: toRegistryTokenizer(definition.metadata?.tokenizer),
            sourceUrls: [],
        }
    }

    const baseProvider: BaseProviderDefinition = {
        id: PLUGIN_PROVIDER_BASE_ID,
        displayName: 'Plugin',
        providerGroupId: 'plugin',
        providerGroupDisplayName: 'Plugin',
        adapterKind: 'plugin',
        authKinds: ['none'],
        endpointKinds: ['static'],
        requestSchema: [],
        uiSchema: { groups: [], fields: [] },
        capabilities: ['streaming'],
        sourceUrls: [],
    }

    return {
        schemaVersion: 4,
        registries: {
            [PLUGIN_REGISTRY_ID]: {
                fetchedAt: Date.now(),
                profiles,
                baseProviders: { [PLUGIN_PROVIDER_BASE_ID]: baseProvider },
            },
        },
    }
}

export function pluginPresetAbilityDefaults(modelId: string, metadata: readonly LLMModel[]): {
    foldSystemPrompt?: boolean
    keepFirstSystemPrompt?: boolean
    alternateRole?: boolean
    startWithUserInput?: boolean
} {
    const model = metadata.find((entry) => entry.id === modelId)
    const flags = model?.flags ?? [LLMFlags.hasFullSystemPrompt]
    return {
        foldSystemPrompt: !flags.includes(LLMFlags.hasFullSystemPrompt),
        keepFirstSystemPrompt: flags.includes(LLMFlags.hasFirstSystemPrompt),
        alternateRole: flags.includes(LLMFlags.requiresAlternateRole),
        startWithUserInput: flags.includes(LLMFlags.mustStartWithUserInput),
    }
}

export function pluginProviderName(modelId: string): string | undefined {
    if (!modelId.startsWith(PLUGIN_MODEL_ID_PREFIX)) return undefined
    const name = modelId.slice(PLUGIN_MODEL_ID_PREFIX.length)
    return name || undefined
}

/** Display the original API 3.0 provider name instead of its registry key. */
export function pluginProfileDisplayId(modelId: string): string {
    return `Plugin / ${modelId.slice(PLUGIN_MODEL_ID_PREFIX.length)}`
}

export function pluginArgumentValues(
    profile: ModelProfile | { schema: RegistryFieldSchema[]; defaults: Record<string, unknown> },
    userValues: Record<string, unknown>,
): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const field of profile.schema) {
        if (!PARAMETER_SCHEMA[field.key]) continue
        const value = Object.prototype.hasOwnProperty.call(userValues, field.key)
            ? userValues[field.key]
            : field.default ?? profile.defaults[field.key]
        if (value !== undefined) out[field.key] = value
    }
    return out
}
