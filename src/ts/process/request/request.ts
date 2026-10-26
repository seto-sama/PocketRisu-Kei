import { isDebugEnabled } from 'src/ts/debug'
import { Buffer } from 'buffer'
import { isNodeServer } from '../../platform'
import { asBuffer } from '../../util'
import { formatPresetMessages } from './formatMessages'
import { language } from "../../../lang";
import { customV3ProviderMetaStore } from "../../plugins/apiV3/v3.svelte";
import { risuEscape, risuUnescape } from "../../parser/parser.svelte";
import { pluginProviderRequestContextKey, pluginRuntime } from "../../plugins/pluginRuntime";
import { getCurrentCharacter, getCurrentChat, getDatabase, type Chat, type character } from "../../storage/database.svelte";
import { encodeWithTokenizer } from "../../tokenizer";
import { createEntityId } from 'src/ts/id';
import { simplifySchema, sleep } from "../../util";
import type { OpenAIChat } from "../index.svelte";
import { setInlayAsset } from "../files/inlays";
import { getTools, callTool, encodeToolCall, decodeToolCall } from "../mcp/mcp";
import type { MCPTool, RPCToolCallContent } from "../mcp/mcplib";
import { getGeneralJSONSchema, resolveRequestedJSONSchema } from "../templates/jsonSchema";
import { runTrigger } from "../triggers";
import { buildGenerationRequest, collectStreamingText, ensureRequestGenerationId, getRequestStatusNavigationId, removeEmptyChatMessages, type ModelModeExtended } from './shared';
import {
    ModelPresetAdapterError,
    isTransientOverloadMessage,
    runToolLoop,
    type AdapterCacheContext,
    type AdapterChatMessage, type AdapterChatOptions, type AdapterCredential,
    type AdapterGeneratedMedia,
    type AdapterReasoningPart, type AdapterToolCall, type AdapterToolDef,
    type ModelPresetAdapterDefinition,
} from "src/ts/preset/adapter";
import type { ModelPreset } from "src/ts/preset/types";
import {
    compileModelPreset,
    type CompiledModelPreset,
    type CompiledPluginModelPreset,
} from "src/ts/preset/runtime/compilePreset";
import { createRetryingSnapshotStream, pumpPresetStream } from "./presetStreamPump";
import {
    decodeChatCompletionResponse,
    decodeChatCompletionStream,
    openAiChatResponseDecoder,
} from 'src/ts/preset/adapter/openaiCompatible';
import { formatAdapterReasoning } from 'src/ts/preset/adapter/responseDecoder';
import { buildEchoRequest } from 'src/ts/preset/runtime/echo';
import {
    cancelOnOutputRepetition,
    normalizeOutputRepetitionLimit,
} from "./repetitionDetector";
import { requestRetryDelayMs } from './retryPolicy';
import { resolveChatModelBinding, buildModelPresetCredential, applyPromptPresetParams } from "./modelPresetBinding";
import { expandAdapterMessages, getPromptResponseId, toAdapterMessage, toolResponseText } from "./modelPresetMessages";
import { pluginArgumentValues, pluginProviderName } from "src/ts/preset/pluginModels";
import { createLLMTransportFetch } from "src/ts/network/llmTransport";
import {
    EPHEMERAL_SERVER_LLM_EXECUTION,
    SINGLE_LLM_EXECUTION,
    WORKFLOW_LLM_EXECUTION,
    type LLMExecutionPolicy,
    type LLMRequestInit,
} from "src/ts/network/transportTypes";
import {
    startStatus, appendText, endStatus, hasRequestStatus, markPhase, setStatusTokenCounter, addBadge,
    type RequestKind,
} from "src/ts/status/requestStatus";
import { setRequestStatusAction } from "src/ts/status/requestStatusActions";
import type {
    RevenantJobCreatedHandler,
    RevenantOperationContext,
    RevenantProviderJobSpec,
} from "../revenant";
import {
    appendRevenantJobRequestText,
    bindRevenantTerminalOutcome,
} from "../revenant/jobStatus";
import {
    auxiliaryResultJobIdsToConsume,
    consumeOnStreamCompletion,
    consumeRevenantAuxiliaryResults,
    reportRevenantGenerationUsage,
    type RevenantAuxiliaryResultPolicy,
} from "../revenant/transport";
import { combineProviderStartedHandlers } from "../revenant/workflow";
import { modelsDevUsageIdentity } from "../../preset/runtime/usageIdentity";
import { restoreThoughtSignatures, supportsThoughtSignatures, type ProviderContextRecord } from '../../preset/adapter/thoughtSignatures';
import { resolveWireModelId } from '../../preset/adapter/wireInvariants';
import { checkpointRevenantGeneration, queryRevenantProviderContexts } from '../revenant/transport/client';

export type ToolCall = {
    name: string;
    arguments: string;
}

export interface requestDataArgument{
    formated: OpenAIChat[]
    promptCacheKey?: string
    bias: {[key:number]:number}
    biasString?: [string,number][]
    currentChar?: character
    currentChat?: Chat
    temperature?: number
    maxTokens?:number
    PresensePenalty?: number
    frequencyPenalty?: number,
    useStreaming?:boolean
    isGroupChat?:boolean
    useEmotion?:boolean
    chatId?:string
    noMultiGen?:boolean
    schema?:string
    extractJson?:string
    imageResponse?:boolean
    previewBody?:boolean
    escape?:boolean
    tools?: MCPTool[]
    rememberToolUsage?: boolean
    forceStreaming?: boolean
    revenantAdapterKind?: string
    blockPlugins?: boolean
    /** Module that owns this auxiliary LLM request, when applicable. */
    moduleId?: string
    /** One-request model preset override used by isolated tools such as the translation dialog. */
    modelPresetOverrideId?: string
    /** Overrides the click behavior of this request's existing status toast. */
    onRequestStatusActivate?: () => void
    /** Persisted data needed to apply an auxiliary result after a reload. */
    revenantOperationContext?:RevenantOperationContext
    /** Who acknowledges the durable auxiliary result after provider completion. */
    revenantAuxiliaryResultPolicy?:Exclude<RevenantAuxiliaryResultPolicy, 'automatic'>
    revenantDispatchPolicy?:import('../revenant').RevenantDispatchPolicy
    revenantWorkflowDependency?:import('../revenant').RevenantWorkflowDependency
    /** Workflow ownership captured when the chat generation was submitted. */
    revenantWorkflowId?:string
    /** Room captured when the request was submitted; stable across UI navigation. */
    revenantRoomId?:string
    onRevenantJobCreated?:RevenantJobCreatedHandler
    onRevenantJobRegistrationUnavailable?:(error?:unknown) => void
    onRevenantProviderStarted?:(startedAt:number) => void
    onRevenantTerminal?:(terminal:import('../revenant').RevenantGenerationTerminal) => void
    /** Called once when the response stream is stopped by repetition detection. */
    onOutputRepetitionDetected?:() => void
    llmExecutionPolicy?:LLMExecutionPolicy
    revenantClientAction?: {
        workflowId: string
        parentStepKey: string
        actionId: string
        executionId: string
        /** Main plugin dispatch writes its durable provider job to model.main. */
        jobStepKey?: string
    }
}

