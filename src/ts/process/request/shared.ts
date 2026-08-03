import { v4 as uuidv4 } from 'uuid'
import type { RequestDataArgumentExtended } from './request'
import {
    getRevenantOperationJobType,
    type RevenantGenerationRequest,
    type RevenantProviderJobSpec,
    type ModelModeExtended,
} from '../revenantGeneration/types'
import {
    getLocalRevenantWorkflow,
    getRevenantWorkflowStepKey,
} from '../revenantGeneration/workflow'

export type { ModelModeExtended } from '../revenantGeneration/types'

export function buildGenerationRequest(
    arg: RequestDataArgumentExtended,
    usageIdentity?: Pick<
        RevenantProviderJobSpec,
        'usageProviderId' | 'usageModelId' | 'usageServiceTier'
    >,
): RevenantGenerationRequest | undefined {
    const mode = arg.mode
    if (!mode) return undefined
    // Lua LLM()/simpleLLM() intentionally use the main model but do not create
    // an assistant message. Classify any model request without a message
    // generation id as auxiliary so it cannot enter chat materialization.
    const jobType: ModelModeExtended = arg.revenantOperationContext
        ? getRevenantOperationJobType(arg.revenantOperationContext)
        : mode === 'model' && !arg.chatId
            ? 'otherAx'
            : mode

    // Main generations use the message generation id because they can be
    // recovered into a chat after a client reload. Auxiliary calls only need a
    // stable id for the lifetime of this provider attempt. Auxiliary operation
    // metadata routes their result to a separate recovery queue, never to the
    // assistant-message recovery path.
    const chatId = arg.chatId ?? (arg.revenantRequestId ??= `aux-${uuidv4()}`)

    const activeChat = arg.currentChar?.chats?.[arg.currentChar.chatPage]
    const characterId = arg.currentChar?.chaId
    const roomId = activeChat?.id
    const workflow = getLocalRevenantWorkflow(characterId, roomId)
    return {
        job: {
            chatId,
            jobType,
            adapterKind: arg.revenantAdapterKind,
            streaming: arg.revenantStreaming,
            characterId,
            roomId,
            isContinuation: arg.continue === true,
            continuationPrefix: arg.continue
                ? activeChat?.message?.at(-1)?.data
                : undefined,
            operationContext: arg.revenantOperationContext,
            dispatchPolicy: arg.revenantDispatchPolicy,
            ...usageIdentity,
        },
        workflow: workflow ? {
            workflowId: workflow.workflowId,
            stepKey: getRevenantWorkflowStepKey(jobType, arg.revenantOperationContext, chatId),
            executionId: arg.revenantStepExecutionId ??= uuidv4(),
            ownerEpoch: workflow.ownerEpoch,
            dependency: arg.revenantWorkflowDependency,
        } : undefined,
        lifecycle: {
            onJobCreated: arg.onRevenantJobCreated,
            onJobRegistrationUnavailable: arg.onRevenantJobRegistrationUnavailable,
            onProviderStarted: arg.onRevenantProviderStarted,
        },
    }
}

// Drain a streaming response to its final text. Every chunk on the
// requestDataResponse boundary carries the FULL accumulated text in its first
// key (deltas are folded upstream), so the last chunk holds the complete reply.
// Used by callers that requested a streaming wire request but want a single
// string result (trigger/Lua collectors, per-preset decoupled streaming).
export async function collectStreamingText(stream: ReadableStream<{ [key: string]: string }>): Promise<string> {
    const reader = stream.getReader()
    let lastChunk = ''

    while (true) {
        const { done, value } = await reader.read()
        if (value) {
            const firstKey = Object.keys(value)[0]
            if (firstKey) {
                lastChunk = value[firstKey] ?? lastChunk
            }
        }
        if (done) {
            break
        }
    }

    return lastChunk
}
