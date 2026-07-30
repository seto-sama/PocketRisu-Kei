import type { GeminiPromptCachingConfig } from './cache/geminiContextCache'

export type AdapterKind =
    | 'openai-compatible'
    | 'openai-responses'
    | 'anthropic-messages'
    | 'google-gemini'
    | 'amazon-bedrock'
    | 'custom'
    | 'plugin'
    | 'echo'

export type AuthKind =
    | 'none'
    | 'bearer'
    | 'x-api-key'
    | 'x-goog-api-key'
    | 'query'
    | 'google-service-account'
    | 'aws-bedrock'

export type EndpointKind =
    | 'static'
    | 'cloudflare-ai'
    | 'amazon-bedrock'
    | 'amazon-bedrock-mantle'
    | 'vertex-openai'
    | 'vertex-gemini'

export type RegistryFieldType =
    | 'string'
    | 'number'
    | 'integer'
    | 'boolean'
    | 'json'
    | 'stringArray'
    | 'keyValue'

export type RegistryWidget =
    | 'text'
    | 'secret'
    | 'textarea'
    | 'number-input'
    | 'slider'
    | 'select'
    | 'segmented'
    | 'toggle'
    | 'combobox'
    | 'string-array'
    | 'json'
    | 'key-value'

export type UiVisibility = 'info' | 'basic' | 'advanced' | 'hidden'

export type RegistryMappingTarget =
    | 'body'
    | 'header'
    | 'query'
    | 'auth'
    | 'custom'

/**
 * Provider-independent meaning of a profile field.
 *
 * `key` is the snapshot/user-value storage key and `mapsTo` is the provider
 * wire destination. Neither is a stable way to identify a generation setting
 * across protocols, so runtime policy should prefer this semantic when it is
 * present and retain key/path matching only for older imported snapshots.
 */
export type RegistryFieldSemantic =
    | 'modelId'
    | 'maxOutputTokens'
    | 'temperature'
    | 'reasoningEffort'
    | 'thinkingBudgetTokens'

export interface RegistryMapping {
    target: RegistryMappingTarget
    path: string
}

export interface RegistryFieldSchema {
    key: string
    semantic?: RegistryFieldSemantic
    type: RegistryFieldType
    label: string
    labelI18n?: Record<string, string>
    /** Optional app-language keys for built-in profiles that share labels/help
     * with the regular settings UI. The literal strings remain fallbacks for
     * remote/custom registries and unknown keys. */
    labelKey?: string
    helpKey?: string
    description?: string
    descriptionI18n?: Record<string, string>
    default?: unknown
    enum?: Array<{ value: string | number | boolean; label: string }>
    min?: number
    max?: number
    step?: number
    required?: boolean
    secret?: boolean
    mapsTo?: RegistryMapping
}

export interface RegistrySimpleCondition {
    key: string
    equals?: unknown
    notEquals?: unknown
}

export interface RegistryUiField {
    key: string
    widget: RegistryWidget
    visibility: UiVisibility
    /** Optional settings-page presentation for controls that need to mirror
     * the compact label/help-left, control-right row grammar. */
    layout?: 'block' | 'row'
    fixed?: number
    disableable?: boolean
    group?: string
    order?: number
    placeholder?: string
    help?: string
    showIf?: RegistrySimpleCondition
}

export interface RegistryUiGroup {
    id: string
    label: string
    /** Optional app-language key for bundled groups. */
    labelKey?: string
    labelI18n?: Record<string, string>
    order?: number
}

export interface RegistryUiSchema {
    groups: RegistryUiGroup[]
    fields: RegistryUiField[]
}

export interface RegistryEndpoint {
    kind: EndpointKind
    url?: string
    path?: string
}

export interface RegistryAuth {
    kind: AuthKind
    fields?: string[]
}

export type RegistryCapability =
    | 'streaming'
    | 'vision'
    | 'image-output'
    | 'tools'
    | 'json'
    | 'reasoning'
    | 'cache'

export interface ModelLimits {
    known?: boolean
    contextWindowTokens?: number
    maxOutputTokens?: number
    sourceUrls?: string[]
    notes?: string
    notesI18n?: Record<string, string>
}

export type RegistryProfileStatus =
    | 'current'
    | 'outdated'
    | 'deprecated'