export interface RequestDataArgumentExtended extends requestDataArgument{
    abortSignal?:AbortSignal
    mode?:ModelModeExtended
    /** Internal id shared by the wire calls of one auxiliary provider attempt. */
    revenantRequestId?:string
    /** Stable logical step attempt shared by every provider round in this request. */
    revenantStepExecutionId?:string
}

export type requestDataResponse = {
    type: 'success'|'fail'
    result: string
    noRetry?: boolean,
    // Set when a ModelPreset request actually executed tools. The outer
    // requestChatData loop must not re-run such a response (banned-charset /
    // blank-response retries), or side-effecting tools would fire twice.
    toolExecuted?: boolean,
    special?: {
        emotion?: string
    },
    failByServerError?: boolean
    retryAfterMs?: number
    model?: string
}|{
    type: "streaming",
    result: ReadableStream<StreamResponseChunk>,
    special?: {
        emotion?: string
    }
    model?: string
}|{
    type: "multiline",
    result: ['user'|'char',string][],
    special?: {
        emotion?: string
    }
    model?: string
}

export interface StreamResponseChunk{[key:string]:string}

function applyOutputRepetitionDetection(
    stream: ReadableStream<StreamResponseChunk>,
    onDetected?: () => void,
): ReadableStream<StreamResponseChunk> {
    const limit = normalizeOutputRepetitionLimit(getDatabase().outputRepetitionLimit)
    return limit === undefined ? stream : cancelOnOutputRepetition(stream, limit, onDetected)
}

export async function requestChatData(arg:requestDataArgument, model:ModelModeExtended, abortSignal:AbortSignal=null):Promise<requestDataResponse> {
    const db = getDatabase()
    const tools = arg.tools ?? (await getTools())

    if(arg.escape){
        arg.useStreaming = false
        console.warn('Escape is enabled, disabling streaming')
    }

    arg.formated = structuredClone(arg.formated).map(m => {
        m.content = risuUnescape(m.content)
        return m
    })

    let trys = 0
    while(true){
            
        if(abortSignal?.aborted){
            return {
                type: 'fail',
                result: 'Aborted'
            }
        }

        if(pluginRuntime.replacerbeforeRequest.size > 0){
            for(const replacer of pluginRuntime.replacerbeforeRequest){
                arg.formated = await replacer(arg.formated, model)
            }
        }

        try{
            const currentChar = arg.currentChar ?? getCurrentCharacter()
            if(currentChar){
                const perf = isDebugEnabled() ? performance.now() : 0
                const d = await runTrigger(currentChar, 'request', {
                    chat: arg.currentChat ?? getCurrentChat(),
                    displayMode: true,
                    displayData: JSON.stringify(arg.formated)
                })

                const got = JSON.parse(d.displayData)
                if(!got || !Array.isArray(got)){
                    throw new Error('Invalid return')
                }
                arg.formated = got
                if (isDebugEnabled()) {
                    console.debug('Trigger time', performance.now() - perf)
                }
            }
        }
        catch(e){
            console.error(e)
        }

        const da = await requestChatDataMain({
            ...arg,
            tools,
        }, model, abortSignal)

        if (da.type === 'streaming') {
            da.result = applyOutputRepetitionDetection(da.result, arg.onOutputRepetitionDetected)
        }

        // A ModelPreset response that already executed tools must be returned
        // as-is and NEVER re-run: the side effects (possibly writes) are done.
        // after-replacers still run (transform only), but in a try/catch so a
        // throwing plugin cannot lose the side-effect record either.
        if(da.type === 'success' && da.toolExecuted){
            if(arg.escape) da.result = risuEscape(da.result)
            for(const replacer of pluginRuntime.replacerafterRequest){
                try { da.result = await replacer(da.result, model) }
                catch(e){ console.error('[ModelPreset] after-replacer failed', e) }
            }
            return da
        }

        if(abortSignal?.aborted){
            return {
                type: 'fail',
                result: 'Aborted'
            }
        }

        if(da.type === 'success' && arg.escape){
            da.result = risuEscape(da.result)
        }

        if(da.type === 'success' && pluginRuntime.replacerafterRequest.size > 0){
            for(const replacer of pluginRuntime.replacerafterRequest){
                da.result = await replacer(da.result, model)
            }
        }

        if(da.type === 'success' && db.banCharacterset?.length > 0){
            let failed = false
            for(const set of db.banCharacterset){
                if (isDebugEnabled()) {
                    console.debug(set)
                }
                const checkRegex = new RegExp(`\\p{Script=${set}}`, 'gu')

                if(checkRegex.test(da.result)){
                    trys += 1
                    failed = true
                    break
                }
            }

            if(failed){
                continue
            }
        }

        if(da.type !== 'fail' || da.noRetry){
            return da
        }

        trys += 1
        const retryDelayMs = requestRetryDelayMs(da, trys, db.requestRetrys)
        if(retryDelayMs === null) return da
        if(retryDelayMs > 0) await sleep(retryDelayMs)
    }
}

export async function requestChatDataMain(arg:requestDataArgument, model:ModelModeExtended, abortSignal:AbortSignal=null):Promise<requestDataResponse> {
    // Normalize at the shared request boundary so main and auxiliary callers
    // behave consistently. Structured tool-call follow-up turns are created
    // later by the adapter loop and are therefore intentionally unaffected.
    arg.formated = removeEmptyChatMessages(arg.formated)

    const currentChat = arg.currentChat ?? getCurrentChat()
    const binding = resolveChatModelBinding(currentChat, model, arg.moduleId, arg.modelPresetOverrideId)
    if(binding.kind === 'modelPreset'){
        return executeModelPresetRequest(
            arg,
            applyPromptPresetParams(binding.preset, currentChat, model),
            abortSignal,
            model,
        )
    }
    return {
        type: 'fail',
        noRetry: true,
        result: binding.reason === 'main-unset'
            ? language.modelPresetBindingMainUnset
            : language.modelPresetBindingSubUnset,
    }
}

