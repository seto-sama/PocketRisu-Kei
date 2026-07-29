import { v4 as uuidv4 } from 'uuid'
import type {
    Chat,
    Message,
    MessageGenerationInfo,
    MessagePresetInfo,
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

export interface RevenantGenerationContext {
    chatId: string
    jobType: ModelModeExtended
    characterId?: string
    roomId?: string
    isContinuation: boolean
    continuationPrefix?: string
    operationContext?: RevenantOperationContext
    /** Canonical models.dev identity used by usage-cost accounting. */
    usageProviderId?: string
    usageModelId?: string
    usageServiceTier?: 'batch'
    /** Client-only callback; omitted when the context is serialized for the server. */
    onJobCreated?: (jobId: string) => void
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
    isContinuation?: boolean
    continuationPrefix?: string
    generationInfo?: MessageGenerationInfo
    promptInfo?: MessagePresetInfo
    rerollSnapshot?: RevenantRerollSnapshot
    status: RevenantJobStatus
    rawContent: string
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
    operationContext?: RevenantOperationContext
    status: RevenantJobStatus
    rawContent: string
    error?: string
    createdAt: number
    updatedAt: number
    completedAt?: number
    materializedAt?: number
}

export interface MaterializedGeneration {
    message?: Message
    chat?: Chat
}

export function createRevenantOperation(
    operation: Omit<RevenantTranslationOperation, 'operationId'>,
): RevenantTranslationOperation
export function createRevenantOperation(
    operation: Omit<RevenantHypaV3SummaryOperation, 'operationId'>,
): RevenantHypaV3SummaryOperation
export function createRevenantOperation(
    operation: Omit<RevenantLuaLlmOperation, 'operationId'>,
): RevenantLuaLlmOperation
export function createRevenantOperation(
    operation: object,
): RevenantOperationContext {
    return {
        ...operation,
        operationId: uuidv4(),
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