export interface BaseProviderDefinition {
    id: string
    displayName: string
    // Optional catalog grouping for related wire APIs owned by one vendor.
    // The profile browser renders related providers in one shared group.
    providerGroupId?: string
    providerGroupDisplayName?: string
    adapterKind: AdapterKind
    authKinds: AuthKind[]
    endpointKinds: EndpointKind[]
    defaultHeaders?: Record<string, string>
    defaultBody?: Record<string, unknown>
    requestSchema: RegistryFieldSchema[]
    uiSchema: RegistryUiSchema
    capabilities?: RegistryCapability[]
    limits?: ModelLimits
    sourceUrls: string[]
}

export type RegistryTokenizer =
    | 'tik'
    | 'mistral'
    | 'novelai'
    | 'claude'
    | 'llama'
    | 'llama3'
    | 'novellist'
    | 'gemma'
    | 'cohere'
    | 'deepseek'

export interface ModelProfile {
    id: string
    // Precise timestamp (epoch millis) of the profile's last revision. Basis for
    // the per-preset "update available" hint (custom-profiles plan): compared
    // against the preset's recorded sourceProfile.profileUpdatedAt. Optional —
    // legacy/unstamped profiles compare as "unknown" (no hint).
    updatedAt?: number
    displayName: string
    displayNameI18n?: Record<string, string>
    providerBaseId: string
    profileStatus: RegistryProfileStatus
    statusReason?: string
    statusSourceUrls?: string[]
    description?: string
    /** Optional app help-language key for bundled profile descriptions. */
    helpKey?: string
    descriptionI18n?: Record<string, string>
    modelReleaseDate?: string
    knowledgeCutoff?: string
    tags?: string[]
    sortOrder?: number
    recommendedTokenizer?: RegistryTokenizer
    modelId: string
    endpoint: RegistryEndpoint
    auth: RegistryAuth
    defaults: Record<string, unknown>
    schema: RegistryFieldSchema[]
    uiSchema: RegistryUiSchema
    bodyTemplate?: Record<string, unknown>
    headerTemplate?: Record<string, string>
    capabilities?: RegistryCapability[]
    limits?: ModelLimits
    sourceUrls: string[]
}

export interface ModelPresetSourceProfile {
    registryId: string
    profileId: string
    fetchedAt: number
    // The source profile's `updatedAt` captured at creation/replace time.
    // The "update available" hint compares this against the current profile's
    // updatedAt (matched by registryId + profileId). Undefined => no hint.
    profileUpdatedAt?: number
}

export interface ResolvedModelProfileSnapshot {
    profileId: string
    providerBaseId: string
    adapterKind: AdapterKind
    auth: RegistryAuth
    endpoint: RegistryEndpoint
    modelId: string
    schema: RegistryFieldSchema[]
    uiSchema: RegistryUiSchema
    defaults: Record<string, unknown>
    bodyTemplate?: Record<string, unknown>
    headerTemplate?: Record<string, string>
    capabilities?: RegistryCapability[]
    limits?: ModelLimits
    recommendedTokenizer?: RegistryTokenizer
}