async function executeModelPresetRequest(
    arg: requestDataArgument,
    preset: ModelPreset,
    abortSignal: AbortSignal | null,
    model: ModelModeExtended,
): Promise<requestDataResponse> {
    const createdJobIds:string[] = []
    const callerOnJobCreated = arg.onRevenantJobCreated
    const targ:RequestDataArgumentExtended = {
        ...arg,
        onRevenantJobCreated: (jobId, createdAt) => {
            createdJobIds.push(jobId)
            callerOnJobCreated?.(jobId, createdAt)
        },
    }
    targ.mode = model

    const generationRequest = buildGenerationRequest(targ)
    const isAuxiliary = generationRequest !== undefined
        && generationRequest.job.jobType !== 'model'
    const resultPolicy:RevenantAuxiliaryResultPolicy = !isAuxiliary
        ? 'caller'
        : targ.revenantAuxiliaryResultPolicy
            ?? (targ.revenantOperationContext || targ.revenantClientAction
                ? 'caller'
                : 'automatic')
    const consumeCreatedJobs = async (jobIds: Iterable<string>) => {
        const uniqueJobIds = [...new Set(jobIds)]
        if (uniqueJobIds.length === 0) return
        try {
            await consumeRevenantAuxiliaryResults(uniqueJobIds)
        }
        catch (error) {
            // The retained job is pruned by Revenant if acknowledgement is
            // temporarily unavailable. Never discard an already-decoded LLM
            // result merely because the consume receipt failed.
            console.error('[GenerationJob] Failed to consume auxiliary result:', error)
        }
    }

    const response = await requestModelPreset(targ, preset, abortSignal, model)
    const completesMainResult = !targ.previewBody && model === 'model' && targ.chatId
        && (targ.revenantWorkflowId || targ.revenantClientAction?.workflowId)
    const completeMainResult = (content: string) => checkpointRevenantGeneration(
        targ.chatId, content, true, { providerResult: true },
    )
    if (response.type === 'streaming' && (resultPolicy === 'automatic' || completesMainResult)) {
        return {
            ...response,
            result: consumeOnStreamCompletion(
                response.result,
                async last => {
                    if (completesMainResult) await completeMainResult(last?.['0'] ?? '')
                    if (resultPolicy === 'automatic') await consumeCreatedJobs(createdJobIds)
                },
            ),
        }
    }
    if (completesMainResult && (response.type === 'success' || response.type === 'multiline')) {
        try {
            await completeMainResult(response.type === 'multiline'
                ? response.result.map(message => message[1]).join('\n') : response.result)
        } catch (error) {
            // Replaying the provider could execute completed tools twice.
            return { type: 'fail', noRetry: true, model: response.model,
                result: error instanceof Error ? error.message : String(error) }
        }
    }
    await consumeCreatedJobs(auxiliaryResultJobIdsToConsume(
        resultPolicy,
        response.type,
        createdJobIds,
    ))
    return response
}

export async function requestModelPresetData(
    arg: requestDataArgument,
    preset: ModelPreset,
    model: ModelModeExtended,
    abortSignal: AbortSignal | null = null,
): Promise<requestDataResponse> {
    return executeModelPresetRequest(arg, preset, abortSignal, model)
}


async function requestEchoPreset(
    arg: RequestDataArgumentExtended,
    preset: ModelPreset,
    abortSignal: AbortSignal | null,
    supportsStreaming: boolean,
): Promise<requestDataResponse> {
    const request = buildEchoRequest(preset, resolvePresetStreaming(preset, arg, supportsStreaming), arg.formated)

    arg.revenantAdapterKind = 'echo'
    const responseDecoder = openAiChatResponseDecoder(preset, request.stream)
    const init: LLMRequestInit = {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
        signal: abortSignal ?? undefined,
        responseDecoder,
    }
    try {
        const response = await makeModelTransportFetch(arg, preset)('https://echo.invalid/v1/chat/completions', init)
        if (!response.ok) {
            const body = await response.json() as { error?: { message?: unknown } }
            return {
                type: 'fail',
                result: String(body.error?.message ?? `Echo request failed (${response.status})`),
                model: preset.name,
            }
        }
        if (request.stream) {
            if (!response.body) throw new Error('Echo stream response has no body')
            const body = response.body
            const stream = applyOutputRepetitionDetection(new ReadableStream<StreamResponseChunk>({
                start(controller) {
                    return pumpPresetStream(decodeChatCompletionStream(body, responseDecoder), controller, {
                        intervalMs: STREAM_FLUSH_INTERVAL_MS,
                        formatReasoning: text => formatAdapterReasoning([{ text }]),
                    })
                },
            }), arg.onOutputRepetitionDetected)
            return preset.decoupledStreaming
                ? { type: 'success', result: await collectStreamingText(stream), model: preset.name }
                : { type: 'streaming', result: stream, model: preset.name }
        }
        return {
            type: 'success',
            result: decodeChatCompletionResponse(await response.text(), responseDecoder).text,
            model: preset.name,
        }
    }
    catch (error) {
        return {
            type: 'fail',
            result: abortSignal?.aborted
                ? 'Aborted'
                : error instanceof Error ? error.message : String(error),
            model: preset.name,
        }
    }
}

