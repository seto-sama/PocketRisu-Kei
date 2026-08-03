import { language } from "../../../lang";
import { isV3PluginModel, LLMFlags, type LLMModel } from "../../model/modellist";
import { risuEscape, risuUnescape } from "../../parser/parser.svelte";
import { pluginProviderRequestContextKey, pluginV2 } from "../../plugins/plugins.svelte";
import { getCurrentCharacter, getCurrentChat, getDatabase, type character } from "../../storage/database.svelte";
import { encodeWithTokenizer } from "../../tokenizer";
import { v4 as uuidv4 } from "uuid";
import { simplifySchema, sleep } from "../../util";
import type { OpenAIChat } from "../index.svelte";
import { setInlayAsset } from "../files/inlays";
import { getTools, callTool, encodeToolCall, decodeToolCall } from "../mcp/mcp";
import type { MCPTool, RPCToolCallContent } from "../mcp/mcplib";
import { getGeneralJSONSchema } from "../templates/jsonSchema";
import { runTrigger } from "../triggers";
import { buildGenerationRequest, collectStreamingText, type ModelModeExtended } from './shared';
import {
    ModelPresetAdapterError,
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
import { pumpPresetStream } from "./presetStreamPump";
import { resolveChatModelBinding, buildModelPresetCredential, applyPromptPresetParams } from "./modelPresetBinding";
import { expandAdapterMessages, toAdapterMessage, toolResponseText } from "./modelPresetMessages";
import { pluginArgumentValues, pluginProviderName } from "src/ts/preset/pluginModels";
import { createLLMTransportFetch } from "src/ts/network/llmTransport";
import {
    EPHEMERAL_SERVER_LLM_EXECUTION,
    SINGLE_LLM_EXECUTION,
    WORKFLOW_LLM_EXECUTION,
    type LLMExecutionPolicy,
} from "src/ts/network/transportTypes";
import {
    startStatus, appendText, endStatus, setStatusTokenCounter, addBadge,
    type RequestKind,
} from "src/ts/status/requestStatus";
import type { RevenantOperationContext, RevenantProviderJobSpec } from "../revenant/types";
import { reportRevenantGenerationUsage } from "../revenant/client";
import { combineProviderStartedHandlers } from "../revenant/coordinator";
import {
    consumeOnStreamCompletion,
    consumeRevenantAuxiliaryResults,
} from "../revenant/resultConsumption";
import { MODELS_DEV_REGISTRY_ID } from "src/ts/preset/registry/modelsDev";

export type ToolCall = {
    name: string;
    arguments: string;
}

export interface requestDataArgument{
    formated: OpenAIChat[]
    bias: {[key:number]:number}
    biasString?: [string,number][]
    currentChar?: character
    temperature?: number
    maxTokens?:number
    PresensePenalty?: number
    frequencyPenalty?: number,
    useStreaming?:boolean
    isGroupChat?:boolean
    useEmotion?:boolean
    continue?:boolean
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
    revenantStreaming?: boolean
    blockPlugins?: boolean
    /** Persisted data needed to apply an auxiliary result after a reload. */
    revenantOperationContext?:RevenantOperationContext
    revenantDispatchPolicy?:import('../revenant/types').RevenantDispatchPolicy
    revenantWorkflowDependency?:import('../revenant/types').RevenantWorkflowDependency
    onRevenantJobCreated?:(jobId:string) => void
    onRevenantJobRegistrationUnavailable?:(error?:unknown) => void
    onRevenantProviderStarted?:(startedAt:number) => void
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

export async function requestChatData(arg:requestDataArgument, model:ModelModeExtended, abortSignal:AbortSignal=null):Promise<requestDataResponse> {
    const db = getDatabase()
    const tools = arg.tools ?? (await getTools())

    if(arg.escape){
        arg.useStreaming = false
        console.warn('Escape is enabled, disabling streaming')
    }

    arg.formated = safeStructuredClone(arg.formated).map(m => {
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

        if(pluginV2.replacerbeforeRequest.size > 0){
            for(const replacer of pluginV2.replacerbeforeRequest){
                arg.formated = await replacer(arg.formated, model)
            }
        }

        try{
            const currentChar = getCurrentCharacter()
            if(currentChar){
                const perf = performance.now()
                const d = await runTrigger(currentChar, 'request', {
                    chat: getCurrentChat(),
                    displayMode: true,
                    displayData: JSON.stringify(arg.formated)
                })

                const got = JSON.parse(d.displayData)
                if(!got || !Array.isArray(got)){
                    throw new Error('Invalid return')
                }
                arg.formated = got
                console.log('Trigger time', performance.now() - perf)
            }
        }
        catch(e){
            console.error(e)
        }

        const da = await requestChatDataMain({
            ...arg,
            tools,
        }, model, abortSignal)

        // A ModelPreset response that already executed tools must be returned
        // as-is and NEVER re-run: the side effects (possibly writes) are done.
        // after-replacers still run (transform only), but in a try/catch so a
        // throwing plugin cannot lose the side-effect record either.
        if(da.type === 'success' && da.toolExecuted){
            if(arg.escape) da.result = risuEscape(da.result)
            for(const replacer of pluginV2.replacerafterRequest){
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

        if(da.type === 'success' && pluginV2.replacerafterRequest.size > 0){
            for(const replacer of pluginV2.replacerafterRequest){
                da.result = await replacer(da.result, model)
            }
        }

        if(da.type === 'success' && db.banCharacterset?.length > 0){
            let failed = false
            for(const set of db.banCharacterset){
                console.log(set)
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

        if(da.failByServerError){
            await sleep(1000)
            if(db.antiServerOverloads){
                trys -= 0.5 // reduce trys by 0.5, so that it will retry twice as much
            }
        }

        trys += 1
        if(trys > db.requestRetrys){
            return da
        }
    }
}

export function reformater(formated:OpenAIChat[],modelInfo:LLMModel|LLMFlags[]){

    const flags = Array.isArray(modelInfo) ? modelInfo : modelInfo.flags
    
    const db = getDatabase()
    let systemPrompt:OpenAIChat|null = null

    if(!flags.includes(LLMFlags.hasFullSystemPrompt)){
        if(flags.includes(LLMFlags.hasFirstSystemPrompt)){
            while(formated.length > 0 && formated[0].role === 'system'){
                if(systemPrompt){
                    systemPrompt.content += '\n\n' + formated[0].content
                }
                else{
                    systemPrompt = formated[0]
                }
                formated = formated.slice(1)
            }
        }

        for(let i=0;i<formated.length;i++){
            if(formated[i].role === 'system'){
                formated[i].content = db.systemContentReplacement ? db.systemContentReplacement.replace('{{slot}}', formated[i].content) : `system: ${formated[i].content}`
                formated[i].role = db.systemRoleReplacement
            }
        }
    }
    
    if(flags.includes(LLMFlags.requiresAlternateRole)){
        let newFormated:OpenAIChat[] = []
        for(let i=0;i<formated.length;i++){
            const m = formated[i]
            if(newFormated.length === 0){
                newFormated.push(m)
                continue
            }

            if(newFormated[newFormated.length-1].role === m.role){
            
                newFormated[newFormated.length-1].content += '\n' + m.content

                if(m.multimodals){
                    if(!newFormated[newFormated.length-1].multimodals){
                        newFormated[newFormated.length-1].multimodals = []
                    }
                    newFormated[newFormated.length-1].multimodals.push(...m.multimodals)
                }

                if(m.thoughts){
                    if(!newFormated[newFormated.length-1].thoughts){
                        newFormated[newFormated.length-1].thoughts = []
                    }
                    newFormated[newFormated.length-1].thoughts.push(...m.thoughts)
                }

                if(m.cachePoint){
                    if(!newFormated[newFormated.length-1].cachePoint){
                        newFormated[newFormated.length-1].cachePoint = true
                    }
                }

                continue
            }
            else{
                newFormated.push(m)
            }
        }
        formated = newFormated
    }

    if(flags.includes(LLMFlags.mustStartWithUserInput)){
        if(formated.length === 0 || formated[0].role !== 'user'){
            formated.unshift({
                role: 'user',
                content: ' '
            })
        }
    }

    if(systemPrompt){
        formated.unshift(systemPrompt)
    }

    return formated
}


export async function requestChatDataMain(arg:requestDataArgument, model:ModelModeExtended, abortSignal:AbortSignal=null):Promise<requestDataResponse> {
    const currentChat = getCurrentChat()
    const binding = resolveChatModelBinding(currentChat, model)
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
        onRevenantJobCreated: jobId => {
            createdJobIds.push(jobId)
            callerOnJobCreated?.(jobId)
        },
    }
    targ.mode = model

    const generationRequest = buildGenerationRequest(targ)
    const autoConsume = generationRequest?.job.jobType !== 'model'
        && !targ.revenantOperationContext
        && !targ.revenantClientAction
    const consumeCreatedJobs = async () => {
        if (!autoConsume || createdJobIds.length === 0) return
        try {
            await consumeRevenantAuxiliaryResults(createdJobIds)
        }
        catch (error) {
            // The retained job is pruned by Revenant if acknowledgement is
            // temporarily unavailable. Never discard an already-decoded LLM
            // result merely because the consume receipt failed.
            console.error('[GenerationJob] Failed to consume auxiliary result:', error)
        }
    }

    const response = await requestModelPreset(targ, preset, abortSignal, model)
    if (response.type === 'streaming' && autoConsume) {
        return {
            ...response,
            result: consumeOnStreamCompletion(response.result, consumeCreatedJobs),
        }
    }
    await consumeCreatedJobs()
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


async function requestEchoPreset(preset: ModelPreset, abortSignal: AbortSignal | null): Promise<requestDataResponse> {
    const rawDelay = preset.userValues?.echoDelay
    const delay = typeof rawDelay === 'number' ? rawDelay : 0
    const rawMessage = preset.userValues?.echoMessage
    const message = typeof rawMessage === 'string' ? rawMessage : "Echo Message"

    if(delay > 0){
        await sleep(delay * 1000)
    }

    if(abortSignal?.aborted){
        return {
            type: 'fail',
            result: 'Aborted',
            model: preset.name,
        }
    }

    return {
        type: 'success',
        result: message,
        model: preset.name,
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
    if (!providerName) {
        return {
            type: 'fail',
            result: language.pluginModelUnavailable,
            model: preset.name,
        }
    }
    // addProvider exists in API 2.x too. A crafted/imported snapshot must not
    // turn that legacy provider into a ModelPreset execution path; only a live
    // API 3.0 metadata registration is eligible.
    if (!isV3PluginModel(modelId)) {
        return {
            type: 'fail',
            result: language.pluginModelUnavailable,
            model: preset.name,
        }
    }

    const foldSystem = compiled.behavior.foldSystemPrompt
    const flags: LLMFlags[] = []
    if (!foldSystem) flags.push(LLMFlags.hasFullSystemPrompt)
    else if (compiled.behavior.keepFirstSystemPrompt) flags.push(LLMFlags.hasFirstSystemPrompt)
    if (compiled.behavior.alternateRole) flags.push(LLMFlags.requiresAlternateRole)
    if (compiled.behavior.startWithUserInput) flags.push(LLMFlags.mustStartWithUserInput)

    try {
        arg.formated = reformater(safeStructuredClone(arg.formated), flags)
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

    const genId = arg.chatId ?? `aux-${uuidv4()}`
    const reportStatus = !arg.previewBody && statusEnabled()
    if (reportStatus) {
        safeStatus(() => startStatus(genId, {
            kind: toRequestKind(mode),
            label: preset.name,
            chatId: arg.chatId,
            phase: 'connecting',
            now: Date.now(),
            abortSignal: abortSignal ?? undefined,
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
                safeStatus(() => endStatus(genId, outcome, {
                    now: Date.now(),
                    error: outcome === 'failed'
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
            const text = await collectStreamingText(responseStream)
            return { type: 'success', result: text, model: preset.name }
        }
        return { ...result, result: responseStream, model: preset.name }
    }

    if (reportStatus && result.type === 'success') {
        const responseText = result.result
        if (responseText) {
            safeStatus(() => appendText(genId, { response: responseText }, Date.now()))
        }
        safeStatus(() => endStatus(genId, 'done', { now: Date.now() }))
    } else if (reportStatus) {
        const outcome = abortSignal?.aborted ? 'aborted' : 'failed'
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

    const provider = pluginV2.providers.get(providerName)
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
            result: `Plugin Error from ${modelId}: ${JSON.stringify(error)}`,
            model: modelId,
        }
    }
}

// Provider adapters receive a normal Fetch implementation backed by the shared
// LLM transport. Execution intent stays explicit while route, recovery,
// cancellation, timeout, and local-network behavior stay out of adapters.
function modelsDevUsageIdentity(
    preset: ModelPreset,
): Pick<
    RevenantProviderJobSpec,
    'usageProviderId' | 'usageModelId' | 'usageServiceTier'
> | undefined {
    const source = preset.sourceProfile
    if (source?.registryId !== MODELS_DEV_REGISTRY_ID) return undefined

    const separator = source.profileId.indexOf(':')
    if (separator <= 0 || separator >= source.profileId.length - 1) return undefined
    return {
        usageProviderId: source.profileId.slice(0, separator),
        usageModelId: source.profileId.slice(separator + 1),
        usageServiceTier: preset.claudeBatching ? 'batch' : undefined,
    }
}

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
} {
    if (!(error instanceof ModelPresetAdapterError)) return {}
    return {
        noRetry: !error.retryable,
        failByServerError: error.retryable
            && (error.kind === 'server' || error.kind === 'rate-limit'),
    }
}

// --- request-status publishing (model-preset path only) ------------------
//
// Thin, harmless bridge from the preset request pipeline to the request-status
// channel (src/ts/status/requestStatus). Every call is wrapped so status
// reporting can NEVER break a request (P0: status display must not throw into
// the request path). Gated by db.showRequestStatus so the whole feature is a
// no-op when off — and the classic path is never touched regardless.
//
// Token counts during streaming use a cheap char-based estimate (no per-chunk
// tokenizer cost — mobile-friendly), reconciled against the authoritative
// adapter usage at completion. See .agent/notes/request-status-toast-infra.md.

function statusEnabled(): boolean {
    try {
        return getDatabase()?.showRequestStatus !== false
    } catch {
        return false
    }
}

// Register a LOCAL tokenizer with the status store so the render tick counts
// streamed tokens language-aware (real subwords, good for CJK) instead of a
// char/N estimate. Uses encodeWithTokenizer with a fixed local tokenizer — NOT
// tokenizeNum/encode routes by db.aiModel, while status is only an approximate
// live display (the final count is reconciled from provider usage). A fixed local
// tokenizer avoids unnecessary model-specific work on every render tick.
setStatusTokenCounter(async (text) => {
    const encoded = await encodeWithTokenizer(text, 'tik')
    return encoded.length
})

function safeStatus(fn: () => void): void {
    try { fn() } catch (e) { console.error('[ModelPreset] status publish failed', e) }
}

// Map the request pipeline's mode to the status-channel chip kind. submodel and
// otherAx collapse to 'sub' (both are internal aux calls the user rarely
// distinguishes; see the toast infra note).
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
        // simplifySchema mutates; clone first. Stage 1 targets openai-compatible,
        // whose schema shape matches the default simplification.
        parameters: simplifySchema(safeStructuredClone(tool.inputSchema)),
    }
}

// Render a turn's reasoning for DISPLAY, wrapped in the <Thoughts> tags the chat
// renderer already parses (mirrors the classic anthropic path). Returns '' when
// there is nothing to show, so non-reasoning models are byte-identical to before.
// redacted_thinking has no visible text — surface the same placeholder as classic.
function formatPresetReasoning(reasoning?: AdapterReasoningPart[]): string {
    if (!reasoning || reasoning.length === 0) return ''
    let body = ''
    for (const part of reasoning) {
        if (part.redactedData !== undefined) body += '\n{{redacted_thinking}}\n'
        else if (part.text) body += part.text
    }
    if (body.trim().length === 0) return ''
    return `<Thoughts>\n${body}\n</Thoughts>\n\n`
}

async function formatPresetMedia(media?: AdapterGeneratedMedia[]): Promise<string> {
    if (!media || media.length === 0) return ''
    const markers: string[] = []
    for (const item of media) {
        const id = uuidv4()
        const ext = item.mime.split('/')[1]?.split(';')[0] || (item.kind === 'image' ? 'png' : 'mp3')
        await setInlayAsset(id, {
            name: `generated-${item.kind}.${ext}`,
            type: item.kind,
            data: `data:${item.mime};base64,${item.base64}`,
            ext,
        })
        markers.push(`{{inlayeddata::${id}}}`)
    }
    return markers.join('\n')
}

async function requestModelPreset(arg:RequestDataArgumentExtended, preset:ModelPreset, abortSignal:AbortSignal=null, mode:ModelModeExtended='model'):Promise<requestDataResponse> {
    let compiled: CompiledModelPreset
    try {
        compiled = compileModelPreset(preset, {
            jsonSchemaRequested: getDatabase().jsonSchemaEnabled || !!arg.schema,
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
                    message: typeof preset.userValues?.echoMessage === 'string'
                        ? preset.userValues.echoMessage
                        : "Echo Message",
                    delay: typeof preset.userValues?.echoDelay === 'number'
                        ? preset.userValues.echoDelay
                        : 0,
                }),
                model: preset.name,
            }
        }
        return requestEchoPreset(preset, abortSignal)
    }
    // HTTP streaming adapters expose their ReadableStream before the lazy
    // async generator reaches fetchNative. Track the durable-registration
    // boundary independently so the chat workflow can wait for a late job id,
    // while preparation failures still release that wait with the real error.
    let registrationSettled = false
    const callerOnJobCreated = arg.onRevenantJobCreated
    const callerOnRegistrationUnavailable = arg.onRevenantJobRegistrationUnavailable
    arg.onRevenantJobCreated = jobId => {
        registrationSettled = true
        callerOnJobCreated?.(jobId)
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
    // arg.chatId is the per-request generationId for main chat (sendChat passes
    // it under that name; see generation-state-keying.md §1-bis). Aux requests
    // (translate/memory/emotion/sub) don't supply one, so mint a per-request key
    // here purely for the status channel — it's memory-only and never persisted.
    // Uses uuid v4 (crypto.getRandomValues, available over plain HTTP) NOT
    // crypto.randomUUID (secure-context only — would throw on remote HTTP and
    // break the aux request before the try). Reporting is gated by db.showRequestStatus.
    const genId = arg.chatId ?? `aux-${uuidv4()}`
    const statusKind = toRequestKind(mode)
    const reportStatus = statusEnabled() && !!genId

    // Tool gating. Three guards:
    //  1) Per-preset opt-in (preset.toolUse, default OFF) — the hard regression
    //     guard: while off, this preset's requests stay text-only (streaming
    //     allowed) even for MCP users. One deliberate difference from "do
    //     nothing": the adapters strip any customBody-provided tools /
    //     tool_choice / toolConfig so OFF is a true text gate — a request that
    //     manually smuggled tool fields via customBody will lose them.
    //  2) Adapter registry support — only adapters whose tool wire is implemented.
    //  3) Capability gate: the profile must EXPLICITLY declare 'tools'. Stricter
    //     than the streaming convention (no `!caps` shortcut) so it matches the
    //     editor toggle's visibility — a capability-less custom profile (e.g.
    //     after a profile swap that kept toolUse) can never activate tools.
    const tools = (compiled.features.tools && arg.tools && arg.tools.length > 0)
        ? arg.tools.map(toAdapterToolDef)
        : undefined

    // Vision gate: send attached images when the adapter implements image wire AND
    // either the profile declares the 'vision' capability OR the user opted in via
    // the preset's imageInput toggle (for profiles like ollama / openai-compatible
    // whose snapshot does not declare 'vision'). Additive — both branches default
    // off, so OFF is byte-identical to the prior text-only behavior.
    const supportsVision = compiled.features.vision
    const supportsAudioInput = compiled.features.audioInput
    const supportsVideoInput = compiled.features.videoInput
    const producesMedia = compiled.features.mediaOutput

    // Gemini context caching: MAIN chat requests on the google-gemini adapter
    // (AI Studio key auth OR Vertex native service-account auth) — tool runs and
    // previews are excluded. Both auth kinds share the cachedContents wire; the
    // adapter derives the Studio-vs-Vertex URL/model shape from the prepared
    // chat URL, so the only difference here is admitting google-service-account.
    // The profile must EXPLICITLY declare the 'cache' capability (same gate the
    // editor toggle uses, ModelPresetSettings.svelte): a profile swap that kept
    // promptCaching.enabled but landed on a cache-less profile can never engage
    // caching — otherwise the cachedContents API would be hit every turn on a
    // model that does not support it.
    // Vertex-OpenAI stays out: it routes through openai-compatible, not this
    // adapter kind. The context carries everything the cache layer needs so the
    // adapter never reads the database (SSR rule). The state key is chat.id
    // (present for chats created in current versions; a chat without one is
    // simply not cached). All defaults off → cache undefined → requests
    // byte-identical to before.
    const cacheAuthKind = preset.profileSnapshot.auth.kind
    let cache: AdapterCacheContext | undefined
    if (compiled.features.cache && mode === 'model'
        && !tools && !arg.previewBody
        && (cacheAuthKind === 'x-goog-api-key' || cacheAuthKind === 'google-service-account')) {
        const cacheChatKey = getCurrentChat()?.id
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

    // System/role normalization. The classic path always runs reformater() before
    // dispatch (~431); the preset path skipped it, so models without a native system
    // role (e.g. Ollama Gemma3) never saw bot/persona info folded into user turns.
    // Synthesize the relevant LLMFlags from the preset's ability toggles and reuse
    // reformater (which also honors db.systemRoleReplacement/ContentReplacement, also
    // previously ignored here). All toggles default off → flags = [hasFullSystemPrompt]
    // → reformater is a no-op (byte-identical to the prior preset behavior).
    //
    // Folding is gated on the LIVE adapter kind, not just the toggle: only literal-role
    // adapters (openai-compatible) may fold. anthropic-messages / google-gemini extract
    // system natively (collectSystemAndChat), so folding system→user would strip their
    // system instruction — and gating on `kind` also defuses a stale foldSystemPrompt
    // left over from a profile swap (its UI toggle is hidden on the new kind). Sequence
    // shaping (alternate role / user-first) is adapter-agnostic and applies to all kinds.
    const foldSystem = compiled.behavior.foldSystemPrompt
    const presetFlags: LLMFlags[] = []
    if (!foldSystem) presetFlags.push(LLMFlags.hasFullSystemPrompt)
    else if (compiled.behavior.keepFirstSystemPrompt) presetFlags.push(LLMFlags.hasFirstSystemPrompt)
    if (compiled.behavior.alternateRole) presetFlags.push(LLMFlags.requiresAlternateRole)
    if (compiled.behavior.startWithUserInput) presetFlags.push(LLMFlags.mustStartWithUserInput)
    // reformater mutates its input in place (requiresAlternateRole appends merged
    // content onto the first message of a run). The preset path returns before the
    // legacy clone below, and the retry loop reuses arg.formated, so mutating it
    // directly would re-merge on every retry
    // (A,B → A\nB → A\nB\nB). Clone first, matching the classic path's safeStructuredClone.
    // Also guarded: reformater runs outside the request try below, so a throw returns
    // a graceful fail instead of propagating (mirrors the previewBody/request catches).
    try {
        arg.formated = reformater(safeStructuredClone(arg.formated), presetFlags)
    } catch (err) {
        return { type: 'fail', result: err instanceof Error ? err.message : String(err), model: preset.name }
    }

    // Expand `<tool_call>` history into structured tool turns ONLY on the active
    // tool path. With tools off, fall back to the plain mapping so existing chats
    // behave exactly as before (literal passthrough; no tool-role messages that a
    // text-only adapter would reject). Guards regression P1#2. Image attachments
    // ride along in both branches, gated by supportsVision.
    const includeDeepSeekThinkingInput = compiled.behavior.deepSeekThinkingInput
    const messages = tools
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
                schema: getGeneralJSONSchema(arg.schema),
                strict: getDatabase().strictJsonSchema,
            }
        } catch (err) {
            return {
                type: 'fail',
                result: err instanceof Error ? err.message : String(err),
                model: preset.name,
            }
        }
    }

    // previewBody never calls the chat endpoint and never runs tools — it just
    // builds and returns the prepared request. (One caveat: a google-service-
    // account profile may still perform an OAuth token exchange during credential
    // resolution if its token cache is empty/expired — that exchange is not the
    // chat request. API-key profiles make no network call here.) Mirrors the
    // classic adapters' previewBody handling.
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
        // Tool runs always go non-streaming for now: the execute→re-request loop
        // needs the full structured response (tool_calls) each turn, and
        // streaming tool_call assembly is a later stage. Status is NOT reported
        // for the tool path in v1 (it bypasses the pump); see the toast infra note.
        if (tools) {
            arg.revenantStreaming = false
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
        arg.revenantStreaming = useStreaming
        const options: AdapterChatOptions = {
            messages,
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
                chatId: arg.chatId,
                phase: 'connecting',
                now: startedAt,
                abortSignal: abortSignal ?? undefined,
            }))
            if (arg.revenantDispatchPolicy || arg.revenantWorkflowDependency) {
                arg.onRevenantProviderStarted = combineProviderStartedHandlers(
                    arg.onRevenantProviderStarted,
                    startRequestStatus,
                )
            }
            else {
                startRequestStatus(Date.now())
            }
        }
        if(useStreaming){
            const gen = adapter.stream(preset, options, credential)
            const stream = new ReadableStream<StreamResponseChunk>({
                start(controller){
                    return pumpPresetStream(gen, controller, {
                        intervalMs: STREAM_FLUSH_INTERVAL_MS,
                        formatReasoning: (text) => formatPresetReasoning([{ text }]),
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
                        onDelta: reportStatus ? (delta) => safeStatus(() => {
                            const now = Date.now()
                            if (delta.reasoningDelta) appendText(genId, { thinking: delta.reasoningDelta }, now)
                            if (delta.textDelta) appendText(genId, { response: delta.textDelta }, now)
                        }) : undefined,
                        onFinish: (outcome, lastUsage) => {
                            if (outcome === 'done') {
                                releasePendingRegistration(new Error(
                                    'The model stream completed before durable job registration.',
                                ))
                            }
                            if (!reportStatus) return
                            safeStatus(() => {
                                // A stream that ends via abort throws inside the
                                // generator → 'failed'; reclassify as 'aborted' so the
                                // toast shows "Cancelled" rather than an error.
                                const finalOutcome = outcome === 'failed' && abortSignal?.aborted ? 'aborted' : outcome
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
                const text = await collectStreamingText(stream)
                return { type: 'success', result: text, model: preset.name }
            }
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
                endStatus(genId, 'done', {
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
            result: formatPresetReasoning(response.reasoning) + response.text + separator + media,
            model: preset.name,
        }
    } catch (err) {
        console.error('[ModelPreset] request failed', describeModelPresetError(err))
        if (reportStatus) {
            // Distinguish a user cancel from a real failure for the status toast.
            const outcome = abortSignal?.aborted ? 'aborted' : 'failed'
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

// Binds the real send + tool execution to the generic runToolLoop (kept in the
// adapter layer so it is unit-testable without request.ts's import graph).
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
): Promise<{ result: string; toolsExecuted: boolean }> {
    // Tracks whether any tool actually ran, so the caller can block outer
    // success-path retries that would otherwise re-execute side-effecting tools.
    let toolsExecuted = false
    const result = await runToolLoop(messages, {
        maxSteps: MODEL_PRESET_MAX_TOOL_STEPS,
        formatReasoning: formatPresetReasoning,
        abortSignal: abortSignal ?? undefined,
        send: (convo) => adapter.send(
            preset,
            { messages: convo, tools, structuredOutput, abortSignal: abortSignal ?? undefined, fetchImpl },
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
