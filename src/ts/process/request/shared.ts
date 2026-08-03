import { getDatabase } from 'src/ts/storage/database.svelte'
import { v4 as uuidv4 } from 'uuid'
import type { RequestDataArgumentExtended } from './request'
import {
    getRevenantOperationJobType,
    type RevenantGenerationContext,
    type ModelModeExtended,
} from '../revenantGeneration/types'
import {
    getLocalRevenantWorkflow,
    getRevenantWorkflowStepKey,
} from '../revenantGeneration/workflow'
import {
    applyAdditionalParameters,
    setObjectValue,
} from 'src/ts/preset/runtime/additionalParameters'

export type { ModelModeExtended } from '../revenantGeneration/types'
export {
    applyAdditionalParameters,
    setObjectValue,
} from 'src/ts/preset/runtime/additionalParameters'

export function buildGenerationContext(
    arg: RequestDataArgumentExtended,
    usageIdentity?: Pick<
        RevenantGenerationContext,
        'usageProviderId' | 'usageModelId' | 'usageServiceTier'
    >,
): RevenantGenerationContext | undefined {
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
        chatId,
        jobType,
        adapterKind: arg.revenantAdapterKind,
        streaming: arg.revenantStreaming,
        characterId,
        roomId,
        workflowId: workflow?.workflowId,
        workflowStepKey: workflow
            ? getRevenantWorkflowStepKey(jobType, arg.revenantOperationContext, chatId)
            : undefined,
        isContinuation: arg.continue === true,
        continuationPrefix: arg.continue
            ? activeChat?.message?.at(-1)?.data
            : undefined,
        operationContext: arg.revenantOperationContext,
        dispatchPolicy: arg.revenantDispatchPolicy,
        workflowDependency: arg.revenantWorkflowDependency,
        ...usageIdentity,
        onJobCreated: arg.onRevenantJobCreated,
        onJobRegistrationUnavailable: arg.onRevenantJobRegistrationUnavailable,
        onProviderStarted: arg.onRevenantProviderStarted,
    }
}

export type LLMParameter =
    | 'temperature'
    | 'top_k'
    | 'repetition_penalty'
    | 'min_p'
    | 'top_a'
    | 'top_p'
    | 'frequency_penalty'
    | 'presence_penalty'
    | 'reasoning_effort'
    | 'thinking_tokens'
    | 'verbosity'

export function getAdditionalParameters(aiModel?: string): [string, string][] {
    const db = getDatabase()

    if (!aiModel) {
        return []
    }

    if (aiModel === 'reverse_proxy') {
        return [...(db.additionalParams ?? [])]
    }

    if (!aiModel.startsWith('xcustom:::')) {
        return []
    }

    const found = db.customModels.find((model) => model.id === aiModel)
    const params = found?.params
    if (!params) {
        return []
    }

    const additionalParams: [string, string][] = []
    for (const line of params.split('\n')) {
        const split = line.split('=')
        if (split.length >= 2) {
            additionalParams.push([split[0], split.slice(1).join('=')])
        }
    }

    return additionalParams
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

export function applyParameters(
    data: Record<string, any>,
    parameters: LLMParameter[],
    rename: Partial<Record<LLMParameter, string>>,
    modelMode: ModelModeExtended,
    arg: {
        ignoreTopKIfZero?: boolean
        modelId:string
    },
): Record<string, any> {
    const db = getDatabase()

    function getEffort(effort: number) {
        switch (effort) {
            case -1: {
                return 'minimal'
            }
            case 0: {
                return 'low'
            }
            case 1: {
                return 'medium'
            }
            case 2: {
                return 'high'
            }
            default: {
                return 'medium'
            }
        }
    }

    function getVerbosity(verbosity: number) {
        switch (verbosity) {
            case 0: {
                return 'low'
            }
            case 1: {
                return 'medium'
            }
            case 2: {
                return 'high'
            }
            default: {
                return 'medium'
            }
        }
    }

    if (db.seperateParametersEnabled && (modelMode !== 'model' || db.seperateParametersByModel)) {
        let sepParams = db.seperateParameters[modelMode]
        if (db.seperateParametersByModel){
            sepParams = db.seperateParameters.overrides[arg.modelId]

            if(!sepParams){
                throw new Error(`No seperate parameters found for model ${arg.modelId} in model mode ${modelMode}. Please set parameters for this model`)
            }
        }
        if (modelMode === 'submodel') {
            sepParams = db.seperateParameters['otherAx']
        }

        for (const parameter of parameters) {
            let value: number | string = 0
            if (parameter === 'top_k' && arg.ignoreTopKIfZero && sepParams[parameter] === 0) {
                continue
            }

            switch (parameter) {
                case 'temperature': {
                    value =
                        sepParams.temperature === -1000
                            ? -1000
                            : sepParams.temperature / 100
                    break
                }
                case 'top_k': {
                    value = sepParams.top_k
                    break
                }
                case 'repetition_penalty': {
                    value = sepParams.repetition_penalty
                    break
                }
                case 'min_p': {
                    value = sepParams.min_p
                    break
                }
                case 'top_a': {
                    value = sepParams.top_a
                    break
                }
                case 'top_p': {
                    value = sepParams.top_p
                    break
                }
                case 'thinking_tokens': {
                    value = sepParams.thinking_tokens
                    break
                }
                case 'frequency_penalty': {
                    value =
                        sepParams.frequency_penalty === -1000
                            ? -1000
                            : sepParams.frequency_penalty / 100
                    break
                }
                case 'presence_penalty': {
                    value =
                        sepParams.presence_penalty === -1000
                            ? -1000
                            : sepParams.presence_penalty / 100
                    break
                }
                case 'reasoning_effort': {
                    value = getEffort(sepParams.reasoning_effort)
                    break
                }
                case 'verbosity': {
                    value = getVerbosity(sepParams.verbosity)
                    break
                }
            }

            if (
                value === -1000 ||
                value === undefined ||
                value === null ||
                (typeof value === 'number' && isNaN(value))
            ) {
                continue
            }

            data = setObjectValue(data, rename[parameter] ?? parameter, value)
        }
        return data
    }

    for (const parameter of parameters) {
        let value: number | string = 0
        if (parameter === 'top_k' && arg.ignoreTopKIfZero && db.top_k === 0) {
            continue
        }
        switch (parameter) {
            case 'temperature': {
                value = db.temperature === -1000 ? -1000 : db.temperature / 100
                break
            }
            case 'top_k': {
                value = db.top_k
                break
            }
            case 'repetition_penalty': {
                value = db.repetition_penalty
                break
            }
            case 'min_p': {
                value = db.min_p
                break
            }
            case 'top_a': {
                value = db.top_a
                break
            }
            case 'top_p': {
                value = db.top_p
                break
            }
            case 'reasoning_effort': {
                value = getEffort(db.reasoningEffort)
                break
            }
            case 'verbosity': {
                value = getVerbosity(db.verbosity)
                break
            }
            case 'frequency_penalty': {
                value = db.frequencyPenalty === -1000 ? -1000 : db.frequencyPenalty / 100
                break
            }
            case 'presence_penalty': {
                value = db.PresensePenalty === -1000 ? -1000 : db.PresensePenalty / 100
                break
            }
            case 'thinking_tokens': {
                value = db.thinkingTokens
                break
            }
        }

        if (value === -1000) {
            continue
        }

        data = setObjectValue(data, rename[parameter] ?? parameter, value)
    }
    return data
}
