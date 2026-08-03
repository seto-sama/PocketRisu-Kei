import type {
    Chat,
    Message,
    MessageGenerationInfo,
    MessagePresetInfo,
    character,
    customscript,
    triggerscript,
} from '../../storage/database.svelte'

import type { RevenantOperationContext } from './operations'
export {
    createRevenantOperation,
    getRevenantOperationJobType,
    isRevenantHypaV3SummaryOperation,
    isRevenantLuaLlmOperation,
    isRevenantOperationContext,
    isRevenantTranslationOperation,
} from './operations'
export type {
    RevenantChatMessageTranslationTarget,
    RevenantHypaV3SummaryOperation,
    RevenantLuaLlmOperation,
    RevenantOperationContext,
    RevenantTranslationOperation,
} from './operations'

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
    emotionProcesser: 'submodel' | 'embedding'
    emotionPrompt2: string
}

export interface RevenantPostprocessRecipe {
    schemaVersion: 1
    messageChatId: string
    isContinuation: boolean
    rerollSnapshot?: RevenantRerollSnapshot
    providerBackend: 'http' | 'plugin' | 'echo'
    modelPreset: unknown
    auxProviders?: Partial<Record<'submodel' | 'emotion' | 'otherAx', {
        backend: 'http' | 'plugin' | 'echo'
        modelPreset: unknown
    }>>
    character: character
    chat: Chat
    database: RevenantPostprocessDatabaseSnapshot
    modules: unknown[]
    moduleRegexScripts: customscript[]
    moduleTriggers: triggerscript[]
}

export interface RevenantPostprocessMutationPatch {
    character?: Partial<Pick<character,
        'name' | 'desc' | 'firstMessage' | 'backgroundHTML'
        | 'replaceGlobalNote' | 'globalLore'>>
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