async function requestPluginPreset(
    arg: RequestDataArgumentExtended,
    compiled: CompiledPluginModelPreset,
    abortSignal: AbortSignal | null,
    mode: ModelModeExtended,
): Promise<requestDataResponse> {
    const preset = compiled.preset
    if (arg.blockPlugins) {
        return {
            type: 'fail',
            result: 'Plugin calls are blocked by the caller.',
            model: preset.name,
        }
    }

    const modelId = preset.profileSnapshot.modelId
    const providerName = pluginProviderName(modelId)
    if (!providerName || !customV3ProviderMetaStore.some(model => model.id === modelId)) {
        return {
            type: 'fail',
            result: language.pluginModelUnavailable,
            model: preset.name,
        }
    }

    try {
        arg.formated = formatPresetMessages(structuredClone(arg.formated), compiled.behavior, getDatabase())
    } catch (err) {
        return {
            type: 'fail',
            result: err instanceof Error ? err.message : String(err),
            model: preset.name,
        }
    }

    const values = pluginArgumentValues(preset.profileSnapshot, preset.userValues ?? {})
    arg.abortSignal = abortSignal ?? new AbortController().signal
    arg.mode = mode
    arg.biasString ??= []
    arg.maxTokens ??= compiled.generation.maxOutputTokens
        ?? getDatabase().modelPresetDefaultMaxResponse
        ?? getDatabase().maxResponse
    const exposeStreaming = resolvePresetStreaming(
        preset,
        arg,
        compiled.features.streaming,
    )

    const genId = ensureRequestGenerationId(arg)
    const reportStatus = !arg.previewBody && statusEnabled()
    const terminalOutcome = bindRevenantTerminalOutcome(arg)
    if (reportStatus) {
        safeStatus(() => startStatus(genId, {
            kind: toRequestKind(mode),
            label: preset.name,
            chatId: getRequestStatusNavigationId(arg),
            phase: 'connecting',
            now: Date.now(),
            abortSignal: abortSignal ?? undefined,
            onActivate: arg.onRequestStatusActivate,
        }))
    }

    const result = await requestPluginPresetProvider(arg, modelId, providerName, values)
    if (result.type === 'streaming') {
        const source = result.result
        let responseStream = source
        if (reportStatus) {
            let sourceReader: ReadableStreamDefaultReader<StreamResponseChunk> | undefined
            let previousText = ''
            let ended = false
            const finish = (outcome: 'done' | 'failed' | 'aborted', error?: unknown) => {
                if (ended) return
                ended = true
                const finalOutcome = terminalOutcome.resolve(outcome)
                safeStatus(() => endStatus(genId, finalOutcome, {
                    now: Date.now(),
                    error: finalOutcome === 'failed'
                        ? (error instanceof Error ? error.message : String(error))
                        : undefined,
                }))
            }
            responseStream = new ReadableStream<StreamResponseChunk>({
                start() {
                    sourceReader = source.getReader()
                },
                async pull(controller) {
                    try {
                        const { done, value } = await sourceReader!.read()
                        if (done) {
                            finish('done')
                            sourceReader!.releaseLock()
                            sourceReader = undefined
                            controller.close()
                            return
                        }
                        const fullText = value?.["0"] ?? ''
                        const delta = fullText.startsWith(previousText)
                            ? fullText.slice(previousText.length)
                            : fullText
                        previousText = fullText
                        if (delta) {
                            safeStatus(() => appendText(genId, { response: delta }, Date.now()))
                        }
                        controller.enqueue(value)
                    } catch (error) {
                        finish(abortSignal?.aborted ? 'aborted' : 'failed', error)
                        controller.error(error)
                        sourceReader?.releaseLock()
                        sourceReader = undefined
                    }
                },
                async cancel(reason) {
                    finish('aborted')
                    const reader = sourceReader
                    if (!reader) return
                    try {
                        await reader.cancel(reason)
                    } finally {
                        reader.releaseLock()
                        sourceReader = undefined
                    }
                },
            })
        }
        if (!exposeStreaming || preset.decoupledStreaming) {
            const text = await collectStreamingText(applyOutputRepetitionDetection(
                responseStream,
                arg.onOutputRepetitionDetected,
            ))
            return { type: 'success', result: text, model: preset.name }
        }
        return { ...result, result: responseStream, model: preset.name }
    }

    if (reportStatus && result.type === 'success') {
        const responseText = result.result
        if (responseText) {
            safeStatus(() => appendText(genId, { response: responseText }, Date.now()))
        }
        safeStatus(() => endStatus(genId, terminalOutcome.resolve('done'), { now: Date.now() }))
    } else if (reportStatus) {
        const outcome = terminalOutcome.resolve(abortSignal?.aborted ? 'aborted' : 'failed')
        safeStatus(() => endStatus(genId, outcome, {
            now: Date.now(),
            error: outcome === 'failed' ? String(result.result) : undefined,
        }))
    }
    return { ...result, model: preset.name }
}

async function requestPluginPresetProvider(
    arg: RequestDataArgumentExtended,
    modelId: string,
    providerName: string,
    parameterValues: Record<string, unknown>,
): Promise<requestDataResponse> {
    if (arg.previewBody) {
        return {
            type: 'success',
            result: JSON.stringify({ error: 'Plugin is not supported in preview mode' }),
        }
    }

    const provider = pluginRuntime.providers.get(providerName)
    if (!provider) {
        return {
            type: 'fail',
            result: language.pluginModelUnavailable,
            model: modelId,
        }
    }

    const providerArgs: Record<string, unknown> = {
        prompt_chat: arg.formated,
        mode: arg.mode,
        bias: [],
        ...parameterValues,
    }
    // The compiled request budget wins over a duplicated preset field.
    providerArgs.max_tokens = arg.maxTokens

    arg.abortSignal ??= new AbortController().signal
    Object.defineProperty(providerArgs, pluginProviderRequestContextKey, {
        value: {
            chatId: arg.chatId,
            generationRequest: buildGenerationRequest(arg),
            llmExecutionPolicy: resolveLLMExecutionPolicy(arg),
            interceptor: 'model_preset',
        },
        enumerable: false,
    })

    try {
        const response = await provider(providerArgs as any, arg.abortSignal)
        if (!response) {
            return {
                type: 'fail',
                result: language.errors.unknownModel,
                model: modelId,
            }
        }
        if (!response.success) {
            return {
                type: 'fail',
                result: response.content instanceof ReadableStream
                    ? await new Response(response.content).text()
                    : response.content,
                model: modelId,
            }
        }
        if (response.content instanceof ReadableStream) {
            let fullText = ''
            const accumulator = new TransformStream<string, StreamResponseChunk>({
                transform(chunk, controller) {
                    fullText += chunk
                    controller.enqueue({ '0': fullText })
                },
            })
            return {
                type: 'streaming',
                result: response.content.pipeThrough(accumulator),
                model: modelId,
            }
        }
        return {
            type: 'success',
            result: response.content ?? '',
            model: modelId,
        }
    } catch (error) {
        console.error(error)
        return {
            type: 'fail',
            result: `Plugin Error from ${modelId}: ${error instanceof Error ? error.message : JSON.stringify(error)}`,
            model: modelId,
        }
    }
}

// Provider adapters receive a normal Fetch implementation backed by the shared
// LLM transport. Execution intent stays explicit while route, recovery,
// cancellation, timeout, and local-network behavior stay out of adapters.

function resolveLLMExecutionPolicy(arg: RequestDataArgumentExtended): LLMExecutionPolicy {
    if (arg.llmExecutionPolicy) return arg.llmExecutionPolicy
    if (arg.previewBody) return EPHEMERAL_SERVER_LLM_EXECUTION
    return buildGenerationRequest(arg)?.workflow
        ? WORKFLOW_LLM_EXECUTION
        : SINGLE_LLM_EXECUTION
}

