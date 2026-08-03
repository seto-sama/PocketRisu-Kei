import { v4 as uuidv4 } from 'uuid'
import type {
    Chat,
    Message,
    MessageGenerationInfo,
    MessagePresetInfo,
    character,
    customscript,
    triggerscript,
} from '../../storage/database.svelte'

export type ModelModeExtended =
    | 'model'
    | 'submodel'
    | 'memory'
    | 'emotion'
    | 'otherAx'
    | 'translate'

export type RevenantJobStatus =
    | 'queued'
    | 'generating'
    | 'generated'
    | 'cancelled'
    | 'interrupted'
    | 'failed_partial'
    | 'failed'

export type RevenantWorkflowStatus = 'active' | 'completed' | 'cancelled' | 'failed'

export type RevenantWorkflowStepStatus =
    | 'pending'
    | 'running'
    | 'waiting_client'
    | 'waiting_job'
    | 'output_ready'
    | 'completed'
    | 'skipped'
    | 'failed'

export type RevenantWorkflowRecoveryPolicy =
    | 'resume'
    | 'replay_output'
    | 'at_least_once'
    | 'foreground_restart'
    | 'skip'

export interface RevenantWorkflowPlanStep {
    key: string
    kind: string
    recoveryPolicy: RevenantWorkflowRecoveryPolicy
    status?: Extract<RevenantWorkflowStepStatus, 'pending' | 'completed' | 'skipped'>
    metadata?: Record<string, unknown>
}

export interface RevenantWorkflowStep extends Omit<RevenantWorkflowPlanStep, 'status'> {
    order: number
    status: RevenantWorkflowStepStatus
    metadata?: Record<string, unknown>
    startedAt?: number
    completedAt?: number
    updatedAt: number
    executions: RevenantWorkflowStepExecution[]
}

export interface RevenantWorkflowStepExecution {
    executionId: string
    workflowId: string
    stepKey: string
    attempt: number
    status: RevenantWorkflowStepStatus
    createdAt: number
    updatedAt: number
    completedAt?: number
}

export interface RevenantClientAction {
    schemaVersion: 1
    actionId: string
    kind: string
    payload: Record<string, unknown>
}

export interface RevenantClientActionClaim {
    clientId: string
    claimedAt: number
    expiresAt: number
}

export interface RevenantWorkflow {
    workflowId: string
    characterId: string
    roomId: string
    planVersion: number
    context?: RevenantWorkflowContext
    status: RevenantWorkflowStatus
    steps: RevenantWorkflowStep[]
    createdAt: number
    updatedAt: number
    completedAt?: number
}

export interface RevenantPostprocessDatabaseSnapshot {
    presetRegex: customscript[]
    templateDefaultVariables: string
    globalChatVariables: Record<string, string>
    username: string
    userIcon: string
    personaPrompt: string
    selectedPersona: number
    personas: unknown[]
    dynamicAssets: boolean
    dynamicAssetsEditDisplay: boolean
    igpPrompt: string
    notification: boolean
    ttsEnabled: boolean
    ttsAutoSpeech: boolean
}

export interface RevenantPostprocessRecipe {
    schemaVersion: 1
    messageChatId: string
    isContinuation: boolean
    rerollSnapshot?: RevenantRerollSnapshot
    providerBackend: 'http' | 'plugin'
    modelPreset: unknown
    igpProvider?: {
        backend: 'http' | 'plugin' | 'echo'
        modelPreset: unknown
    }
    character: character
    chat: Chat
    database: RevenantPostprocessDatabaseSnapshot
    modules: unknown[]
    moduleRegexScripts: customscript[]
    moduleTriggers: triggerscript[]
}

export interface RevenantPostprocessMutationPatch {
    character?: Partial<Pick<character,
        'name' | 'desc' | 'replaceGlobalNote' | 'globalLore'>>
    database?: {
        personaPrompt?: string
        personas?: unknown[]
        globalChatVariables?: Record<string, string>
    }
}

export interface RevenantChatWorkflowContext {
    schemaVersion: 1
    kind: 'chat-generation'
    resume: {
        schemaVersion: 1
        chatProcessIndex: number
        messageChatId: string
        isContinuation: boolean
        rerollSnapshot?: RevenantRerollSnapshot
    }
    postprocess: RevenantPostprocessRecipe
}

