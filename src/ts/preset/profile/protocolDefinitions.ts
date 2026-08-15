import {
    BEDROCK_CUSTOM_PATH_REGION,
    BEDROCK_REGION_KEY,
} from '../adapter/bedrockEndpoint'
import {
    CLOUDFLARE_ACCOUNT_ID_KEY,
    CLOUDFLARE_CUSTOM_PATH_ACCOUNT_ID,
} from '../adapter/cloudflareEndpoint'
import { OPENAI_API_MODE_KEY } from '../adapter/openaiApiMode'
import type {
    AdapterKind,
    AuthKind,
    EndpointKind,
    RegistryFieldSchema,
    RegistryUiField,
    RegistryUiSchema,
} from '../types'

export type ProfileProtocol =
    | 'openai-chat'
    | 'openai-responses'
    | 'anthropic'
    | 'gemini'
    | 'vertex-gemini'
    | 'bedrock'

export interface ProtocolConnectionFacts {
    authKind: AuthKind
    endpointKind: EndpointKind
    credentialKey: string
    credentialLabel?: string
}

export interface ProtocolModelFacts {
    providerId: string
    modelId: string
    family?: string
    reasoning: boolean
    supportsTemperature: boolean
    maxOutputTokens?: number
    reasoningEfforts: readonly string[]
    inputModalities: readonly string[]
    outputModalities: readonly string[]
}

export interface BuiltProtocolProfile {
    adapterKind: AdapterKind
    defaultHeaders: Record<string, string>
    modelId: string
    requestSchema: RegistryFieldSchema[]
    requestUiSchema: RegistryUiSchema
    schema: RegistryFieldSchema[]
    uiSchema: RegistryUiSchema
    updatedAt: number
}

interface ProtocolDefinition {
    adapterKind: AdapterKind
    outputPath: (facts: ProtocolModelFacts) => string
    temperaturePath: string
    reasoningPath: string
    reasoningKey: string
    supportsThinkingBudget?: boolean
    supportsReasoningControl?: boolean
    defaultHeaders?: Record<string, string>
    normalizeModelId?: (modelId: string) => string
}

// Profile-definition revision. Catalog timestamps describe model metadata, so
// protocol field/UI changes need their own revision when snapshots are refreshed.
const PROTOCOL_PROFILE_UPDATED_AT = 1786723200000