export interface ModelPreset {
    id: string
    name: string
    notes?: string
    sourceProfile?: ModelPresetSourceProfile
    migrationSource?: {
        sourceKind: string
        sourcePath: string
        configHash: string
    }
    profileSnapshot: ResolvedModelProfileSnapshot
    userValues: Record<string, unknown>
    orphanValues?: Record<string, unknown>
    customBody?: Record<string, unknown>
    customHeaders?: Record<string, string>
    // Freeform "additional parameters" textarea. One line per entry.
    // Same legacy syntax as customModels[].params, parsed via
    // applyAdditionalParameters at wire time. Supports:
    //   key=value           — body[key] = value (auto type: string/num/bool/null)
    //   key=json::{...}     — body[key] = JSON.parse(...)
    //   header::Name=value  — headers[Name] = value
    //   key={{none}}        — delete body[key] (or headers if header::)
    // Stored as raw text so the UI round-trips exactly what the user typed.
    additionalParamsText?: string
    // Per-ModelPreset tokenizer override. When undefined, the tokenize call
    // falls back to profile.recommendedTokenizer, then db.customTokenizer
    // (legacy global), then a sane default based on the adapter kind.
    tokenizerOverride?: RegistryTokenizer
    // Per-ModelPreset streaming. Independent of the global db.useStreaming.
    // Default off (undefined/false). Forced off when the profile does not
    // declare the 'streaming' capability.
    useStreaming?: boolean
    // Decoupled streaming: send the request over the streaming wire (so the
    // provider/proxy applies its more lenient streaming limits — output cap,
    // timeout) but buffer the whole SSE response and surface the final text at
    // once instead of token-by-token. Only meaningful when useStreaming is on.
    // Default off (undefined/false) → ordinary token-by-token streaming.
    decoupledStreaming?: boolean
    // Anthropic Messages request controls. These are preset-scoped because both
    // options change the provider wire and must not leak to other Claude presets.
    // They are only honored for the first-party `anthropic` provider.
    claude1HourCaching?: boolean
    claudeBatching?: boolean
    // Per-ModelPreset tool use (capabilities Stage 1). Default off
    // (undefined/false): while off, the request stays text-only so existing
    // bound chats are never routed through the tool loop. Only meaningful when
    // the profile declares the 'tools' capability. Tool runs force non-streaming.
    toolUse?: boolean
    // Per-ModelPreset model-ability flags. The classic (custom model) path lets
    // users toggle LLMFlags directly; the preset path had no equivalent, so it
    // could neither attach images nor normalize system/role for models that need
    // it (e.g. Ollama Gemma3 — no native system role). These mirror the relevant
    // LLMFlags and feed reformater()/the vision gate in requestModelPreset. All
    // default off → byte-identical to the prior text-only, no-attachment behavior.
    //
    // Send attached images. Additive opt-in for profiles whose snapshot does not
    // declare the 'vision' capability (e.g. ollama / openai-compatible); profiles
    // that DO declare 'vision' already send images and ignore this.
    imageInput?: boolean
    // Per-preset image processing quality for the shared OpenAI/Vertex profiles.
    // OpenAI consumes auto/low/high as image detail; Gemini maps
    // low/medium/high to mediaResolution and treats auto as provider default.
    gptVisionQuality?: 'auto' | 'low' | 'medium' | 'high'
    // Fold non-leading system messages into user turns (role + content rewrite via
    // db.systemRoleReplacement/ContentReplacement). For models without a native
    // system role. Maps to the absence of LLMFlags.hasFullSystemPrompt.
    foldSystemPrompt?: boolean
    // When folding, keep the leading system block as a real system message instead
    // of rewriting it. Only meaningful with foldSystemPrompt on. Maps to
    // LLMFlags.hasFirstSystemPrompt.
    keepFirstSystemPrompt?: boolean
    // Merge consecutive same-role turns into one. For models that require strictly
    // alternating roles (e.g. Gemma). Maps to LLMFlags.requiresAlternateRole.
    alternateRole?: boolean
    // Prepend an empty user turn when the conversation does not start with user.
    // For models that reject a non-user first turn. Maps to
    // LLMFlags.mustStartWithUserInput.
    startWithUserInput?: boolean
    // Per-ModelPreset input (context) token budget — how much prompt to send,
    // mirroring the global db.maxContext but per binding. Empty → 65000 default,
    // clamped to the profile's contextWindowTokens when known. NOT the output
    // limit (that is the profile's max_tokens param).
    maxContext?: number
    // Gemini explicit context caching (google-gemini adapter + AI Studio key
    // auth, main chat only). The cache boundary comes from the native
    // message.cachePoint infra (cache prompt card / automaticCachePoint), not
    // from this config. Additive optional — absent/disabled => no cache calls,
    // requests byte-identical to before. Runtime cache state lives in
    // localStorage, never in the db.
    promptCaching?: GeminiPromptCachingConfig
    apiKeyRef?: string
    inlineCredential?: unknown
    pinned?: boolean
    /** Optional user-defined folder used by the model-preset picker. */
    folderId?: string
    order?: number
    createdAt: number
    updatedAt: number
}

export type ModelBinding =
    | { kind: 'modelPreset'; id: string }
    | { kind: 'pluginModel'; id: string }
    | { kind: 'manualRequired'; reason: string; legacySource?: string }
    | { kind: 'none' }

export type ResolvedTask =
    | 'model'
    | 'submodel'
    | 'memory'
    | 'emotion'
    | 'translate'
    | 'otherAx'

export type TaskModelBindings = Partial<Record<ResolvedTask, ModelBinding>>

export interface ModelBindingFields {
    modelBinding?: ModelBinding
    subModelBinding?: ModelBinding
    taskModelBindings?: TaskModelBindings
}