export type RevenantWorkflowContext = RevenantChatWorkflowContext

export interface RevenantWorkflowExecution<TResult = unknown> {
    workflowId: string
    kind: 'hypav3-selection'
    status: 'queued' | 'running' | 'completed' | 'failed'
    result?: TResult
    error?: string
    createdAt: number
    updatedAt: number
    completedAt?: number
}

export function isRevenantJobActive(status: string): boolean {
    return status === 'queued' || status === 'generating'
}

export interface RevenantTranslationOperation {
    kind: 'translation'
    operationId: string
    cacheKey: string
    styleDecodes: string[]
    replaceExisting: boolean
}

export interface RevenantHypaV3SummaryOperation {
    kind: 'hypav3-summary'
    operationId: string
    batchId: string
    characterId: string
    roomId: string
    chatMemos: string[]
}

export interface RevenantLuaLlmOperation {
    kind: 'lua-llm'
    operationId: string
    executionKey: string
    replayKey: string
    characterId: string
    roomId: string
    mode: string
    code: string
    lowLevelAccess: boolean
    anchorMessageId: string
    callIndex: number
}

export type RevenantOperationContext =
    | RevenantTranslationOperation
    | RevenantHypaV3SummaryOperation
    | RevenantLuaLlmOperation

/** Provider work persisted with a durable generation job. */
export interface RevenantProviderJobSpec {
    chatId: string
    jobType: ModelModeExtended
    /** Concrete client adapter that owns parsing the provider wire response. */
    adapterKind?: string
    /** Whether the provider response uses its streaming wire format. */
    streaming?: boolean
    characterId?: string
    roomId?: string
    isContinuation: boolean
    continuationPrefix?: string
    operationContext?: RevenantOperationContext
    dispatchPolicy?: RevenantDispatchPolicy
    /** Canonical models.dev identity used by usage-cost accounting. */
    usageProviderId?: string
    usageModelId?: string
    usageServiceTier?: 'batch'
}

/** Logical workflow execution that owns one or more provider jobs. */
export interface RevenantWorkflowExecutionRef {
    workflowId: string
    stepKey: string
    executionId: string
    dependency?: RevenantWorkflowDependency
    clientAction?: {
        parentStepKey: string
        actionId: string
    }
}

/** Browser-only observation hooks; never serialized as provider job state. */
export interface RevenantGenerationLifecycle {
    onJobCreated?: (jobId: string) => void
    onJobRegistrationUnavailable?: (error?: unknown) => void
    onProviderStarted?: (startedAt: number) => void
}

/** Explicit boundary between durable work, workflow execution, and observation. */
export interface RevenantGenerationRequest {
    job: RevenantProviderJobSpec
    workflow?: RevenantWorkflowExecutionRef
    lifecycle?: RevenantGenerationLifecycle
}

export interface RevenantDispatchPolicy {
    maxConcurrent: number
    requestsPerMinute: number
}

export interface RevenantWorkflowDependency {
    kind: 'hypav3-selection'
    placeholder: string
}

export interface RevenantRerollSnapshot {
    targetMessage: Message
    targetIndex: number
    trailingMessages: Message[]
}

export interface RevenantGenerationMetadata {
    generationInfo?: unknown
    promptInfo?: unknown
    rerollSnapshot?: RevenantRerollSnapshot
}

export interface RecoverableGenerationJob {
    jobId: string
    chatId: string
    characterId?: string
    roomId?: string
    workflowId?: string
    workflowStepKey?: string
    workflowStepExecutionId?: string
    isContinuation?: boolean
    continuationPrefix?: string
    generationInfo?: MessageGenerationInfo
    promptInfo?: MessagePresetInfo
    rerollSnapshot?: RevenantRerollSnapshot
    adapterKind?: string
    streaming?: boolean
    status: RevenantJobStatus
    responseStatus?: number
    responseHeaders?: Record<string, string>
    rawBytes?: number
    projection?: RevenantNormalizedProjection
    projectionError?: string
    projectedAt?: number
    finishReason?: string
    createdAt: number
    updatedAt: number
    completedAt?: number
    materializedAt?: number
}