const PROTOCOL_DEFINITIONS: Record<ProfileProtocol, ProtocolDefinition> = {
    'openai-chat': {
        adapterKind: 'openai-compatible',
        outputPath: openAiChatOutputPath,
        temperaturePath: 'temperature',
        reasoningPath: 'reasoning_effort',
        reasoningKey: 'reasoning_effort',
    },
    'openai-responses': {
        adapterKind: 'openai-responses',
        outputPath: () => 'max_output_tokens',
        temperaturePath: 'temperature',
        reasoningPath: 'reasoning.effort',
        reasoningKey: 'reasoning_effort',
    },
    anthropic: {
        adapterKind: 'anthropic-messages',
        outputPath: () => 'max_tokens',
        temperaturePath: 'temperature',
        reasoningPath: 'output_config.effort',
        reasoningKey: 'effort',
        supportsThinkingBudget: true,
        defaultHeaders: { 'anthropic-version': '2023-06-01' },
    },
    gemini: {
        adapterKind: 'google-gemini',
        outputPath: () => 'generationConfig.maxOutputTokens',
        temperaturePath: 'generationConfig.temperature',
        reasoningPath: 'generationConfig.thinkingConfig.thinkingLevel',
        reasoningKey: 'thinkingLevel',
        supportsThinkingBudget: true,
    },
    'vertex-gemini': {
        adapterKind: 'google-gemini',
        outputPath: () => 'generationConfig.maxOutputTokens',
        temperaturePath: 'generationConfig.temperature',
        reasoningPath: 'generationConfig.thinkingConfig.thinkingLevel',
        reasoningKey: 'thinkingLevel',
        supportsThinkingBudget: true,
        normalizeModelId: (modelId) => modelId.replace(/^google\//, ''),
    },
    bedrock: {
        adapterKind: 'amazon-bedrock',
        outputPath: () => 'inferenceConfig.maxTokens',
        temperaturePath: 'inferenceConfig.temperature',
        reasoningPath: 'additionalModelRequestFields.reasoning_effort',
        reasoningKey: 'reasoning_effort',
        supportsReasoningControl: false,
    },
}

export function buildProtocolProfile(
    protocol: ProfileProtocol,
    connection: ProtocolConnectionFacts,
    facts: ProtocolModelFacts,
): BuiltProtocolProfile {
    const protocolDefinition = PROTOCOL_DEFINITIONS[protocol]
    const hasGptApiMode = supportsGptApiMode(protocol, facts)
    // GPT profiles keep one set of editable generation fields and can switch
    // wire mode at runtime. Their initial mode follows the catalog protocol.
    const settingsProtocol = hasGptApiMode
        ? 'openai-chat'
        : protocol
    const settingsDefinition = PROTOCOL_DEFINITIONS[settingsProtocol]
    const request = buildConnectionFields(protocol, connection)
    const profile = buildProfileFields(
        hasGptApiMode,
        protocol,
        settingsProtocol,
        settingsDefinition,
        facts,
    )

    return {
        adapterKind: protocolDefinition.adapterKind,
        defaultHeaders: { ...protocolDefinition.defaultHeaders },
        modelId: protocolDefinition.normalizeModelId?.(facts.modelId) ?? facts.modelId,
        requestSchema: request.fields,
        requestUiSchema: {
            groups: [
                { id: 'credentials', label: 'Credentials', labelI18n: { ko: '인증 정보' }, order: 1 },
                { id: 'connection', label: 'Connection', labelI18n: { ko: '연결' }, order: 1 },
            ],
            fields: request.uiFields,
        },
        schema: profile.fields,
        uiSchema: {
            groups: buildProfileGroups(settingsProtocol, facts),
            fields: profile.uiFields,
        },
        updatedAt: PROTOCOL_PROFILE_UPDATED_AT,
    }
}

function buildConnectionFields(
    protocol: ProfileProtocol,
    connection: ProtocolConnectionFacts,
): { fields: RegistryFieldSchema[]; uiFields: RegistryUiField[] } {
    const fields: RegistryFieldSchema[] = []
    const uiFields: RegistryUiField[] = []

    if (connection.authKind !== 'none') {
        fields.push({
            key: connection.credentialKey,
            type: 'string',
            label: connection.credentialLabel
                ?? (connection.authKind === 'google-service-account'
                    ? 'Service Account JSON'
                    : 'API Key'),
            description: connection.authKind === 'aws-bedrock'
                ? 'Enter a Bedrock API key, or AWS credentials JSON with accessKeyId, secretAccessKey, and optional sessionToken.'
                : undefined,
            descriptionI18n: connection.authKind === 'aws-bedrock'
                ? {
                    ko: 'Bedrock API 키를 입력하거나 accessKeyId, secretAccessKey 및 선택적 sessionToken이 포함된 AWS 자격 증명 JSON을 입력하세요.',
                }
                : undefined,
            required: true,
            secret: true,
            mapsTo: { target: 'auth', path: 'apiKey' },
        })
        uiFields.push({
            key: connection.credentialKey,
            widget: connection.authKind === 'google-service-account' ? 'textarea' : 'secret',
            visibility: 'info',
            group: 'credentials',
            order: 1,
        })
    }

    if (protocol === 'vertex-gemini') {
        fields.push({
            key: 'location',
            type: 'string',
            label: 'Location',
            labelKey: 'location',
            helpKey: 'modelPresetLocationHelp',
            default: 'global',
            mapsTo: { target: 'custom', path: 'location' },
        })
        uiFields.push({
            key: 'location',
            widget: 'text',
            visibility: 'basic',
            layout: 'row',
            group: 'connection',
            order: 2,
        })
    }

    if (connection.authKind === 'aws-bedrock') {
        fields.push({
            key: BEDROCK_REGION_KEY,
            type: 'string',
            label: 'AWS Region',
            default: 'us-east-1',
            required: true,
            mapsTo: { target: 'custom', path: BEDROCK_CUSTOM_PATH_REGION },
        })
        uiFields.push({
            key: BEDROCK_REGION_KEY,
            widget: 'text',
            visibility: 'basic',
            layout: 'row',
            group: 'connection',
            order: 2,
            placeholder: 'us-east-1',
        })
    }

    if (connection.endpointKind === 'cloudflare-ai') {
        fields.push({
            key: CLOUDFLARE_ACCOUNT_ID_KEY,
            type: 'string',
            label: 'Account ID',
            helpKey: 'cloudflareAccountIdHelp',
            required: true,
            secret: true,
            mapsTo: { target: 'custom', path: CLOUDFLARE_CUSTOM_PATH_ACCOUNT_ID },
        })
        uiFields.push({
            key: CLOUDFLARE_ACCOUNT_ID_KEY,
            widget: 'secret',
            visibility: 'basic',
            layout: 'row',
            group: 'connection',
            order: 2,
        })
    }

    return { fields, uiFields }
}

function buildProfileFields(
    hasGptApiMode: boolean,
    wireProtocol: ProfileProtocol,
    settingsProtocol: ProfileProtocol,
    definition: ProtocolDefinition,
    facts: ProtocolModelFacts,
): { fields: RegistryFieldSchema[]; uiFields: RegistryUiField[] } {
    const fields: RegistryFieldSchema[] = []
    const uiFields: RegistryUiField[] = []

    if (hasGptApiMode) {
        fields.push({
            key: OPENAI_API_MODE_KEY,
            type: 'string',
            label: 'OpenAI API',
            labelKey: 'modelPresetRequestFormat',
            helpKey: 'modelPresetRequestFormatHelp',
            required: true,
            default: wireProtocol === 'openai-responses' ? 'responses' : 'completions',
            enum: [
                { value: 'completions', label: 'Chat Completions' },
                { value: 'responses', label: 'Responses' },
            ],
            mapsTo: { target: 'custom', path: OPENAI_API_MODE_KEY },
        })
        uiFields.push({
            key: OPENAI_API_MODE_KEY,
            widget: 'select',
            visibility: 'basic',
            layout: 'row',
            group: 'connection',
            order: 1,
        })
    }

    const outputPath = definition.outputPath(facts)
    const outputKey = outputPath.split('.').at(-1) ?? 'max_tokens'
    fields.push({
        key: outputKey,
        semantic: 'maxOutputTokens',
        type: 'integer',
        label: 'Max Output Tokens',
        labelKey: 'maxResponseSize',
        helpKey: 'maxResponseSize',
        min: 1,
        max: facts.maxOutputTokens,
        mapsTo: { target: 'body', path: outputPath },
    })
    uiFields.push({
        key: outputKey,
        widget: 'slider',
        visibility: 'basic',
        group: 'generation',
        order: 1,
        layout: 'row',
        disableable: true,
    })

    if (facts.supportsTemperature) {
        fields.push({
            key: 'temperature',
            semantic: 'temperature',
            type: 'number',
            label: 'Temperature',
            labelKey: 'temperature',
            helpKey: 'tempature',
            min: 0,
            max: 2,
            step: 0.01,
            mapsTo: { target: 'body', path: definition.temperaturePath },
        })
        uiFields.push({
            key: 'temperature',
            widget: 'slider',
            visibility: 'basic',
            group: 'generation',
            order: 2,
            layout: 'row',
            disableable: true,
            fixed: 2,
        })
    }

    const reasoningOptions = uniqueStrings([
        ...facts.reasoningEfforts,
        ...(definition.supportsThinkingBudget ? ['budget'] : []),
    ])
    if (
        definition.supportsReasoningControl !== false
        && facts.reasoning
        && reasoningOptions.length > 0
    ) {
        fields.push({
            key: definition.reasoningKey,
            semantic: 'reasoningEffort',
            type: 'string',
            label: 'Reasoning Effort',
            labelKey: 'reasoningEffort',
            helpKey: 'reasoningEffort',
            enum: reasoningOptions.map((value) => ({ value, label: titleCase(value) })),
            mapsTo: { target: 'body', path: definition.reasoningPath },
        })
        uiFields.push({
            key: definition.reasoningKey,
            widget: 'select',
            visibility: 'basic',
            layout: 'row',
            group: 'connection',
            order: 4,
        })
        if (definition.supportsThinkingBudget) {
            fields.push({
                key: 'thinking_tokens',
                semantic: 'thinkingBudgetTokens',
                type: 'integer',
                label: 'Thinking Tokens',
                labelKey: 'thinkingTokens',
                helpKey: 'thinkingBudgetHelp',
                description: 'Maximum thinking-token budget used when reasoning effort is set to Budget.',
                default: 1024,
                min: 1024,
                step: 1,
            })
            uiFields.push({
                key: 'thinking_tokens',
                widget: 'number-input',
                visibility: 'basic',
                layout: 'row',
                group: 'connection',
                order: 5,
                showIf: { key: definition.reasoningKey, equals: 'budget' },
            })
        }
    }

    if (hasGptApiMode) {
        fields.push({
            key: 'verbosity',
            type: 'string',
            label: 'Verbosity',
            labelKey: 'verbosity',
            helpKey: 'verbosity',
            enum: [
                { value: 'low', label: 'Low' },
                { value: 'medium', label: 'Medium' },
                { value: 'high', label: 'High' },
            ],
            mapsTo: { target: 'body', path: 'verbosity' },
        })
        uiFields.push({
            key: 'verbosity',
            widget: 'select',
            visibility: 'basic',
            layout: 'row',
            group: 'connection',
            order: 5,
        })
    }

    if (hasGptApiMode && /(?:^|\/)gpt-5\.6(?:[-.]|$)/i.test(facts.modelId)) {
        fields.push({
            key: 'prompt_cache_mode',
            type: 'string',
            label: 'Prompt Cache Mode',
            labelKey: 'modelPresetPromptCacheMode',
            helpKey: 'modelPresetPromptCacheModeHelp',
            description: 'GPT-5.6 and later only. Implicit uses an automatic breakpoint; explicit uses only prompt cache cards/breakpoints.',
            default: 'implicit',
            enum: [
                { value: 'implicit', label: 'Implicit' },
                { value: 'explicit', label: 'Explicit' },
            ],
            mapsTo: { target: 'body', path: 'prompt_cache_options.mode' },
        })
        uiFields.push({
            key: 'prompt_cache_mode',
            widget: 'select',
            visibility: 'basic',
            layout: 'row',
            group: 'connection',
            order: 6,
        })
    }

    for (const [order, flag] of profileFlagNames(settingsProtocol, facts).entries()) {
        fields.push({
            key: `customFlag_${flag}`,
            type: 'boolean',
            label: flag,
            helpKey: profileFlagHelpKey(flag),
            description: profileFlagDescription(flag),
            default: false,
        })
        uiFields.push({
            key: `customFlag_${flag}`,
            widget: 'toggle',
            visibility: 'advanced',
            group: 'flags',
            order: order + 1,
        })
    }

    return { fields, uiFields }
}

function supportsGptApiMode(
    protocol: ProfileProtocol,
    facts: ProtocolModelFacts,
): boolean {
    if (protocol !== 'openai-chat' && protocol !== 'openai-responses') return false
    const family = facts.family?.toLowerCase()
    if (family === 'gpt-image') return false
    return family?.startsWith('gpt') === true || /gpt(?:[-._]|$)/i.test(facts.modelId)
}

type ProfileFlagName =
    | 'hasAudioInput'
    | 'hasAudioOutput'
    | 'hasVideoInput'
    | 'deepSeekThinkingInput'
    | 'deepSeekThinkingOutput'

function profileFlagNames(
    settingsProtocol: ProfileProtocol,
    facts: ProtocolModelFacts,
): ProfileFlagName[] {
    const flags: ProfileFlagName[] = []
    const isGemini = settingsProtocol === 'gemini' || settingsProtocol === 'vertex-gemini'

    if (isGemini && facts.inputModalities.includes('audio')) flags.push('hasAudioInput')
    if (isGemini && facts.outputModalities.includes('audio')) flags.push('hasAudioOutput')
    if (isGemini && facts.inputModalities.includes('video')) flags.push('hasVideoInput')
    if (settingsProtocol === 'openai-chat' && facts.providerId === 'deepseek') {
        flags.push('deepSeekThinkingInput')
    }
    if (
        settingsProtocol === 'openai-chat'
        && (facts.providerId === 'deepseek' || facts.family?.toLowerCase() === 'deepseek')
    ) {
        flags.push('deepSeekThinkingOutput')
    }
    return flags
}

function buildProfileGroups(
    settingsProtocol: ProfileProtocol,
    facts: ProtocolModelFacts,
): RegistryUiSchema['groups'] {
    const groups: RegistryUiSchema['groups'] = [
        { id: 'connection', label: 'Connection', labelKey: 'modelPresetConnectionGroup', order: 1 },
        { id: 'generation', label: 'Parameters', labelKey: 'modelPresetParametersGroup', order: 2 },
    ]
    if (profileFlagNames(settingsProtocol, facts).length > 0) {
        groups.push({
            id: 'flags',
            label: 'Custom Flags',
            labelKey: 'modelPresetCustomFlagsGroup',
            order: 4,
        })
    }
    return groups
}

function profileFlagHelpKey(flag: ProfileFlagName): string {
    switch (flag) {
        case 'hasAudioInput': return 'customFlagHasAudioInputHelp'
        case 'hasAudioOutput': return 'customFlagHasAudioOutputHelp'
        case 'hasVideoInput': return 'customFlagHasVideoInputHelp'
        case 'deepSeekThinkingInput': return 'customFlagDeepSeekThinkingInputHelp'
        case 'deepSeekThinkingOutput': return 'customFlagDeepSeekThinkingOutputHelp'
    }
}

function profileFlagDescription(flag: ProfileFlagName): string {
    switch (flag) {
        case 'hasAudioInput': return 'Allow audio attachments in model input.'
        case 'hasAudioOutput': return 'Allow generated audio in model responses.'
        case 'hasVideoInput': return 'Allow video attachments in model input.'
        case 'deepSeekThinkingInput':
            return 'Send saved reasoning from the final assistant prefill as reasoning_content.'
        case 'deepSeekThinkingOutput':
            return 'Show DeepSeek reasoning separately from the final answer.'
    }
}

function openAiChatOutputPath(facts: ProtocolModelFacts): string {
    if (
        facts.providerId === 'openai'
        && (facts.reasoning || /^(gpt-5|o[1-9])(?:$|[-.])/.test(facts.modelId))
    ) {
        return 'max_completion_tokens'
    }
    return 'max_tokens'
}

function uniqueStrings(values: readonly string[]): string[] {
    return [...new Set(values.filter(Boolean))]
}

function titleCase(value: string): string {
    return value.replace(/[_-]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase())
}