function makeModelTransportFetch(arg: RequestDataArgumentExtended, preset: ModelPreset): typeof fetch {
    const usageIdentity = modelsDevUsageIdentity(preset)
    return createLLMTransportFetch({
        interceptor: 'model_preset',
        chatId: arg.chatId,
        getGenerationRequest: () => buildGenerationRequest(arg, usageIdentity),
        getExecutionPolicy: () => resolveLLMExecutionPolicy(arg),
    })
}

// Pull out adapter-error detail for logging without leaking the credential.
function describeModelPresetError(err: unknown): Record<string, unknown> {
    if (err && typeof err === 'object') {
        const e = err as Record<string, unknown>
        return {
            name: (e.name as string) ?? undefined,
            kind: e.kind,
            status: e.status,
            retryAfterMs: e.retryAfterMs,
            retryable: e.retryable,
            fallbackEligible: e.fallbackEligible,
            message: e.message ?? String(err),
            cause: e.cause instanceof Error ? e.cause.message : e.cause,
        }
    }
    return { message: String(err) }
}

export function modelPresetRequestFailurePolicy(error: unknown): {
    noRetry?: boolean
    failByServerError?: boolean
    retryAfterMs?: number
} {
    if (!(error instanceof ModelPresetAdapterError)) return {}
    const failByServerError = error.kind === 'rate-limit'
        || error.status === 503
        || error.status === 529
        || isTransientOverloadMessage(error.message)
    return {
        noRetry: !error.retryable,
        failByServerError: error.retryable && failByServerError,
        ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
    }
}

// Publish optional ModelPreset request status; reporting failures must not
// affect generation. Streaming token counts are estimates until provider usage
// is available.

function statusEnabled(): boolean {
    try {
        return getDatabase()?.showRequestStatus !== false
    } catch {
        return false
    }
}

// Use a fixed local tokenizer for language-aware live estimates; reconcile with
// provider usage when available.
setStatusTokenCounter(async (text) => {
    const encoded = await encodeWithTokenizer(text, 'tik')
    return encoded.length
})

function safeStatus(fn: () => void): void {
    try { fn() } catch (e) { console.error('[ModelPreset] status publish failed', e) }
}

// Map auxiliary ModelPreset calls to the shared 'sub' status kind.
function toRequestKind(mode: ModelModeExtended): RequestKind {
    switch (mode) {
        case 'translate': return 'translate'
        case 'memory': return 'memory'
        case 'emotion': return 'emotion'
        case 'submodel':
        case 'otherAx': return 'sub'
        default: return 'main'
    }
}

// Per-preset streaming preference. Adapter/profile support is compiled once and
// passed in; forceStreaming deliberately overrides the profile declaration for
// internal callers, while the concrete adapter must still implement streaming.
export function resolvePresetStreaming(
    preset: ModelPreset,
    arg: RequestDataArgumentExtended,
    profileSupportsStreaming: boolean,
): boolean {
    if (arg.forceStreaming) return true
    if (!profileSupportsStreaming) return false
    const isMainChatGeneration = arg.mode === 'model' && !!arg.chatId
    if (!isMainChatGeneration && arg.useStreaming !== true) return false
    return !!preset.useStreaming && (arg.useStreaming ?? true)
}

// Tool-execution rounds allowed per request before we stop and surface a
// marker. Deliberately separate from the network retry budget (db.requestRetrys,
// applied by the outer requestChatData loop): conflating them would let a failed
// follow-up re-run already-executed (possibly write-side) tools.
const MODEL_PRESET_MAX_TOOL_STEPS = 8

// How often (ms) a streaming response flushes accumulated text to the chat
// renderer. Adapters yield one delta per token; each emitted chunk forces a full
// re-parse of the whole message (markdown + sanitize) downstream, so emitting
// every token makes the re-parse count scale with token count and stalls slow
// (mobile) devices. Coalescing to ~20fps keeps streaming visibly live while
// bounding re-parse cost. The final chunk is always flushed regardless.
const STREAM_FLUSH_INTERVAL_MS = 50

function toAdapterToolDef(tool: MCPTool): AdapterToolDef {
    return {
        name: tool.name,
        description: tool.description,
        // simplifySchema mutates its input.
        parameters: simplifySchema(structuredClone(tool.inputSchema)),
    }
}

async function formatPresetMedia(media?: AdapterGeneratedMedia[]): Promise<string> {
    if (!media || media.length === 0) return ''
    const markers: string[] = []
    for (const item of media) {
        const id = createEntityId()
        const ext = item.mime.split('/')[1]?.split(';')[0] || (item.kind === 'image' ? 'png' : 'mp3')
        await setInlayAsset(id, {
            name: `generated-${item.kind}.${ext}`,
            type: item.kind,
            data: new Blob([asBuffer(Buffer.from(item.base64, 'base64'))], { type: item.mime }),
            ext,
        })
        markers.push(`{{inlayeddata::${id}}}`)
    }
    return markers.join('\n')
}

