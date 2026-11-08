import { createEntityId } from '../../id';
import type { ModelModeExtended } from './types'

export interface RevenantTranslationOperation {
    kind: 'translation'
    operationId: string
    cacheKey: string
    styleDecodes: string[]
    replaceExisting: boolean
    target: RevenantChatMessageTranslationTarget | null
}

export interface RevenantChatMessageTranslationTarget {
    kind: 'chat-message'
    messageChatId: string | null
    messageIndex: number
    swipeId: number
}

export interface RevenantHypaV3SummaryOperation {
    kind: 'hypav3-summary'
    purpose?: 'memory' | 'query'
    operationId: string
    batchId: string
    characterId: string
    roomId: string
    chatMemos: (string | null)[]
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
    data?: string
    meta?: object
    moduleId?: string
    anchorMessageId: string
    callIndex: number
}

export type RevenantOperationContext =
    | RevenantTranslationOperation
    | RevenantHypaV3SummaryOperation
    | RevenantLuaLlmOperation

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
            : createEntityId(),
    } as RevenantOperationContext
}

function hasOperationKind(value: unknown, kind: RevenantOperationContext['kind']) {
    return (value as { kind?: unknown } | null | undefined)?.kind === kind
}

export function isRevenantTranslationOperation(
    value: unknown,
): value is RevenantTranslationOperation {
    return hasOperationKind(value, 'translation')
}

export function isRevenantHypaV3SummaryOperation(
    value: unknown,
): value is RevenantHypaV3SummaryOperation {
    return hasOperationKind(value, 'hypav3-summary')
}

export function isRevenantLuaLlmOperation(
    value: unknown,
): value is RevenantLuaLlmOperation {
    return hasOperationKind(value, 'lua-llm')
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
