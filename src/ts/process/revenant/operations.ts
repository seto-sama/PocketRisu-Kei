import { v4 as uuidv4 } from 'uuid'
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
        && (
            context.target === null
            || (
                context.target
                && context.target.kind === 'chat-message'
                && (context.target.messageChatId === null || typeof context.target.messageChatId === 'string')
                && Number.isInteger(context.target.messageIndex)
                && Number.isInteger(context.target.swipeId)
            )
        )
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