async function requestModelPreset(arg:RequestDataArgumentExtended, preset:ModelPreset, abortSignal:AbortSignal=null, mode:ModelModeExtended='model'):Promise<requestDataResponse> {
    const database = getDatabase()
    const requestedJsonSchema = resolveRequestedJSONSchema(
        arg.schema,
        database.jsonSchemaEnabled,
        database.jsonSchema,
    )
    let compiled: CompiledModelPreset
    try {
        compiled = compileModelPreset(preset, {
            jsonSchemaRequested: requestedJsonSchema !== undefined,
        })
    } catch (error) {
        return {
            type: 'fail',
            result: error instanceof Error ? error.message : String(error),
            model: preset.name,
        }
    }
    // From here on every policy decision consumes the same compiled view. In
    // particular, Developer/Custom no longer gets reinterpreted independently
    // by capability gates, UI policy, and adapter dispatch.
    preset = compiled.preset
    if (compiled.backend === 'plugin') {
        return requestPluginPreset(arg, compiled, abortSignal, mode)
    }
    if (compiled.backend === 'echo') {
        if (arg.previewBody) {
            return {
                type: 'success',
                result: JSON.stringify({
                    adapterKind: 'echo',
                    ...buildEchoRequest(preset, resolvePresetStreaming(preset, arg, compiled.features.streaming), arg.formated),
                }),
                model: preset.name,
            }
        }
        return requestEchoPreset(arg, preset, abortSignal, compiled.features.streaming)
    }
    // HTTP streaming adapters expose their ReadableStream before the lazy
    // async generator reaches fetchNative. Track the durable-registration
    // boundary independently so the chat workflow can wait for a late job id,
    // while preparation failures still release that wait with the real error.
    let registrationSettled = false
    let statusJobId:string|undefined
    const callerOnJobCreated = arg.onRevenantJobCreated
    const callerOnRegistrationUnavailable = arg.onRevenantJobRegistrationUnavailable
    arg.onRevenantJobCreated = (jobId, createdAt) => {
        registrationSettled = true
        statusJobId = jobId
        callerOnJobCreated?.(jobId, createdAt)
    }
    arg.onRevenantJobRegistrationUnavailable = error => {
        if (registrationSettled) return
        registrationSettled = true
        callerOnRegistrationUnavailable?.(error)
    }
    const releasePendingRegistration = (error: unknown) => {
        if (registrationSettled) return
        arg.onRevenantJobRegistrationUnavailable?.(error)
    }
    const kind = compiled.adapterKind
    const adapter = compiled.adapter
    arg.revenantAdapterKind = kind

    const credential = buildModelPresetCredential(preset)
    const usageIdentity = modelsDevUsageIdentity(preset)
    const fetchImpl = makeModelTransportFetch(arg, preset)
    // Main and auxiliary requests share the same identity with the durable
    // provider job, so reconnect/recovery adopts the existing status instead
    // of publishing a second toast under the server job id.
    const genId = ensureRequestGenerationId(arg)
    const statusKind = toRequestKind(mode)
    const reportStatus = statusEnabled() && !!genId
    const terminalOutcome = bindRevenantTerminalOutcome(arg)

    const tools = (compiled.features.tools && arg.tools && arg.tools.length > 0)
        ? arg.tools.map(toAdapterToolDef)
        : undefined

    const supportsVision = compiled.features.vision
    const supportsAudioInput = compiled.features.audioInput
    const supportsVideoInput = compiled.features.videoInput
    const producesMedia = compiled.features.mediaOutput

    // Cache main chat prompts; tool rounds and previews require the full prompt.
    const cacheAuthKind = preset.profileSnapshot.auth.kind
    let cache: AdapterCacheContext | undefined
    if (compiled.features.cache && mode === 'model'
        && !tools && !arg.previewBody
        && (cacheAuthKind === 'x-goog-api-key' || cacheAuthKind === 'google-service-account')) {
        const cacheChatKey = (arg.currentChat ?? getCurrentChat())?.id
        if (cacheChatKey) {
            cache = {
                promptCaching: preset.promptCaching,
                chatKey: cacheChatKey,
                task: mode,
                presetId: preset.id,
                generationId: genId,
            }
        }
    }

    let contexts: ProviderContextRecord[] = []
    if (isNodeServer && supportsThoughtSignatures(kind)) {
        try {
            const responseIds = arg.formated.flatMap(message => {
                const responseId = getPromptResponseId(message)
                return message.role === 'assistant' && responseId ? [responseId] : []
            })
            contexts = await queryRevenantProviderContexts(responseIds, kind, resolveWireModelId(preset))
        } catch (error) {
            console.error('[ModelPreset] Failed to restore thought signatures', error)
        }
    }

    // Clone before folding so retries cannot merge text into the original history.
    try {
        arg.formated = formatPresetMessages(
            structuredClone(arg.formated), compiled.behavior, getDatabase(),
            new Set(contexts.map(context => context.responseId)),
        )
    } catch (err) {
        return { type: 'fail', result: err instanceof Error ? err.message : String(err), model: preset.name }
    }

    const includeDeepSeekThinkingInput = compiled.behavior.deepSeekThinkingInput
    let messages = tools
        ? await expandAdapterMessages(
            arg.formated,
            decodeToolCall,
            supportsVision,
            includeDeepSeekThinkingInput,
            supportsAudioInput,
            supportsVideoInput,
        )
        : arg.formated.map((m, index) => toAdapterMessage(
            m,
            supportsVision,
            includeDeepSeekThinkingInput && index === arg.formated.length - 1,
            supportsAudioInput,
            supportsVideoInput,
        ))
    messages = restoreThoughtSignatures(messages, contexts)
    // OpenAI-compatible endpoints that opt into the historical DeveloperRole
    // flag receive developer-role instructions instead of system-role ones.
    // Other wire formats do not accept this role, so the flag is inert there.
    if (compiled.behavior.developerRole) {
        for (const message of messages) {
            if (message.role === 'system') message.role = 'developer'
        }
    }
    let structuredOutput: AdapterChatOptions['structuredOutput']
    if (compiled.features.jsonSchema) {
        try {
            structuredOutput = {
                schema: getGeneralJSONSchema(requestedJsonSchema),
                strict: database.strictJsonSchema,
            }
        } catch (err) {
            return {
                type: 'fail',
                result: err instanceof Error ? err.message : String(err),
                model: preset.name,
            }
        }
    }

    // Preview skips chat requests and tools. Service-account credential resolution
    // may still refresh an expired OAuth token before reaching this point.
    if (arg.previewBody) {
        try {
            const prepared = await adapter.preview(
                preset,
                { messages, tools, structuredOutput, fetchImpl },
                credential,
            )
            return {
                type: 'success',
                result: JSON.stringify({ url: prepared.url, body: prepared.body, headers: prepared.headers }),
                model: preset.name,
            }
        } catch (err) {
            return { type: 'fail', result: err instanceof Error ? err.message : String(err), model: preset.name }
        }
    }

    try {
        // Tool calls need complete structured responses for each round, so this
        // path does not stream or publish status.
        if (tools) {
            const { result, toolsExecuted } = await runModelPresetToolLoop(
                arg,
                preset,
                adapter,
                credential,
                fetchImpl,
                messages,
                tools,
                abortSignal,
                structuredOutput,
                arg.promptCacheKey,
            )
            return { type: 'success', result, model: preset.name, toolExecuted: toolsExecuted }
        }

        // Anthropic's Message Batches API is asynchronous and has no streaming
        // transport. Keep the preset's streaming preference intact, but force
        // this request through the non-streaming adapter path while batching is on.
        const useStreaming = producesMedia ? false : adapter.support.streaming
            && resolvePresetStreaming(preset, arg, compiled.features.streaming)
            && !(kind === 'anthropic-messages'
                && preset.profileSnapshot.providerBaseId === 'anthropic'
                && preset.claudeBatching)
        const options: AdapterChatOptions = {
            messages,
            promptCacheKey: arg.promptCacheKey,
            abortSignal: abortSignal ?? undefined,
            fetchImpl,
            generationId: genId,
            cache,
            structuredOutput,
        }
        if (reportStatus) {
            const startRequestStatus = (startedAt: number) => safeStatus(() => startStatus(genId, {
                kind: statusKind,
                label: preset.name,
                chatId: getRequestStatusNavigationId(arg),
                phase: 'connecting',
                now: startedAt,
                abortSignal: abortSignal ?? undefined,
                onActivate: arg.onRequestStatusActivate,
            }))
            const startObservedRequestStatus = (startedAt: number) => {
                if (statusJobId && hasRequestStatus(genId)) {
                    setRequestStatusAction(genId, arg.onRequestStatusActivate)
                    safeStatus(() => markPhase(genId, 'connecting', startedAt))
                    return
                }
                startRequestStatus(startedAt)
            }
            if (arg.revenantDispatchPolicy || arg.revenantWorkflowDependency) {
                arg.onRevenantProviderStarted = combineProviderStartedHandlers(
                    arg.onRevenantProviderStarted,
                    startObservedRequestStatus,
                )
            }
            else {
                startObservedRequestStatus(Date.now())
            }
        }
        if(useStreaming){
            let presetStreamResponseStarted = false
            const createPresetStream = (finalizeFailure: boolean) => new ReadableStream<StreamResponseChunk>({
                start(controller) {
                    return pumpPresetStream(adapter.stream(preset, options, credential), controller, {
                        intervalMs: STREAM_FLUSH_INTERVAL_MS,
                        formatReasoning: (text) => formatAdapterReasoning([{ text }]),
                        // A user cancellation terminates the stream with an
                        // AbortError. It is reflected as an aborted request
                        // status, not persisted as an application error.
                        onError: (err) => {
                            releasePendingRegistration(err)
                            if (abortSignal?.aborted) return
                            console.error('[ModelPreset] stream error', describeModelPresetError(err))
                        },
                        // appendText owns the phase transition (thinking/responding)
                        // from which kind of text arrives, and recovers from 'stalled'
                        // when chunks resume — no local phase tracking needed here.
                        onDelta: (delta) => {
                            if (delta.textDelta || delta.reasoningDelta) {
                                presetStreamResponseStarted = true
                            }
                            if (!reportStatus) return
                            safeStatus(() => {
                                const now = Date.now()
                                if (delta.reasoningDelta && !(statusJobId
                                    && appendRevenantJobRequestText(
                                        statusJobId,
                                        { thinking: delta.reasoningDelta },
                                        now,
                                    ))) {
                                    appendText(genId, { thinking: delta.reasoningDelta }, now)
                                }
                                if (delta.textDelta && !(statusJobId
                                    && appendRevenantJobRequestText(
                                        statusJobId,
                                        { response: delta.textDelta },
                                        now,
                                    ))) {
                                    appendText(genId, { response: delta.textDelta }, now)
                                }
                            })
                        },
                        onFinish: (outcome, lastUsage) => {
                            if (outcome === 'done') {
                                releasePendingRegistration(new Error(
                                    'The model stream completed before durable job registration.',
                                ))
                            }
                            if (!reportStatus || (outcome === 'failed' && !finalizeFailure)) return
                            safeStatus(() => {
                                // A stream that ends via abort throws inside the
                                // generator → 'failed'; reclassify as 'aborted' so the
                                // toast shows "Cancelled" rather than an error.
                                const localOutcome = outcome === 'failed' && abortSignal?.aborted ? 'aborted' : outcome
                                const finalOutcome = terminalOutcome.resolve(localOutcome)
                                // Confirmed cache hit (usageMetadata.cachedContentTokenCount
                                // > 0) → savings badge on the status toast. Gated on the
                                // cache context so behavior is unchanged with caching off.
                                const cachedTokens = lastUsage?.cachedTokens ?? 0
                                if (cache && cachedTokens > 0) {
                                    addBadge(genId, { key: 'cache', text: language.requestStatus.cacheHit.replace('{n}', cachedTokens.toLocaleString()), tone: 'success' })
                                }
                                endStatus(genId, finalOutcome, {
                                    now: Date.now(),
                                    usage: lastUsage?.completionTokens !== undefined
                                        ? { responseTokens: lastUsage.completionTokens }
                                        : undefined,
                                })
                            })
                        },
                    })
                }
            })
            // Decoupled streaming: the wire request still streams (keeping the
            // provider's lenient streaming limits), but we drain the stream here
            // and return a single text result. The final chunk already holds the
            // full reasoning-prefixed text, so this matches the non-streaming
            // adapter.send return byte-for-byte — the chat renderer paints it
            // once instead of token-by-token.
            if(preset.decoupledStreaming){
                const stream = applyOutputRepetitionDetection(
                    createPresetStream(true),
                    arg.onOutputRepetitionDetected,
                )
                try {
                    const text = await collectStreamingText(stream)
                    return { type: 'success', result: text, model: preset.name }
                } catch (error) {
                    if (!presetStreamResponseStarted) throw error
                    return {
                        type: 'fail',
                        result: error instanceof Error ? error.message : String(error),
                        model: preset.name,
                        ...modelPresetRequestFailurePolicy(error),
                        noRetry: true,
                    }
                }
            }
            let streamTrys = 0
            const stream = createRetryingSnapshotStream({
                createAttempt: () => createPresetStream(false),
                startsResponse: chunk => Object.values(chunk).some(value => value.length > 0),
                retryDelayMs: (error) => {
                    if (abortSignal?.aborted) return null
                    const policy = modelPresetRequestFailurePolicy(error)
                    // Match the non-streaming retry policy exactly, with one
                    // extra safety boundary supplied by the stream wrapper:
                    // response content must not have started yet.
                    if (policy.noRetry) return null
                    const db = getDatabase()
                    streamTrys += 1
                    return requestRetryDelayMs(policy, streamTrys, db.requestRetrys)
                },
                onRetry: () => {
                    if (reportStatus) safeStatus(() => markPhase(genId, 'retrying', Date.now()))
                },
                onFinalError: (error) => {
                    if (!reportStatus) return
                    const outcome = abortSignal?.aborted ? 'aborted' : 'failed'
                    safeStatus(() => endStatus(genId, terminalOutcome.resolve(outcome), {
                        now: Date.now(),
                        error: outcome === 'failed'
                            ? (error instanceof Error ? error.message : String(error))
                            : undefined,
                    }))
                },
            })
            // endStatus fires from the pump's onFinish once the consumer drains
            // the stream — NOT here, because the stream outlives this return.
            return { type: 'streaming', result: stream, model: preset.name }
        }
        const response = await adapter.send(preset, options, credential)
        if (response.deferredUsageJobId && response.usage) {
            try {
                const raw = response.raw as { usage?: unknown } | undefined
                await reportRevenantGenerationUsage({
                    jobId: response.deferredUsageJobId,
                    timestamp: Date.now(),
                    chatId: arg.chatId,
                    provider: usageIdentity?.usageProviderId,
                    model: usageIdentity?.usageModelId,
                    serviceTier: 'batch',
                    usage: raw?.usage ?? response.usage,
                })
            } catch (usageError) {
                // Usage accounting must never turn a successful generation into
                // a failed chat response.
                console.error('[ModelPreset] failed to report deferred batch usage', usageError)
            }
        }
        if (reportStatus) {
            safeStatus(() => {
                // Cache-hit badge: same rule as the streaming onFinish above.
                const cachedTokens = response.usage?.cachedTokens ?? 0
                if (cache && cachedTokens > 0) {
                    addBadge(genId, { key: 'cache', text: language.requestStatus.cacheHit.replace('{n}', cachedTokens.toLocaleString()), tone: 'success' })
                }
                endStatus(genId, terminalOutcome.resolve('done'), {
                    now: Date.now(),
                    usage: response.usage?.completionTokens !== undefined
                        ? { responseTokens: response.usage.completionTokens }
                        : undefined,
                })
            })
        }
        const media = await formatPresetMedia(response.media)
        const separator = response.text && media ? '\n' : ''
        return {
            type: 'success',
            result: formatAdapterReasoning(response.reasoning) + response.text + separator + media,
            model: preset.name,
        }
    } catch (err) {
        console.error('[ModelPreset] request failed', describeModelPresetError(err))
        if (reportStatus) {
            // Distinguish a user cancel from a real failure for the status toast.
            const outcome = terminalOutcome.resolve(abortSignal?.aborted ? 'aborted' : 'failed')
            safeStatus(() => endStatus(genId, outcome, { now: Date.now(), error: outcome === 'failed' ? (err instanceof Error ? err.message : String(err)) : undefined }))
        }
        return {
            type: 'fail',
            result: err instanceof Error ? err.message : String(err),
            model: preset.name,
            ...modelPresetRequestFailurePolicy(err),
        }
    }
}