export interface RecoverableAuxiliaryJob {
    jobId: string
    chatId: string
    jobType: Exclude<ModelModeExtended, 'model'>
    characterId?: string
    roomId?: string
    workflowId?: string
    workflowStepKey?: string
    workflowStepExecutionId?: string
    operationContext?: RevenantOperationContext
    adapterKind?: string
    streaming?: boolean
    status: RevenantJobStatus
    responseStatus?: number
    responseHeaders?: Record<string, string>
    rawBytes?: number
    projection?: RevenantNormalizedProjection
    projectionError?: string
    projectedAt?: number
    error?: string
    dispatchedAt?: number
    createdAt: number
    updatedAt: number
    completedAt?: number
    materializedAt?: number
}

export interface RevenantNormalizedProjection {
    // Rebuildable view of the append-only provider journal. The journal, not
    // this object, remains the recovery source of truth.
    schemaVersion: 1
    source: 'server' | 'client'
    adapterKind: string
    content: string
}

export function createRevenantOperation(
    operation: Omit<RevenantTranslationOperation, 'operationId'> & { operationId?: string },
): RevenantTranslationOperation
export function createRevenantOperation(
    operation: Omit<RevenantHypaV3SummaryOperation, 'operationId'> & { operationId?: string },
): RevenantHypaV3SummaryOperation
export function createRevenantOperation(
    operation: Omit<RevenantLuaLlmOperation, 'operationId'> & { operationId?: string },
): RevenantLuaLlmOperation
export function createRevenantOperation(
    operation: object,
): RevenantOperationContext {
    return {
        ...operation,
        operationId: typeof (operation as { operationId?: unknown }).operationId === 'string'
            ? (operation as { operationId: string }).operationId
            : uuidv4(),
    } as RevenantOperationContext
}

export function isRevenantTranslationOperation(
    value: unknown,
): value is RevenantTranslationOperation {
    if (!value || typeof value !== 'object') return false
    const context = value as Partial<RevenantTranslationOperation>
    return context.kind === 'translation'
        && typeof context.operationId === 'string'
        && typeof context.cacheKey === 'string'
        && Array.isArray(context.styleDecodes)
        && context.styleDecodes.every(item => typeof item === 'string')
        && typeof context.replaceExisting === 'boolean'
}

export function isRevenantHypaV3SummaryOperation(
    value: unknown,
): value is RevenantHypaV3SummaryOperation {
    if (!value || typeof value !== 'object') return false
    const context = value as Partial<RevenantHypaV3SummaryOperation>
    return context.kind === 'hypav3-summary'
        && typeof context.operationId === 'string'
        && typeof context.characterId === 'string'
        && typeof context.roomId === 'string'
        && Array.isArray(context.chatMemos)
        && context.chatMemos.every(memo => typeof memo === 'string')
}

export function isRevenantLuaLlmOperation(
    value: unknown,
): value is RevenantLuaLlmOperation {
    if (!value || typeof value !== 'object') return false
    const context = value as Partial<RevenantLuaLlmOperation>
    return context.kind === 'lua-llm'
        && typeof context.operationId === 'string'
        && typeof context.executionKey === 'string'
        && typeof context.replayKey === 'string'
        && typeof context.characterId === 'string'
        && typeof context.roomId === 'string'
        && typeof context.mode === 'string'
        && typeof context.code === 'string'
        && typeof context.lowLevelAccess === 'boolean'
        && typeof context.anchorMessageId === 'string'
        && typeof context.callIndex === 'number'
}

export function isRevenantOperationContext(
    value: unknown,
): value is RevenantOperationContext {
    return isRevenantTranslationOperation(value)
        || isRevenantHypaV3SummaryOperation(value)
        || isRevenantLuaLlmOperation(value)
}

export function getRevenantOperationJobType(
    operation: RevenantOperationContext,
): ModelModeExtended {
    switch (operation.kind) {
        case 'translation': return 'translate'
        case 'hypav3-summary': return 'memory'
        case 'lua-llm': return 'otherAx'
    }
}