/**
 * P4 dual-regime model binding (plan v6 §7, model-preset-p4-task). The full
 * per-chat model configuration as ONE bundle, mirroring the classic global
 * model config 1:1 — main↔db.aiModel, sub↔db.subModel,
 * separateAux↔db.seperateModelsForAxModels, aux↔db.seperateModels — but each
 * slot holds a ModelPreset id instead of a model-id string. Lives per-chat
 * (chat.modelBinding) with a global default (db.defaultModelBinding) copied
 * into new chats.
 *
 * Resolution (resolveChatModelBinding): main/sub unresolved → block; aux
 * unresolved → fall back to sub ("use default sub model"). "Unresolved" =
 * undefined OR a dangling id whose preset no longer exists; both are treated
 * identically (dangling ids are never auto-cleared, to allow re-import
 * reconnection).
 */
export interface ModelBindingSet {
    main?: string
    sub?: string
    separateAux: boolean
    aux: {
        memory?: string
        emotion?: string
        translate?: string
        otherAx?: string
    }
}

/** A fully-normalized empty binding bundle (every slot a defined primitive, so
 * `bind:value` / `bind:checked` on a $bindable never sees undefined). Shared by
 * the sidebar seeder and the new-chat default seeder. */
export function emptyModelBinding(): ModelBindingSet {
    return { main: '', sub: '', separateAux: false, aux: { memory: '', emotion: '', translate: '', otherAx: '' } }
}

export interface ApiKeyPoolEntry {
    id: string
    name: string
    provider?: string
    key: string
    order?: number
    createdAt: number
    updatedAt: number
}

export interface RegistryCache {
    schemaVersion: 4
    registries: Record<string, {
        fetchedAt: number
        indexVersion?: number
        // The base URL this entry was synced from + the catalog content hash, so
        // the gate-skip is atomic with the cache (a changed source or hash both
        // force a re-download). Per-item hashes are reserved for a future
        // differential download. Absent on the build-time bundled entry.
        source?: string
        contentHash?: string
        profileHashes?: Record<string, string>
        baseProviderHashes?: Record<string, string>
        profiles?: Record<string, ModelProfile>
        baseProviders?: Record<string, BaseProviderDefinition>
    }>
}

// v5 migration scope (plan v5): customModels-only. Everything else (provider
// keys, reverse-proxy fields, native aiModel strings, botPreset overrides,
// task bindings, bias, fallbacks) stays in the legacy DB untouched and is
// surfaced via the "Legacy Info" UI. Summary/report types are sized to that.
export interface ModelPresetMigrationSummary {
    version: number
    appliedAt: number
    createdModelPresetCount: number
    manualRequiredCount: number
    warnings: string[]
}

export interface PlannedModelPreset {
    id: string
    name: string
    sourceKind: string
    sourcePath: string
    profileId: string
    modelId?: string
    endpointUrl?: string
    credentialSource?: {
        kind: 'legacyKey'
        sourcePath: string
    }
    userValues: Record<string, unknown>
}

export interface ManualMigrationItem {
    sourcePath: string
    reason: string
    legacySource?: string
}

export interface MigrationReport {
    version: 1
    createdModelPresets: PlannedModelPreset[]
    manualRequired: ManualMigrationItem[]
    warnings: string[]
}

export type SnapshotChangeKind = 'added' | 'removed' | 'modified'

export interface SnapshotSchemaFieldChange {
    key: string
    changeKind: SnapshotChangeKind
    fromType?: RegistryFieldType
    toType?: RegistryFieldType
    modifiedAttributes?: string[]
}

export interface SnapshotUiFieldChange {
    key: string
    changeKind: SnapshotChangeKind
    modifiedAttributes?: string[]
}

export interface SnapshotUiGroupChange {
    id: string
    changeKind: SnapshotChangeKind
}

export interface SnapshotDiff {
    profileId: string
    providerBaseChanged: boolean
    adapterKindChanged: boolean
    modelIdChanged: boolean
    endpointChanged: boolean
    authChanged: boolean
    capabilitiesChanged: boolean
    defaultsChanged: boolean
    bodyTemplateChanged: boolean
    headerTemplateChanged: boolean
    schemaChanges: SnapshotSchemaFieldChange[]
    uiSchemaFieldChanges: SnapshotUiFieldChange[]
    uiSchemaGroupChanges: SnapshotUiGroupChange[]
}

export interface OrphanedUserValue {
    key: string
    value: unknown
    reason: 'removed' | 'type-changed'
}

export interface ProfileSnapshotUpdateResult {
    preset: ModelPreset
    diff: SnapshotDiff
    movedToOrphan: OrphanedUserValue[]
    newFieldKeys: string[]
}