// One-shot test request for the preset editor's "Test" tab. Sends a single
// user-supplied message through requestModelPreset so the credential resolution,
// adapter dispatch and error handling are byte-identical to a real chat request —
// only the prompt is caller-supplied and streaming/tools are forced off so the
// result is a single text reply. Not part of the chat flow; nothing is persisted.
export interface ModelPresetTestResult {
    ok: boolean
    message: string   // reply text on success, error message on failure
    latencyMs: number
}

export async function testModelPreset(preset: ModelPreset, message: string, abortSignal: AbortSignal = null): Promise<ModelPresetTestResult> {
    const arg: requestDataArgument = {
        formated: [{ role: 'user', content: message }],
        bias: {},
        useStreaming: false,
    }
    const start = performance.now()
    const res = await executeModelPresetRequest(arg, preset, abortSignal, 'otherAx')
    const latencyMs = Math.round(performance.now() - start)
    // useStreaming:false + no tools guarantees a success/fail (never streaming/multiline),
    // but fall through defensively rather than asserting the union.
    if (res.type === 'success') {
        return { ok: true, message: res.result, latencyMs }
    }
    if (res.type === 'fail') {
        return { ok: false, message: res.result, latencyMs }
    }
    return { ok: false, message: 'Unexpected response type', latencyMs }
}

// Bind provider sends and tool execution to the generic runToolLoop.
// The visible result interleaves model text with `<tool_call>` markers (encoded when
// rememberToolUsage is on) so the turn round-trips on the next request.
async function runModelPresetToolLoop(
    arg: RequestDataArgumentExtended,
    preset: ModelPreset,
    adapter: ModelPresetAdapterDefinition,
    credential: AdapterCredential | undefined,
    fetchImpl: typeof fetch,
    messages: AdapterChatMessage[],
    tools: AdapterToolDef[],
    abortSignal: AbortSignal | null,
    structuredOutput?: AdapterChatOptions['structuredOutput'],
    promptCacheKey?: string,
): Promise<{ result: string; toolsExecuted: boolean }> {
    // Tracks whether any tool actually ran, so the caller can block outer
    // success-path retries that would otherwise re-execute side-effecting tools.
    let toolsExecuted = false
    const result = await runToolLoop(messages, {
        maxSteps: MODEL_PRESET_MAX_TOOL_STEPS,
        formatReasoning: formatAdapterReasoning,
        abortSignal: abortSignal ?? undefined,
        send: (convo) => adapter.send(
            preset,
            { messages: convo, tools, structuredOutput, promptCacheKey, abortSignal: abortSignal ?? undefined, fetchImpl },
            credential,
        ),
        executeTool: async (call) => {
            toolsExecuted = true
            const executed = await executeModelPresetTool(arg, call)
            // Persistence is best-effort: the tool already ran, so a failed
            // encode must not throw (the loop would otherwise drop later results,
            // and a propagated error could trigger an outer re-run). Skip the
            // round-trip marker on failure instead.
            let encoded: string | undefined
            if (arg.rememberToolUsage && executed.response.length > 0) {
                try {
                    encoded = await encodeToolCall({
                        call: { id: call.id, name: call.name, arg: call.arguments },
                        response: executed.response,
                    })
                } catch (e) {
                    console.error('[ModelPreset] tool-call persistence failed', e)
                }
            }
            return { text: executed.text, encoded }
        },
    })
    return { result, toolsExecuted }
}

async function executeModelPresetTool(
    arg: RequestDataArgumentExtended,
    call: AdapterToolCall,
): Promise<{ text: string, response: RPCToolCallContent[] }> {
    const tool = (arg.tools ?? []).find(t => t.name === call.name)
    if (!tool) {
        return { text: 'No tool found with name: ' + call.name, response: [] }
    }
    let parsedArgs: unknown
    try {
        parsedArgs = call.arguments ? JSON.parse(call.arguments) : {}
    } catch (e) {
        return { text: 'Tool call has invalid JSON arguments: ' + (e instanceof Error ? e.message : String(e)), response: [] }
    }
    try {
        const response = await callTool(call.name, parsedArgs)
        const text = toolResponseText(response)
        return { text: text.length > 0 ? text : 'Tool call returned no text response', response }
    } catch (e) {
        return { text: 'Tool call failed: ' + (e instanceof Error ? e.message : String(e)), response: [] }
    }
}
