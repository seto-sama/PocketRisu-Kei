import { get, writable } from "svelte/store";
import { type character, type MessageGenerationInfo, type Chat, type MessagePresetInfo, type Message, normalizeChat } from "../storage/database.svelte";
import { DBState } from '../stores.svelte';
import { CharEmotion, selectedCharID } from "../stores.svelte";
import { ChatTokenizer, tokenize, tokenizeNum } from "../tokenizer";
import { language } from "../../lang";
import { alertError } from "../alert";
import { parseChatML } from "../parser/chatML";
import { loadLoreBookV3Prompt } from "./lorebook.svelte";
import { findCharacterbyId, getAuthorNoteDefaultText, getPersonaPrompt, getUserName, parseToggleSyntax, prebuiltAssetCommand } from "../util";
import { requestChatData } from "./request/request";
import { stableDiff } from "./stableDiff";
import { processScript, processScriptFull, risuChatParser } from "./scripts";
import { exampleMessage } from "./exampleMessages";
import { sayTTS } from "./tts";
import { v4 } from "uuid";
import { runTrigger, type additonalSysPrompt } from "./triggers";
import { HypaProcesser } from "./memory/hypamemory";
import { additionalInformations } from "./embedding/addinfo";
import { getInlayAsset } from "./files/inlays";
import { getGenerationModelString, getModelPresetMetadata } from "./models/modelString";
import { runInlayScreen } from "./inlayScreen";
import { runImageEmbedding } from "./transformers";
import { hasLuaEditRequestListener, runLuaEditTrigger } from "./scriptings";
import { applyPromptPresetParams, resolveChatModelBinding, resolvePresetMaxOutputTokens } from "./request/modelPresetBinding";
import { hasMessagePayload } from "./request/shared";
import { type RevenantChatWorkflowContext, type RevenantWorkflow, type RevenantWorkflowDependency, type RevenantWorkflowStepStatus, type RevenantRerollSnapshot } from "./revenant";
import {
    cancelRevenantGeneration,
    checkpointRevenantGeneration,
    registerRevenantGenerationMetadata,
    setRevenantGenerationLocallyObserved,
    updateRevenantGenerationMetadata,
} from "./revenant/transport";
import {
    configureRevenantGenerationChatRecovery,
} from "./revenant/recovery";
import {
    beginRevenantWorkflow,
    cancelRevenantWorkflow,
    completeChatGenerationPreModelPlan,
    coordinateRevenantGeneration,
    createChatGenerationWorkflowPlan,
    createRevenantWorkflowUpdateWaiter,
    finishRevenantWorkflow,
    getRevenantWorkflow,
    RevenantWorkflowBusyError,
    serviceRevenantClientActions,
    type RevenantGenerationLifecycle,
    type RevenantWorkflowResumeContext,
    updateRevenantWorkflowStep,
    waitForRevenantHypaExecution,
} from "./revenant/workflow";
import { hypaMemoryV3, type SerializableHypaV3Data } from "./memory/hypav3";
import { getModuleAssets, getModuleRegexScripts, getModules, getModuleToggles, getModuleTriggers } from "./modules";
import { readImage } from "../globalApi.svelte";
import { saveChatToServer } from "../storage/chatStorage";
import { compileModelPreset, type CompiledModelPreset } from "../preset/runtime/compilePreset";
import {
    commitCancelledGenerationProjection,
    ensureGenerationMessageTarget,
    setGenerationMessageContent,
} from './revenant/recovery';

export { recoverRevenantGenerationsForChat } from "./revenant/recovery";

export interface OpenAIChat{
    role: 'system'|'user'|'assistant'|'function'
    content: string
    memo?:string
    name?:string
    removable?:boolean
    attr?:string[]
    multimodals?: MultiModal[]
    thoughts?: string[]
    cachePoint?: boolean
}

export interface MultiModal{
    type:'image'|'video'|'audio'|'signature'
    base64:string,
    height?:number,
    width?:number
}

export interface requestTokenPart{
    name:string
    tokens:number
}

export const doingChat = writable(false)
configureRevenantGenerationChatRecovery({
    isChatBusy: () => get(doingChat),
})
export const chatProcessStage = writable(0)
export const abortChat = writable(false)
export let requestTokenParts:{[key:string]:requestTokenPart[]} = {}
export let previewFormated:OpenAIChat[] = []
export let previewBody:string = ''

function isAdditionalSysPrompt(value:unknown):value is additonalSysPrompt{
    if(!value || typeof value !== 'object' || Array.isArray(value)) return false
    const candidate = value as Partial<additonalSysPrompt>
    return typeof candidate.start === 'string'
        && typeof candidate.historyend === 'string'
        && typeof candidate.promptend === 'string'
}

function isOpenAIChatCheckpoint(value:unknown):value is OpenAIChat{
    if(!value || typeof value !== 'object' || Array.isArray(value)) return false
    const candidate = value as Partial<OpenAIChat>
    return ['system', 'user', 'assistant', 'function'].includes(candidate.role ?? '')
        && typeof candidate.content === 'string'
}

function restoreHypaChatCheckpoint(
    value:unknown,
    inputChats:OpenAIChat[],
):OpenAIChat[]|undefined{
    if(!Array.isArray(value)) return undefined
    const restored:OpenAIChat[] = []
    for(const entry of value){
        if(!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined
        const checkpoint = entry as { inputIndex?:unknown, inputMemo?:unknown, chat?:unknown }
        if(Number.isInteger(checkpoint.inputIndex)){
            const chat = inputChats[checkpoint.inputIndex as number]
            if(!chat) return undefined
            if(
                checkpoint.inputMemo !== undefined
                && checkpoint.inputMemo !== chat.memo
            ) return undefined
            restored.push(chat)
        }
        else if(isOpenAIChatCheckpoint(checkpoint.chat)){
            restored.push(safeStructuredClone(checkpoint.chat))
        }
        else return undefined
    }
    return restored
}

export async function sendChat(chatProcessIndex = -1,arg:{
    chatAdditonalTokens?:number,
    signal?:AbortSignal,
    continue?:boolean,
    preview?:boolean
    previewPrompt?:boolean
    rerollSnapshot?: RevenantRerollSnapshot
    detachSignal?: AbortSignal
    onDetached?: () => void
    generationTarget?: {
        characterId: string
        roomId: string
    }
    revenantResume?: {
        workflow: RevenantWorkflow
        context: RevenantWorkflowResumeContext
    }
} = {}):Promise<boolean> {

    chatProcessStage.set(0)
    const abortSignal = arg.signal ?? (new AbortController()).signal
    
    // NOTE: `throwError()` can be called before these are populated (e.g. HypaV3 early validation errors).
    // Keep them declared up-front to avoid TDZ ReferenceErrors in production builds.
    let selectedChar = -1
    let selectedChat = -1
    let currentChar:character
    let generationInfo:MessageGenerationInfo|undefined = undefined
    const resumeWorkflow = arg.revenantResume?.workflow
    const isContinuation = arg.revenantResume?.context.continue ?? arg.continue === true
    const rerollSnapshot = arg.revenantResume?.context.rerollSnapshot ?? arg.rerollSnapshot
    let revenantWorkflowId:string|undefined = resumeWorkflow?.workflowId
    let revenantMainDependency:RevenantWorkflowDependency|undefined
    let revenantMainBackend:'http'|'plugin'|'echo'|undefined
    let revenantMainJobCreated = (resumeWorkflow?.steps
        .find(step => step.key === 'model.main')?.executions.length ?? 0) > 0
    let revenantMainJobId:string|undefined
    let revenantMainRegistrationError:unknown
    let generationDetached = false

    function finishGenerationDetachment(){
        if(generationDetached) return
        generationDetached = true
        if(revenantMainJobId){
            setRevenantGenerationLocallyObserved(revenantMainJobId, false)
        }
        doingChat.set(false)
        arg.onDetached?.()
    }

    const stageTimings = {
        stage1Start: 0,
        stage2Start: 0,
        stage3Start: 0,
        stage4Start: 0,
        stage1Duration: 0,
        stage2Duration: 0,
        stage3Duration: 0,
        stage4Duration: 0
    }

    let isAborted = false
    let findCharCache:{[key:string]:character} = {}
    function findCharacterbyIdwithCache(id:string){
        const d = findCharCache[id]
        if(!!d){
            return d
        }
        else{
            const r = findCharacterbyId(id)
            findCharCache[id] = r
            return r
        }
    }


    function runCurrentChatFunction(chat:Chat){
        chat.message = chat.message.map((v) => {
            v.data = risuChatParser(v.data, {chara: currentChar, runVar: true})
            return v
        })
        return chat
    }

    function reformatContent(data:string){
        if(chatProcessIndex === -1){
            return data.trim()
        }
        return data.trim()
    }

    function finishStreamingDisplay(){
        const character = DBState.db.characters?.[selectedChar]
        const chat = character?.chats?.[selectedChat]
        if(!chat?.isStreaming){
            return
        }
        chat.isStreaming = false
        character.reloadKeys += 1
    }

    function throwError(error:string){
        if(!DBState?.db?.inlayErrorResponse){
            alertError(error)
            return
        }

        try{
            const db = DBState.db

            // Prefer already-resolved selection, but fall back to current store/db pointers.
            const sc = selectedChar >= 0 ? selectedChar : get(selectedCharID)
            const charRoom = db.characters?.[sc]
            if(!charRoom){
                alertError(error)
                return
            }
            const st = selectedChat >= 0 ? selectedChat : charRoom.chatPage
            const chatRoom = charRoom.chats?.[st]
            if(!chatRoom || !Array.isArray(chatRoom.message)){
                alertError(error)
                return
            }

            const messages = chatRoom.message
            const last = messages[messages.length - 1]
            const suffix = `\n\`\`\`risuerror\n${error}\n\`\`\``

            if(last?.role === 'char'){
                last.data += suffix
                return
            }

            const m:Message = {
                role: 'char',
                data: `\`\`\`risuerror\n${error}\n\`\`\``,
                time: Date.now(),
            }
            if(currentChar?.chaId){
                m.saying = currentChar.chaId
            }
            if(generationInfo){
                m.generationInfo = generationInfo
            }
            messages.push(m)
            return
        }
        catch(e){
            console.error(e)
            alertError(error)
            return
        }
    }

    async function setWorkflowStep(
        stepKey:string,
        status:RevenantWorkflowStepStatus,
        metadata?:Record<string, unknown>,
    ){
        if(!revenantWorkflowId) return
        try{
            await updateRevenantWorkflowStep(revenantWorkflowId, stepKey, status, metadata)
        }
        catch(error){
            console.error(`[GenerationWorkflow] Failed to update ${stepKey} to ${status}:`, error)
        }
    }

    async function finishWorkflow(status:'completed'|'cancelled'|'failed'){
        if(!revenantWorkflowId) return
        const workflowId = revenantWorkflowId
        try{
            if (status === 'cancelled') await cancelRevenantWorkflow(workflowId)
            else await finishRevenantWorkflow(workflowId, status)
            revenantWorkflowId = undefined
        }
        catch(error){
            console.error(`[GenerationWorkflow] Failed to finish ${workflowId}:`, error)
        }
    }

    async function waitForServerWorkflow(workflowId:string):Promise<boolean>{
        while(true){
            const observerSignal = arg.detachSignal
                ? AbortSignal.any([abortSignal, arg.detachSignal])
                : abortSignal
            const updateWaiter = createRevenantWorkflowUpdateWaiter(
                workflowId,
                observerSignal,
            )
            if(arg.detachSignal?.aborted){
                updateWaiter.cancel()
                finishGenerationDetachment()
                return false
            }
            if(abortSignal.aborted){
                updateWaiter.cancel()
                await cancelRevenantWorkflow(workflowId).catch(() => {})
                revenantWorkflowId = undefined
                finishStreamingDisplay()
                doingChat.set(false)
                return false
            }
            try{
                const workflow = await getRevenantWorkflow(workflowId)
                if(workflow.status === 'completed'){
                    updateWaiter.cancel()
                    const canonicalChat = ['postprocess', 'igp', 'trigger.output', 'output.transform']
                        .map(key => workflow.steps.find(step => step.key === key)?.metadata?.chat)
                        .find(chat => chat && typeof chat === 'object' && Array.isArray((chat as Chat).message)) as Chat | undefined
                    if(canonicalChat?.id === DBState.db.characters[selectedChar]?.chats?.[selectedChat]?.id){
                        DBState.db.characters[selectedChar].chats[selectedChat] = normalizeChat(
                            safeStructuredClone(canonicalChat),
                        )
                        currentChar.reloadKeys += 1
                    }
                    const resend = workflow.steps
                        .find(step => step.key === 'postprocess')
                        ?.metadata?.foregroundEffects
                    const shouldResend = Array.isArray(resend)
                        && resend.some(effect => effect && typeof effect === 'object'
                            && (effect as { kind?: unknown }).kind === 'chat.resend')
                    revenantWorkflowId = undefined
                    finishStreamingDisplay()
                    doingChat.set(false)
                    if(shouldResend){
                        return await sendChat(chatProcessIndex, {
                            signal: abortSignal,
                            detachSignal: arg.detachSignal,
                            onDetached: arg.onDetached,
                            generationTarget: arg.generationTarget,
                        })
                    }
                    return true
                }
                if(workflow.status === 'cancelled' || workflow.status === 'failed'){
                    updateWaiter.cancel()
                    const failedStep = workflow.steps.find(step => step.status === 'failed')
                    const error = failedStep?.metadata?.error
                    if(workflow.status === 'failed' && typeof error === 'string') throwError(error)
                    // A server-side postprocess/materialization failure can
                    // arrive after the provider stream already updated the
                    // placeholder. Commit that visible projection (or restore
                    // the pre-reroll snapshot when it is still empty) before
                    // sync cleanup tears down the workflow state.
                    preserveFailedGenerationMessage()
                    revenantWorkflowId = undefined
                    finishStreamingDisplay()
                    doingChat.set(false)
                    return false
                }
                if(workflow.steps.some(step => step.status === 'waiting_client')){
                    await serviceRevenantClientActions(workflow, currentChar, abortSignal)
                }
            }
            catch(error){
                if(abortSignal.aborted) continue
                console.warn('[Revenant] Failed to observe server workflow:', error)
            }
            await updateWaiter.promise
        }
    }

    function wasWorkflowStepCompleted(stepKey:string):boolean{
        const status = resumeWorkflow?.steps.find(step => step.key === stepKey)?.status
        return status === 'completed' || status === 'skipped'
    }

    let isDoing = get(doingChat)

    // `doingChat` is a legacy process-wide activity signal. A UI submission
    // with an explicit room target is instead guarded by that room's local
    // foreground/workflow ownership and by the server's one-main-workflow-per-
    // room constraint. Applying this global lock to it prevents unrelated
    // rooms from starting their own main generation.
    if(isDoing && !arg.generationTarget){
        if(chatProcessIndex === -1){
            return false
        }
    }
    doingChat.set(true)

    if(!resumeWorkflow) DBState.db.statics.messages += 1
    selectedChar = arg.generationTarget
        ? DBState.db.characters.findIndex(character =>
            character?.chaId === arg.generationTarget?.characterId)
        : get(selectedCharID)
    const nowChatroom = DBState.db.characters[selectedChar]
    if(!nowChatroom){
        alertError('The generation character is no longer available.')
        doingChat.set(false)
        return false
    }
    nowChatroom.lastInteraction = Date.now()
    selectedChat = arg.generationTarget
        ? nowChatroom.chats.findIndex(chat =>
            chat?.id === arg.generationTarget?.roomId)
        : nowChatroom.chatPage
    const targetChat = nowChatroom.chats[selectedChat]
    if(!targetChat){
        alertError('The generation chat is no longer available.')
        doingChat.set(false)
        return false
    }
    // Block send if chat is still a placeholder (hydration not complete)
    if (targetChat._placeholder) {
        alertError('Chat is still loading. Please wait a moment.')
        doingChat.set(false)
        return false
    }
    targetChat.message = targetChat.message.map((v) => {
        v.chatId = v.chatId ?? v4()
        return v
    })

    const messageChatId = arg.revenantResume?.context.messageChatId ?? v4()
    const outgoingChat = nowChatroom.chats[selectedChat]
    const continuationFallback = isContinuation
        ? outgoingChat.message.slice().reverse().find(message => message?.role === 'char')?.data ?? ''
        : ''
    function preserveFailedGenerationMessage(content?: string){
        const character = DBState.db.characters.find(item =>
            item?.chaId === nowChatroom.chaId) ?? nowChatroom
        const chat = character.chats.find(item =>
            item?.id === outgoingChat.id)
        if(!chat) return
        const generatedTarget = chat.message.find(message =>
            message?.chatId === messageChatId)
        const continuationTarget = isContinuation
            ? chat.message.slice().reverse().find(message => message?.role === 'char')
            : undefined
        const rerollTarget = rerollSnapshot
            ? chat.message.find(message =>
                message?.chatId === rerollSnapshot.targetMessage.chatId)
                ?? chat.message[rerollSnapshot.targetIndex]
            : undefined
        const targetMessage = generatedTarget ?? continuationTarget ?? rerollTarget
        const preservedContent = isContinuation && content === ''
            ? continuationFallback
            : content ?? generatedTarget?.data ?? ''
        commitCancelledGenerationProjection(chat, {
            messageChatId,
            content: preservedContent,
            isContinuation,
            targetMessage,
            rerollSnapshot,
        })
        character.reloadKeys += 1
    }
    function ensureLiveGenerationTarget(){
        const character = DBState.db.characters.find(item =>
            item?.chaId === nowChatroom.chaId)
        const chat = character?.chats.find(item =>
            item?.id === outgoingChat.id)
        if(!character || !chat) return undefined
        const target = ensureGenerationMessageTarget(chat, {
            messageChatId,
            characterId: nowChatroom.chaId,
            isContinuation,
            generationInfo,
            promptInfo,
            rerollSnapshot,
        })
        return { character, chat, ...target }
    }
    if (resumeWorkflow && rerollSnapshot) {
        const targetIndex = rerollSnapshot.targetIndex
        const targetChatId = rerollSnapshot.targetMessage.chatId
        const currentTarget = outgoingChat.message[targetIndex]
        if (
            Number.isInteger(targetIndex)
            && targetIndex >= 0
            && currentTarget
            && (
                currentTarget.chatId === messageChatId
                || !targetChatId
                || currentTarget.chatId === targetChatId
            )
        ) {
            // Reroll removes the previous assistant turn and trailing comments
            // before prompt construction. Recreate that transient input shape
            // when the persisted chat still contains the old branch.
            outgoingChat.message = outgoingChat.message.slice(0, targetIndex)
        }
    }
    else if (resumeWorkflow && !isContinuation) {
        // A page can disappear in the tiny interval after adding the assistant
        // placeholder but before the server accepts the main job. It is output
        // state, not prompt input, so remove it before rebuilding the request.
        outgoingChat.message = outgoingChat.message.filter(message =>
            message?.chatId !== messageChatId)
    }
    const outgoingMessage = outgoingChat.message[outgoingChat.message.length - 1]
    if(
        resumeWorkflow
        && (resumeWorkflow.characterId !== nowChatroom.chaId || resumeWorkflow.roomId !== outgoingChat.id)
    ){
        alertError('The recoverable generation workflow does not belong to the active chat.')
        doingChat.set(false)
        return false
    }
    const resumeHypaStep = resumeWorkflow?.steps.find(step => step.key === 'memory.hypav3')
    const hypaEnabled = resumeWorkflow
        ? !!resumeHypaStep && resumeHypaStep.status !== 'skipped'
        : !!((outgoingChat.supaMemory ?? nowChatroom.supaMemory) && DBState.db.hypaV3)
    const claimBinding = resolveChatModelBinding(outgoingChat, 'model')
    const generationModelMetadata = getModelPresetMetadata(
        claimBinding.kind === 'modelPreset' ? claimBinding.preset : undefined,
    )
    const usesOpenAIStyleTokenAccounting = generationModelMetadata.format === 'openai-compatible'
        || generationModelMetadata.format === 'openai-responses'
    const mergesAdjacentSystemPrompts = usesOpenAIStyleTokenAccounting
        || generationModelMetadata.format === 'anthropic-messages'
        || generationModelMetadata.format === 'amazon-bedrock'
    let compiledMainPreset:CompiledModelPreset|undefined
    if(!resumeWorkflow && !arg.preview && !arg.previewPrompt && claimBinding.kind === 'modelPreset'){
        try{
            const effectiveMainPreset = applyPromptPresetParams(
                claimBinding.preset,
                outgoingChat,
                'model',
            )
            compiledMainPreset = compileModelPreset(effectiveMainPreset, {
                jsonSchemaRequested: DBState.db.jsonSchemaEnabled,
            })
            revenantMainBackend = compiledMainPreset.backend
        }
        catch(error){
            const message = error instanceof Error ? error.message : String(error)
            alertError(message)
            doingChat.set(false)
            return false
        }
    }
    else if (resumeWorkflow && claimBinding.kind === 'modelPreset') {
        try {
            revenantMainBackend = compileModelPreset(claimBinding.preset, {
                jsonSchemaRequested: DBState.db.jsonSchemaEnabled,
            }).backend
        }
        catch {
            // The ordinary request path reports the actionable preset compile
            // error. Backend knowledge is only needed to wait for a lazy HTTP
            // stream to reach durable registration.
        }
    }
    if (outgoingMessage?.role === 'user' && !wasWorkflowStepCompleted('user.persist')) {
        await setWorkflowStep('user.persist', 'running')
        if (!outgoingChat.id) {
            alertError('Cannot save the message because the chat has no id.')
            doingChat.set(false)
            return false
        }
        try {
            // Persist and broadcast the user's turn before generation marks
            // this chat as streaming. Streaming chats are intentionally
            // skipped by the normal reactive save loop.
            await saveChatToServer(
                nowChatroom.chaId,
                selectedChat,
                outgoingChat.id,
                outgoingChat,
            )
        } catch (error) {
            console.error('[Chat] Failed to persist outgoing message before generation:', error)
            alertError(error)
            await finishWorkflow('failed')
            doingChat.set(false)
            return false
        }
        await setWorkflowStep('user.persist', 'completed')
    }
    
    let promptInfo: MessagePresetInfo = {}
    let initialPresetNameForPromptInfo = null
    let initialPromptTogglesForPromptInfo: {
        key: string,
        value: string,
    }[] = []
    if(DBState.db.promptInfoInsideChat){
        initialPresetNameForPromptInfo = DBState.db.botPresets[DBState.db.botPresetsId]?.name ?? ''
        initialPromptTogglesForPromptInfo = parseToggleSyntax(DBState.db.customPromptTemplateToggle + getModuleToggles())
            .flatMap(toggle => {
                const raw = DBState.db.globalChatVariables[`toggle_${toggle.key}`]
                if (toggle.type === 'select' || toggle.type === 'text') {
                    return [{ key: toggle.value, value: toggle.options[raw] }];
                }
                if (raw === '1') {
                    return [{ key: toggle.value, value: 'ON' }];
                }
                return [];
            })

        promptInfo = {
            promptName: initialPresetNameForPromptInfo,
            promptToggles: initialPromptTogglesForPromptInfo,
        }
    }

    let caculatedChatTokens = 0
    if(usesOpenAIStyleTokenAccounting){
        caculatedChatTokens += 5
    }
    else{
        caculatedChatTokens += 3
    }

    currentChar = nowChatroom
    const hasEditRequestLua = hasLuaEditRequestListener(currentChar)
    const deferredHypaMemoryPrompt = revenantWorkflowId && !hasEditRequestLua
        ? `__RISU_REVENANT_HYPA_${v4()}__`
        : undefined

    let chatAdditonalTokens = arg.chatAdditonalTokens ?? caculatedChatTokens
    let currentChat = runCurrentChatFunction(nowChatroom.chats[selectedChat])
    nowChatroom.chats[selectedChat] = currentChat
    const mainBinding = resolveChatModelBinding(currentChat, 'model')
    const presetTokenizer = mainBinding.kind === 'modelPreset'
        ? (mainBinding.preset.tokenizerOverride ?? mainBinding.preset.profileSnapshot.recommendedTokenizer)
        : undefined
    const tokenizer = new ChatTokenizer(
        chatAdditonalTokens,
        usesOpenAIStyleTokenAccounting ? 'noName' : 'name',
        presetTokenizer,
    )
    let maxContextTokens = DBState.db.maxContext
    // Output-token reservation for the context budget. Defaults to the legacy
    // global db.maxResponse (the "[채팅 봇]" max response size), overridden below
    // when this chat is bound to a ModelPreset.
    let maxResponseTokens = DBState.db.maxResponse
    // When this chat is bound to a ModelPreset, use the preset's own input
    // budget (preset.maxContext, default 65000) instead of the global
    // db.maxContext — clamped to the model's context window when known.
    // Without this, a small global maxContext blocks large-context presets.
    {
        if (mainBinding.kind === 'modelPreset') {
            const ctxWindow = mainBinding.preset.profileSnapshot.limits?.contextWindowTokens
            const set = mainBinding.preset.maxContext
            const defaultBudget = DBState.db.modelPresetDefaultMaxContext && DBState.db.modelPresetDefaultMaxContext > 0
                ? DBState.db.modelPresetDefaultMaxContext
                : 65000
            const budget = DBState.db.modelPresetPromptPresetFirst
                ? DBState.db.maxContext
                : (set && set > 0 ? set : defaultBudget)
            maxContextTokens = ctxWindow ? Math.min(budget, ctxWindow) : budget
            // Reserve output tokens from the preset's own max-output setting
            // rather than db.maxResponse — the legacy global value can be a
            // stray figure (e.g. 65535 carried over from an imported prompt
            // preset) that would eat the whole context window and make even the
            // first message fail with a false "too much token" error.
            if (!DBState.db.modelPresetPromptPresetFirst) {
                const presetOut = resolvePresetMaxOutputTokens(mainBinding.preset, DBState.db.modelPresetDefaultMaxResponse)
                if (presetOut !== undefined) {
                    maxResponseTokens = presetOut
                }
                else if (DBState.db.modelPresetDefaultMaxResponse && DBState.db.modelPresetDefaultMaxResponse > 0) {
                    maxResponseTokens = DBState.db.modelPresetDefaultMaxResponse
                }
            }
        }
    }

    chatProcessStage.set(1)
    stageTimings.stage1Start = Date.now()
    let unformated = {
        'main':([] as OpenAIChat[]),
        'jailbreak':([] as OpenAIChat[]),
        'chats':([] as OpenAIChat[]),
        'lorebook':([] as OpenAIChat[]),
        'globalNote':([] as OpenAIChat[]),
        'authorNote':([] as OpenAIChat[]),
        'lastChat':([] as OpenAIChat[]),
        'description':([] as OpenAIChat[]),
        'postEverything':([] as OpenAIChat[]),
        'personaPrompt':([] as OpenAIChat[])
    }

    let promptTemplate = safeStructuredClone(DBState.db.promptTemplate)
    const usingPromptTemplate = !!promptTemplate
    if(promptTemplate){
        let hasPostEverything = false
        for(const card of promptTemplate){
            if(card.type === 'postEverything'){
                hasPostEverything = true
                break
            }
        }

        if(!hasPostEverything){
            promptTemplate.push({
                type: 'postEverything'
            })
        }
    }
    if(currentChar.utilityBot && (!(usingPromptTemplate && DBState.db.promptSettings.utilOverride))){
        promptTemplate = [
            {
              "type": "plain",
              "text": "",
              "role": "system",
              "type2": "main"
            },
            {
              "type": "description",
            },
            {
              "type": "lorebook",
            },
            {
              "type": "chat",
              "rangeStart": 0,
              "rangeEnd": "end"
            },
            {
              "type": "plain",
              "text": "",
              "role": "system",
              "type2": "globalNote"
            },
            {
                'type': "postEverything"
            }
        ]
    }

    if((!currentChar.utilityBot) && (!promptTemplate)){
        const mainp = currentChar.systemPrompt?.replaceAll('{{original}}', DBState.db.mainPrompt) || DBState.db.mainPrompt


        function formatPrompt(data:string){
            if(!data.startsWith('@@')){
                data = "@@system\n" + data
            }
            const parts = data.split(/@@@?(user|assistant|system)\n/);
  
            // Initialize empty array for the chat objects
            const chatObjects: OpenAIChat[] = [];
            
            // Loop through the parts array two elements at a time
            for (let i = 1; i < parts.length; i += 2) {
              const role = parts[i] as 'user' | 'assistant' | 'system';
              const content = parts[i + 1]?.trim() || '';
              chatObjects.push({ role, content });
            }

            return chatObjects;
        }

        unformated.main.push(...formatPrompt(risuChatParser(mainp, {chara: currentChar})))
    
        if(DBState.db.jailbreakToggle){
            unformated.jailbreak.push(...formatPrompt(risuChatParser(DBState.db.jailbreak, {chara: currentChar})))
        }
    
        unformated.globalNote.push(...formatPrompt(risuChatParser(currentChar.replaceGlobalNote?.replaceAll('{{original}}', DBState.db.globalNote) || DBState.db.globalNote, {chara:currentChar})))
    }

    if(currentChat.note){
        unformated.authorNote.push({
            role: 'system',
            content: risuChatParser(currentChat.note, {chara: currentChar})
        })
    }
    else if(getAuthorNoteDefaultText() !== ''){
        unformated.authorNote.push({
            role: 'system',
            content: risuChatParser(getAuthorNoteDefaultText(), {chara: currentChar})
        })
    }

    let baseDescriptionPrompt:OpenAIChat|null = null
    let beforeDescriptionPrompts:OpenAIChat[] = []
    let afterDescriptionPrompts:OpenAIChat[] = []

    if(DBState.db.chainOfThought && (!(usingPromptTemplate && DBState.db.promptSettings.customChainOfThought))){
        unformated.postEverything.push({
            role: 'system',
            content: `<instruction> - before respond everything, Think step by step as a ai assistant how would you respond inside <Thoughts> xml tag. this must be less than 5 paragraphs.</instruction>`
        })
    }

    {
        let description = risuChatParser(currentChar.desc, {chara: currentChar})

        const additionalInfo = await additionalInformations(currentChar, currentChat)

        if(additionalInfo){
            description += '\n\n' + risuChatParser(additionalInfo, {chara:currentChar})
        }

        if(currentChar.personality){
            description += risuChatParser("\n\nDescription of {{char}}: " + currentChar.personality, {chara: currentChar})
        }

        if(currentChar.scenario){
            description += risuChatParser("\n\nCircumstances and context of the dialogue: " + currentChar.scenario, {chara: currentChar})
        }

        baseDescriptionPrompt = {
            role: 'system',
            content: description
        }
        unformated.description.push(baseDescriptionPrompt)

    }

    const lorepmt = await loadLoreBookV3Prompt()

    const positionRegex = /{{position::(.+?)}}/g
    const replaceposition = (text:string):{text:string, replaced:boolean} => {
        let replaced = false
        const result = text.replace(positionRegex, (match, p1) => {
            replaced = true
            const posMatch = 'pt_' + p1
            const matchingPrompts: string[] = []
            for (const v of lorepmt.actives) {
                if (v.pos === posMatch) {
                    matchingPrompts.push(v.prompt)
                }
            }
            return matchingPrompts.join('\n')
        })
        return {text: result, replaced}
    }

    // maxDepth controls how many levels of nesting are resolved. Currently set to 5, adjust if needed.
    const resolvePosition = (text:string, maxDepth:number = 5) => {
        let result = text
        for(let i=0; i<maxDepth;i++) {
            const r = replaceposition(result)
            result = r.text
            if(!r.replaced) break
        }
        result = result.replace(positionRegex, '')
        return result
    }

    const normalActives = lorepmt.actives.filter(v => {
        return v.pos === '' && v.inject === null
    })
    console.log(normalActives)

    for(const lorebook of normalActives){
        unformated.lorebook.push({
            role: lorebook.role,
            content: risuChatParser(resolvePosition(lorebook.prompt), {chara: currentChar})
        })
    }

    const descActives = lorepmt.actives.filter(v => {
        return v.pos === 'after_desc' || v.pos === 'before_desc' || v.pos === 'personality' || v.pos === 'scenario'
    })

    for(const lorebook of descActives){
        const c = {
            role: lorebook.role,
            content: risuChatParser(resolvePosition(lorebook.prompt), {chara: currentChar})
        }
        if(lorebook.pos === 'before_desc'){
            beforeDescriptionPrompts.unshift(c)
            unformated.description.unshift(c)
        }
        else{
            afterDescriptionPrompts.push(c)
            unformated.description.push(c)
        }
    }

    const personaPromptText = getPersonaPrompt()
    if(personaPromptText){
        unformated.personaPrompt.push({
            role: 'system',
            content: risuChatParser(personaPromptText, {chara: currentChar})
        })
    }
    
    if(currentChar.inlayViewScreen){
        if(currentChar.viewScreen === 'emotion'){
            unformated.postEverything.push({
                role: 'system',
                content: currentChar.newGenData.emotionInstructions.replaceAll('{{slot}}', currentChar.emotionImages.map((v) => v[0]).join(', '))
            })
        }
        if(currentChar.viewScreen === 'imggen'){
            unformated.postEverything.push({
                role: 'system',
                content: currentChar.newGenData.instructions
            })
        }
    }

    const postEverythingLorebooks = lorepmt.actives.filter(v => {
        return v.pos === 'depth' && v.depth === 0 && v.role !== 'assistant'
    })
    for(const lorebook of postEverythingLorebooks){
        unformated.postEverything.push({
            role: lorebook.role,
            content: risuChatParser(resolvePosition(lorebook.prompt), {chara: currentChar})
        })
    }

    //Since assistant needs to be prefill, we need to add assistant lorebooks after user/system lorebooks
    const postEverythingAssistantLorebooks = lorepmt.actives.filter(v => {
        return v.pos === 'depth' && v.depth === 0 && v.role === 'assistant'
    })

    const injectionLorebooks = lorepmt.actives.filter(v => {
        return v.inject && !v.inject.lore
    })

    const injectionLorePosSet = new Set<string>()
    for(const lorebook of injectionLorebooks){
        injectionLorePosSet.add(lorebook.inject.location)
    }
    
    for(const lorebook of postEverythingAssistantLorebooks){
        unformated.postEverything.push({
            role: lorebook.role,
            content: risuChatParser(resolvePosition(lorebook.prompt), {chara: currentChar})
        })
    }

    //await tokenize currernt
    let currentTokens = maxResponseTokens
    let supaMemoryCardUsed = false
    
    //for unexpected error
    currentTokens += 50
    
    const positionParser = (text:string, loc:string) => {
        console.log(injectionLorePosSet)
        if(injectionLorePosSet.has(loc)){
            const matchings = injectionLorebooks.filter(v => {
                return v.inject.location === loc
            })
            for(const lore of matchings){
                switch(lore.inject.operation){
                    case 'append':{
                        text += ' ' + lore.prompt
                        break
                    }
                    case 'prepend':{
                        text = lore.prompt + ' ' + text
                        break
                    }
                    case 'replace':{
                        text = text.replace(lore.inject.param, lore.prompt)
                        break
                    }
                }
            }
        }

        return resolvePosition(text)
    }

    const resolvePositionCBS = (text: string) => {
        return text.replace(positionRegex, (match, p1) => {
            const posMatch = 'pt_' + p1
            const matchingPrompts: string[] = []
            for (const v of lorepmt.actives) {
                if (v.pos === posMatch) {
                    matchingPrompts.push(v.prompt)
                }
            }
            return matchingPrompts.join('\n')
        })
    }

    let hasCachePoint = false
    const convertPromptRole = {
        "system": "system",
        "user": "user",
        "bot": "assistant"
    } as const

    function applyPromptBlockRole(chats:OpenAIChat[], role?: 'user'|'bot'|'system'){
        if(!role){
            return
        }
        for(const chat of chats){
            chat.role = convertPromptRole[role]
        }
    }

    function getDescriptionPrompts(role?: 'user'|'bot'|'system'){
        const pmt = [
            ...safeStructuredClone(beforeDescriptionPrompts),
            ...(baseDescriptionPrompt ? [safeStructuredClone(baseDescriptionPrompt)] : []),
            ...safeStructuredClone(afterDescriptionPrompts)
        ]
        if(baseDescriptionPrompt){
            applyPromptBlockRole([pmt[beforeDescriptionPrompts.length]], role)
        }
        return pmt
    }

    function getLorebookPrompts(role?: 'user'|'bot'|'system'){
        const pmt = safeStructuredClone(unformated.lorebook)
        if(!role){
            return pmt
        }
        for(let i=0;i<pmt.length;i++){
            if(!normalActives[i]?.hasRoleOverride){
                applyPromptBlockRole([pmt[i]], role)
            }
        }
        return pmt
    }

    if(promptTemplate){
        const template = promptTemplate

        async function tokenizeChatArray(chats:OpenAIChat[]){
            for(const chat of chats){
                const tokens = await tokenizer.tokenizeChat(chat)
                currentTokens += tokens
            }
        }

        for(const card of template){
            switch(card.type){
                case 'persona':{
                    let pmt = safeStructuredClone(unformated.personaPrompt)
                    applyPromptBlockRole(pmt, card.role)
                    for(let i=0;i<pmt.length;i++){
                        pmt[i].content = resolvePositionCBS(pmt[i].content)
                    }
                    if(card.innerFormat && pmt.length > 0){
                        for(let i=0;i<pmt.length;i++){
                            pmt[i].content = risuChatParser(positionParser(card.innerFormat,card.type), {chara: currentChar}).replace('{{slot}}', pmt[i].content)
                        }
                    }

                    await tokenizeChatArray(pmt)
                    break
                }
                case 'description':{
                    let pmt = getDescriptionPrompts(card.role)
                    for(let i=0;i<pmt.length;i++){
                        pmt[i].content = resolvePositionCBS(pmt[i].content)
                    }
                    if(card.innerFormat && pmt.length > 0){
                        for(let i=0;i<pmt.length;i++){
                            pmt[i].content = risuChatParser(positionParser(card.innerFormat,card.type), {chara: currentChar}).replace('{{slot}}', pmt[i].content)
                        }
                    }

                    await tokenizeChatArray(pmt)
                    break
                }
                case 'authornote':{
                    let pmt = safeStructuredClone(unformated.authorNote)
                    applyPromptBlockRole(pmt, card.role)
                    if(card.innerFormat && pmt.length > 0){
                        for(let i=0;i<pmt.length;i++){
                            pmt[i].content = risuChatParser(positionParser(card.innerFormat,card.type), {chara: currentChar}).replace('{{slot}}', pmt[i].content || card.defaultText || '')
                        }
                    }

                    await tokenizeChatArray(pmt)
                    break
                }
                case 'lorebook':{
                    await tokenizeChatArray(getLorebookPrompts(card.role))
                    break
                }
                case 'postEverything':{
                    await tokenizeChatArray(unformated.postEverything)
                    if(usingPromptTemplate && DBState.db.promptSettings.postEndInnerFormat){
                        await tokenizeChatArray([{
                            role: 'system',
                            content: DBState.db.promptSettings.postEndInnerFormat
                        }])
                    }
                    break
                }
                case 'plain':
                case 'jailbreak':
                case 'cot':{
                    if((!DBState.db.jailbreakToggle) && (card.type === 'jailbreak')){
                        continue
                    }
                    if((!DBState.db.chainOfThought) && (card.type === 'cot')){
                        continue
                    }

                    const posType = card.type === 'plain' ? card.type2 : card.type
                    let content = positionParser(card.text, posType)

                    if(card.type2 === 'globalNote'){
                        if(currentChar.replaceGlobalNote){
                            content = positionParser(currentChar.replaceGlobalNote, posType).replaceAll('{{original}}', content)
                        }
                        
                        if(currentChar.prebuiltAssetCommand && !card.text.includes('{{//@customimageinstruction}}')){
                            content += prebuiltAssetCommand
                        }
                        content = (risuChatParser(content, {chara: currentChar, role: card.role}))
                    }
                    else if(card.type2 === 'main'){
                        content = (risuChatParser(content, {chara: currentChar, role: card.role}))
                    }
                    else{
                        content = risuChatParser(content, {chara: currentChar, role: card.role})
                    }

                    const prompt:OpenAIChat ={
                        role: convertPromptRole[card.role],
                        content: content
                    }

                    await tokenizeChatArray([prompt])
                    break
                }
                case 'chatML':{
                    let prompts = parseChatML(card.text)
                    await tokenizeChatArray(prompts)
                    break
                }
                case 'chat':{
                    let start = card.rangeStart
                    let end = (card.rangeEnd === 'end') ? unformated.chats.length : card.rangeEnd
                    if(start === -1000){
                        start = 0
                        end = unformated.chats.length
                    }
                    if(start < 0){
                        start = unformated.chats.length + start
                        if(start < 0){
                            start = 0
                        }
                    }
                    if(end < 0){
                        end = unformated.chats.length + end
                        if(end < 0){
                            end = 0
                        }
                    }
                    
                    if(start >= end){
                        break
                    }
                    let chats = unformated.chats.slice(start, end)

                    if(usingPromptTemplate && DBState.db.promptSettings.sendChatAsSystem && (!card.chatAsOriginalOnSystem)){
                        chats = systemizeChat(chats)
                    }
                    await tokenizeChatArray(chats)
                    break
                }
                case 'memory':{
                    supaMemoryCardUsed = true
                    break
                }
                case 'cache':{
                    hasCachePoint = true
                    break
                }
            }
        }
    }
    else{
        for(const key in unformated){
            const chats = unformated[key] as OpenAIChat[]
            for(const chat of chats){
                currentTokens += await tokenizer.tokenizeChat(chat)
            }
        }
    }
    
    const examples = exampleMessage(currentChar, getUserName())

    for(const example of examples){
        currentTokens += await tokenizer.tokenizeChat(example)
    }

    let chats:OpenAIChat[] = examples

    if(!DBState.db?.promptSettings?.trimStartNewChat){
        chats.push({
            role: 'system',
            content: '[Start a new chat]',
            memo: "NewChat"
        })
    }

    
    let msReseted = false
    const makeMs = (currentChat:Chat) => {
        let mss:Message[] = []
        msReseted = false
        for(let i=currentChat.message.length -1;i>=0;i--){
            const d = currentChat.message[i]
            if(d.disabled === true){
                continue
            }
            if(d.disabled === 'allBefore'){
                msReseted = true
                break
            }
            mss.unshift(d)
        }
        return mss
    }

    let ms:Message[] = makeMs(currentChat)

    if(!msReseted && !currentChat.firstMessageDisabled){
        const firstMsg = currentChat.fmIndex === -1 ? nowChatroom.firstMessage : nowChatroom.alternateGreetings[currentChat.fmIndex]

        const chat:OpenAIChat = {
            role: 'assistant',
            content: await (processScript(nowChatroom,
                risuChatParser(firstMsg, {chara: currentChar}),
            'editprocess'))
        }

        if(usingPromptTemplate && DBState.db.promptSettings.sendName){
            chat.content = `${currentChar.name}: ${chat.content}`
            chat.attr = ['nameAdded']
        }
        chats.push(chat)
        currentTokens += await tokenizer.tokenizeChat(chat)
    }
    
    console.log('Prepared messages for token calculation:', ms)

    const storedTriggerMetadata = resumeWorkflow?.steps
        .find(step => step.key === 'trigger.start')?.metadata
    const storedAdditionalPrompt = storedTriggerMetadata?.additionalSysPrompt
    let triggerAdditionalSysPrompt:additonalSysPrompt|undefined =
        isAdditionalSysPrompt(storedAdditionalPrompt)
            ? storedAdditionalPrompt
            : undefined
    if(!wasWorkflowStepCompleted('trigger.start')){
        await setWorkflowStep('trigger.start', 'running')
        const triggerResult = await runTrigger(currentChar, 'start', {chat: currentChat})
        if(triggerResult){
            currentChat = triggerResult.chat
            // Generation owns the room captured at submission time. The user
            // may switch rooms while this trigger is awaiting; setCurrentChat
            // would then overwrite the newly selected room and make navigation
            // appear to snap back to the generating chat.
            DBState.db.characters[selectedChar].chats[selectedChat] = normalizeChat(currentChat)
            ms = makeMs(currentChat)
            currentTokens += triggerResult.tokens
            triggerAdditionalSysPrompt = triggerResult.additonalSysPrompt
            if(revenantWorkflowId){
                await saveChatToServer(
                    nowChatroom.chaId,
                    selectedChat,
                    outgoingChat.id,
                    currentChat,
                )
            }
            if(triggerResult.stopSending){
                await setWorkflowStep('trigger.start', 'completed', {
                    additionalSysPrompt: triggerAdditionalSysPrompt,
                    tokens: triggerResult.tokens,
                })
                await finishWorkflow('cancelled')
                doingChat.set(false)
                return false
            }
        }
        await setWorkflowStep('trigger.start', 'completed', {
            additionalSysPrompt: triggerAdditionalSysPrompt,
            tokens: triggerResult?.tokens ?? 0,
        })
    }
    else if(typeof storedTriggerMetadata?.tokens === 'number'){
        currentTokens += storedTriggerMetadata.tokens
    }

    let index = 0
    for(const msg of ms){
        let formatedChat = (await processScriptFull(nowChatroom,risuChatParser(msg.data, {chara: currentChar, role: msg.role}), 'editprocess', index, {
            chatRole: msg.role,
        })).data
        let name = ''
        if(msg.role === 'char'){
            if(msg.saying){
                name = `${findCharacterbyIdwithCache(msg.saying).name}`
            }
            else{
                name = `${currentChar.name}`
            }
        }
        else if(msg.role === 'user'){
            name = `${getUserName()}`
        }
        if(!msg.chatId){
            msg.chatId = v4()
        }
        let inlays:string[] = []
        if(msg.role === 'char'){
            formatedChat = formatedChat.replace(/{{(inlay|inlayed|inlayeddata)::(.+?)}}/g, (
                match: string,
                p1: string,
                p2: string
            ) => {
                if(p2 && p1 === 'inlayeddata'){
                    inlays.push(p2)
                }
                return ''
            })
        }
        else{
            const inlayMatch = formatedChat.match(/{{(inlay|inlayed|inlayeddata)::(.+?)}}/g)
            if(inlayMatch){
                for(const inlay of inlayMatch){
                    inlays.push(inlay)
                }
            }
        }

        let multimodal:MultiModal[] = []
        if(inlays.length > 0){
            for(const inlay of inlays){
                const inlayName = inlay.replace('{{inlayed::', '').replace('{{inlay::', '').replace('}}', '').replace('{{inlayeddata::', '')
                const inlayData = await getInlayAsset(inlayName)
                if(inlayData?.type === 'image'){
                    if(generationModelMetadata.vision){
                        multimodal.push({
                            type: 'image',
                            base64: inlayData.data,
                            width: inlayData.width,
                            height: inlayData.height
                        })
                    }
                    else{
                        const captionResult = await runImageEmbedding(inlayData.data) 
                        formatedChat += `[${captionResult[0].generated_text}]`
                    }
                }
                if(inlayData?.type === 'video' || inlayData?.type === 'audio'){
                    if(multimodal.length === 0){
                        multimodal.push({
                            type: inlayData.type,
                            base64: inlayData.data
                        })
                    }
                }
                if(inlayData?.type === 'signature'){
                    multimodal.push({
                        type: 'signature',
                        base64: inlayData.data
                    })
                }
                formatedChat = formatedChat.replace(inlay, '')
            }
        }

        let attr:string[] = []
        let role:'user'|'assistant'|'system' = msg.role === 'user' ? 'user' : 'assistant'

        if(usingPromptTemplate && DBState.db.promptSettings.sendName){
            const form = DBState.db.groupTemplate || `<{{char}}\'s Message>\n{{slot}}\n</{{char}}\'s Message>`
            formatedChat = risuChatParser(form, {chara: currentChar.name}).replace('{{slot}}', formatedChat)
        }
        let thoughts:string[] = []
        const maxThoughtDepth = DBState.db.promptSettings?.maxThoughtTagDepth ?? -1
        formatedChat = formatedChat.replace(/<Thoughts>(.+)<\/Thoughts>/gms, (match, p1) => {
            if(maxThoughtDepth === -1 || (maxThoughtDepth - ms.length) <= index){
                thoughts.push(p1)
            }
            return ''
        })

        const assetPromises:Promise<void>[] = []
        formatedChat = formatedChat.replace(/\{\{asset_?prompt::(.+?)\}\}/gmsiu, (match, p1) => {
            const moduleAssets = getModuleAssets()
            const assets = (currentChar.additionalAssets ?? []).concat(moduleAssets)
            const asset = assets.find(v => {
                return v[0] === p1
            })
            if(asset){
                assetPromises.push((async () => {
                    const assetDataBuf = await readImage(asset[1])
                    multimodal.push({
                        type: "image",
                        base64: `data:image/png;base64,${Buffer.from(assetDataBuf).toString('base64')}`
                    })
                })())
            }
            else if(p1 === 'icon'){
                assetPromises.push((async () => {
                    const assetDataBuf = await readImage(currentChar.image ?? '')
                    multimodal.push({
                        type: "image",
                        base64: `data:image/png;base64,${Buffer.from(assetDataBuf).toString('base64')}`
                    })
                })())
            }
            return ''          
        })
        await Promise.all(assetPromises)

        const chat:OpenAIChat = {
            role: role,
            content: formatedChat,
            memo: msg.chatId,
            attr: attr,
            multimodals: multimodal,
            thoughts: thoughts
        }
        if(chat.multimodals.length === 0){
            delete chat.multimodals
        }
        chats.push(chat)
        currentTokens += await tokenizer.tokenizeChat(chat)
        index++
    }
    console.log(JSON.stringify(chats, null, 2))

    const depthPrompts = lorepmt.actives.filter(v => {
        return (v.pos === 'depth' && v.depth > 0) || v.pos === 'reverse_depth'
    })

    for(const depthPrompt of depthPrompts){
        const chat:OpenAIChat = {
            role: depthPrompt.role,
            content: risuChatParser(resolvePosition(depthPrompt.prompt), {chara: currentChar})
        }
        currentTokens += await tokenizer.tokenizeChat(chat)
    }
    
    if(hypaEnabled){
        const hypaStep = resumeHypaStep
        const checkpointSequence = hypaStep?.metadata?.chatSequence
        const checkpointTokens = hypaStep?.metadata?.currentTokens
        const restoredCheckpointChats = hypaStep?.status === 'completed'
            ? restoreHypaChatCheckpoint(checkpointSequence, chats)
            : undefined
        const hasHypaCheckpoint = hypaStep?.status === 'completed'
            && restoredCheckpointChats !== undefined
            && typeof checkpointTokens === 'number'
            && Number.isFinite(checkpointTokens)
        if(hasHypaCheckpoint){
            chats = restoredCheckpointChats
            currentTokens = checkpointTokens
            const checkpointMemory = hypaStep?.metadata?.hypaMemory
            if (
                checkpointMemory
                && typeof checkpointMemory === 'object'
                && Array.isArray((checkpointMemory as { summaries?: unknown }).summaries)
            ) {
                currentChat.hypaV3Data = safeStructuredClone(
                    checkpointMemory as unknown as SerializableHypaV3Data,
                )
                DBState.db.characters[selectedChar].chats[selectedChat].hypaV3Data = currentChat.hypaV3Data
            }
        }
        else{
            await setWorkflowStep('memory.hypav3', 'running')
            stageTimings.stage1Duration = Date.now() - stageTimings.stage1Start
            chatProcessStage.set(2)
            stageTimings.stage2Start = Date.now()
            console.log("Current chat's hypaV3 Data: ", currentChat.hypaV3Data)
            const hypaInputChats = chats
            const sp = await hypaMemoryV3(
                hypaInputChats,
                currentTokens,
                maxContextTokens,
                currentChat,
                nowChatroom,
                tokenizer,
                {
                    workflowId: revenantWorkflowId,
                    signal: abortSignal,
                    deferredMemoryPrompt: deferredHypaMemoryPrompt,
                    onRemoteSelectionRequiresClient: hasEditRequestLua
                        ? async () => {
                            await setWorkflowStep('prompt.build', 'waiting_client', {
                                checkpoint: 'editRequest.lua',
                                reason: 'lua_edit_request',
                            })
                        }
                        : undefined,
                    onClientEmbeddingRequired: async embeddingModel => {
                        await setWorkflowStep('memory.hypav3', 'waiting_client', {
                            checkpoint: 'embedding.local',
                            embeddingModel,
                            reason: 'browser_local_embedding',
                        })
                    },
                },
            )
            if(sp.error){
                // Save new summary
                if (sp.memory) {
                    currentChat.hypaV3Data = sp.memory
                    DBState.db.characters[selectedChar].chats[selectedChat].hypaV3Data = currentChat.hypaV3Data
                }
                console.log(sp)
                throwError(sp.error)
                await setWorkflowStep('memory.hypav3', 'failed')
                await finishWorkflow('failed')
                return false
            }
            chats = sp.chats
            currentTokens = sp.currentTokens
            if(sp.deferredRemoteSelection && deferredHypaMemoryPrompt){
                revenantMainDependency = {
                    kind: 'hypav3-selection',
                    placeholder: deferredHypaMemoryPrompt,
                }
            }
            currentChat.hypaV3Data = sp.memory ?? currentChat.hypaV3Data
            DBState.db.characters[selectedChar].chats[selectedChat].hypaV3Data = currentChat.hypaV3Data

            currentChat = DBState.db.characters[selectedChar].chats[selectedChat];
            console.log("[Expected to be updated] chat's HypaV3Data: ", currentChat.hypaV3Data)
            stageTimings.stage2Duration = Date.now() - stageTimings.stage2Start
            if(!sp.deferredRemoteSelection) chatProcessStage.set(1)
            if(!sp.deferredRemoteSelection){
                await setWorkflowStep('memory.hypav3', 'completed', {
                    chatSequence: chats.map(chat => {
                        const inputIndex = hypaInputChats.findIndex(input =>
                            input === chat || (!!chat.memo && input.memo === chat.memo))
                        return inputIndex >= 0
                            ? { inputIndex, inputMemo: chat.memo }
                            : { chat: safeStructuredClone(chat) }
                    }),
                    currentTokens,
                })
            }
        }
    }
    else{
        stageTimings.stage1Duration = Date.now() - stageTimings.stage1Start
        while(currentTokens > maxContextTokens){
            if(chats.length <= 1){
                throwError(language.errors.toomuchtoken + "\n\nRequired Tokens: " + currentTokens)
                await finishWorkflow('failed')
                return false
            }

            currentTokens -= await tokenizer.tokenizeChat(chats[0])
            chats.splice(0, 1)
        }
    }

    let biases:[string,number][] = DBState.db.bias.concat(currentChar.bias).map((v) => {
        return [risuChatParser(v[0].replaceAll("\\n","\n").replaceAll("\\r","\r").replaceAll("\\\\","\\"), {chara: currentChar}),v[1]]
    })

    let memories:OpenAIChat[] = []



    if(!promptTemplate){
        unformated.lastChat.push(chats[chats.length - 1])
        chats.splice(chats.length - 1, 1)
    }

    unformated.chats = chats.map((v) => {
        if(v.memo !== 'supaMemory' && v.memo !== 'hypaMemory'){
            v.removable = true
        }
        else if(supaMemoryCardUsed){
            memories.push(v)
            return {
                role: 'system',
                content: '',
            } as OpenAIChat
        }
        else{
            v.content = `<Previous Conversation>${v.content}</Previous Conversation>`
        }
        return v
    }).filter(hasMessagePayload)

    for(const depthPrompt of depthPrompts){
        const chat:OpenAIChat = {
            role: depthPrompt.role,
            content: risuChatParser(resolvePosition(depthPrompt.prompt), {chara: currentChar})
        }
        const depth = depthPrompt.pos === 'depth' ? (depthPrompt.depth) : (unformated.chats.length - depthPrompt.depth)
        unformated.chats.splice(depth,0,chat)
    }

    if(triggerAdditionalSysPrompt){
        if(triggerAdditionalSysPrompt.promptend){
            unformated.postEverything.push({
                role: 'system',
                content: triggerAdditionalSysPrompt.promptend
            })
        }
        if(triggerAdditionalSysPrompt.historyend){
            unformated.lastChat.push({
                role: 'system',
                content: triggerAdditionalSysPrompt.historyend
            })
        }
        if(triggerAdditionalSysPrompt.start){
            unformated.lastChat.unshift({
                role: 'system',
                content: triggerAdditionalSysPrompt.start
            })
        }
    }

    
    //make into one

    let formated:OpenAIChat[] = []
    const formatOrder = safeStructuredClone(DBState.db.formatingOrder)
    if(formatOrder){
        formatOrder.push('postEverything')
    }

    //continue chat model
    if(isContinuation && mergesAdjacentSystemPrompts){
        unformated.postEverything.push({
            role: 'system',
            content: '[Continue the last response]'
        })
    }

    function pushPrompts(cha:OpenAIChat[]){
        for(const chat of cha){
            // Drop payload-less turns before system merging and cache-depth
            // accounting; the shared request boundary repeats this after all
            // prompt/trigger transforms as a final safety net.
            if(!hasMessagePayload(chat)){
                continue
            }
            if(!mergesAdjacentSystemPrompts){
                formated.push(chat)
                continue
            }
            if(chat.role === 'system'){
                const endf = formated.at(-1)
                if(endf && endf.role === 'system' && endf.memo === chat.memo && endf.name === chat.name){
                    formated[formated.length - 1].content += '\n\n' + chat.content
                }
                else{
                    formated.push(chat)
                }
                formated.at(-1).content += ''
            }
            else{
                formated.push(chat)
            }
        }
    }

    let promptBodyformatedForChatStore: OpenAIChat[] = []
    function pushPromptInfoBody(role: "function" | "system" | "user" | "assistant", fmt: string, promptBody: OpenAIChat[]) {
        if(!fmt.trim()){
            return
        }
        promptBody.push({
            role: role,
            content: risuChatParser(fmt),
        })
    }

    if(promptTemplate){
        const template = promptTemplate

        for(const card of template){
            switch(card.type){
                case 'persona':{
                    let pmt = safeStructuredClone(unformated.personaPrompt)
                    applyPromptBlockRole(pmt, card.role)
                    for(let i=0;i<pmt.length;i++){
                        pmt[i].content = resolvePositionCBS(pmt[i].content)
                    }
                    if(card.innerFormat && pmt.length > 0){
                        for(let i=0;i<pmt.length;i++){
                            pmt[i].content = risuChatParser(positionParser(card.innerFormat,card.type), {chara: currentChar}).replace('{{slot}}', pmt[i].content)

                            if(DBState.db.promptInfoInsideChat && DBState.db.promptTextInfoInsideChat){
                                pushPromptInfoBody(pmt[i].role, card.innerFormat, promptBodyformatedForChatStore)
                            }
                        }
                    }

                    pushPrompts(pmt)
                    break
                }
                case 'description':{
                    let pmt = getDescriptionPrompts(card.role)
                    for(let i=0;i<pmt.length;i++){
                        pmt[i].content = resolvePositionCBS(pmt[i].content)
                    }
                    if(card.innerFormat && pmt.length > 0){
                        for(let i=0;i<pmt.length;i++){
                            pmt[i].content = risuChatParser(positionParser(card.innerFormat,card.type), {chara: currentChar}).replace('{{slot}}', pmt[i].content)
                            
                            if(DBState.db.promptInfoInsideChat && DBState.db.promptTextInfoInsideChat){
                                pushPromptInfoBody(pmt[i].role, card.innerFormat, promptBodyformatedForChatStore)
                            }
                        }
                    }

                    pushPrompts(pmt)
                    break
                }
                case 'authornote':{
                    let pmt = safeStructuredClone(unformated.authorNote)
                    applyPromptBlockRole(pmt, card.role)
                    if(card.innerFormat && pmt.length > 0){
                        for(let i=0;i<pmt.length;i++){
                            pmt[i].content = risuChatParser(positionParser(card.innerFormat,card.type), {chara: currentChar}).replace('{{slot}}', pmt[i].content || card.defaultText || '')
                            
                            if(DBState.db.promptInfoInsideChat && DBState.db.promptTextInfoInsideChat){
                                pushPromptInfoBody(pmt[i].role, card.innerFormat, promptBodyformatedForChatStore)
                            }
                        }
                    }

                    pushPrompts(pmt)
                    break
                }
                case 'lorebook':{
                    pushPrompts(getLorebookPrompts(card.role))
                    break
                }
                case 'postEverything':{
                    pushPrompts(unformated.postEverything)
                    if(usingPromptTemplate && DBState.db.promptSettings.postEndInnerFormat){
                        pushPrompts([{
                            role: 'system',
                            content: DBState.db.promptSettings.postEndInnerFormat
                        }])
                    }
                    break
                }
                case 'plain':
                case 'jailbreak':
                case 'cot':{
                    if((!DBState.db.jailbreakToggle) && (card.type === 'jailbreak')){
                        continue
                    }
                    if((!DBState.db.chainOfThought) && (card.type === 'cot')){
                        continue
                    }

                    const posType = card.type === 'plain' ? card.type2 : card.type
                    let content = positionParser(card.text, posType)

                    if(card.type2 === 'globalNote'){
                        if(currentChar.replaceGlobalNote){
                            content = positionParser(currentChar.replaceGlobalNote, posType).replaceAll('{{original}}', content)
                        }
                        if(currentChar.prebuiltAssetCommand && !card.text.includes('{{//@customimageinstruction}}')){
                            content += prebuiltAssetCommand
                        }
                        content = (risuChatParser(content, {chara: currentChar, role: card.role}))
                    }
                    else if(card.type2 === 'main'){
                        content = (risuChatParser(content, {chara: currentChar, role: card.role}))
                    }
                    else{
                        content = risuChatParser(content, {chara: currentChar, role: card.role})
                    }

                    const prompt:OpenAIChat ={
                        role: convertPromptRole[card.role],
                        content: content
                    }

                    if(DBState.db.promptInfoInsideChat && DBState.db.promptTextInfoInsideChat && card.type2 !== 'globalNote'){
                        pushPromptInfoBody(prompt.role, prompt.content, promptBodyformatedForChatStore)
                    }

                    pushPrompts([prompt])
                    break
                }
                case 'chatML':{
                    let prompts = parseChatML(card.text)
                    pushPrompts(prompts)
                    break
                }
                case 'chat':{
                    let start = card.rangeStart
                    let end = (card.rangeEnd === 'end') ? unformated.chats.length : card.rangeEnd
                    if(start === -1000){
                        start = 0
                        end = unformated.chats.length
                    }
                    if(start < 0){
                        start = unformated.chats.length + start
                        if(start < 0){
                            start = 0
                        }
                    }
                    if(end < 0){
                        end = unformated.chats.length + end
                        if(end < 0){
                            end = 0
                        }
                    }
                    
                    if(start >= end){
                        break
                    }

                    let chats = unformated.chats.slice(start, end)
                    if(usingPromptTemplate && DBState.db.promptSettings.sendChatAsSystem && (!card.chatAsOriginalOnSystem)){
                        chats = systemizeChat(chats)
                    }
                    pushPrompts(chats)

                    if(DBState.db.automaticCachePoint && !hasCachePoint){
                        let pointer = formated.length - 1
                        let depthRemaining = 3
                        while(pointer >= 0){
                            if(depthRemaining === 0){
                                break
                            }
                            if(formated[pointer].role === 'user'){
                                formated[pointer].cachePoint = true
                                depthRemaining--
                            }
                            pointer--
                        }
                    }
                    break
                }
                case 'memory':{
                    let pmt = safeStructuredClone(memories)
                    applyPromptBlockRole(pmt, card.role)
                    if(card.innerFormat && pmt.length > 0){
                        for(let i=0;i<pmt.length;i++){
                            pmt[i].content = risuChatParser(card.innerFormat, {chara: currentChar}).replace('{{slot}}', pmt[i].content)

                            if(DBState.db.promptInfoInsideChat && DBState.db.promptTextInfoInsideChat){
                                pushPromptInfoBody(pmt[i].role, card.innerFormat, promptBodyformatedForChatStore)
                            }
                        }
                    }

                    pushPrompts(pmt)
                    break
                }
                case 'cache':{
                    let pointer = formated.length - 1
                    let depthRemaining = card.depth
                    while(pointer >= 0){
                        if(depthRemaining === 0){
                            break
                        }
                        if(formated[pointer].role === card.role || card.role === 'all'){
                            formated[pointer].cachePoint = true
                            depthRemaining--
                        }
                        pointer--
                    }
                    break
                }
            }
        }
    }
    else{
        for(let i=0;i<formatOrder.length;i++){
            const cha = unformated[formatOrder[i]]
            pushPrompts(cha)
        }
    }


    formated = formated.map((v) => {
        v.content = v.content.trim()
        return v
    })

    if(DBState.db.promptInfoInsideChat && DBState.db.promptTextInfoInsideChat){
        promptBodyformatedForChatStore = promptBodyformatedForChatStore.map((v) => {
            v.content = v.content.trim()
            return v
        })
    }


    if(currentChar.depth_prompt && currentChar.depth_prompt.prompt && currentChar.depth_prompt.prompt.length > 0){
        //depth_prompt
        const depthPrompt = currentChar.depth_prompt
        formated.splice(formated.length - depthPrompt.depth, 0, {
            role: 'system',
            content: risuChatParser(depthPrompt.prompt, {chara: currentChar})
        })
    }

    formated = await runLuaEditTrigger(currentChar, 'editRequest', formated)

    if(DBState.db.promptInfoInsideChat && DBState.db.promptTextInfoInsideChat){
        promptBodyformatedForChatStore = await runLuaEditTrigger(currentChar, 'editRequest', promptBodyformatedForChatStore)
        promptInfo.promptText = promptBodyformatedForChatStore
    }

    //token rechecking
    let inputTokens = 0

    for(const chat of formated){
        inputTokens += await tokenizer.tokenizeChat(chat)
    }

    if(inputTokens > maxContextTokens){
        let pointer = 0
        while(inputTokens > maxContextTokens){
            if(pointer >= formated.length){
                throwError(language.errors.toomuchtoken + "\n\nAt token rechecking. Required Tokens: " + inputTokens)
                await finishWorkflow('failed')
                return false
            }
            if(formated[pointer].removable){
                inputTokens -= await tokenizer.tokenizeChat(formated[pointer])
                formated[pointer].content = ''
            }
            pointer++
        }
        formated = formated.filter(hasMessagePayload)
    }

    //estimate tokens
    let outputTokens = maxResponseTokens
    if(inputTokens + outputTokens > maxContextTokens){
        outputTokens = maxContextTokens - inputTokens
    }
    const generationModel = getGenerationModelString()

    generationInfo = {
        model: generationModel,
        generationId: messageChatId,
        inputTokens: inputTokens,
        outputTokens: outputTokens,
        maxContext: maxContextTokens,
        stageTiming: {
            stage1: stageTimings.stage1Duration,
            stage2: stageTimings.stage2Duration,
            stage3: 0,
            stage4: 0
        }
    }

    if(!revenantMainDependency) chatProcessStage.set(3)
    stageTimings.stage3Start = Date.now()
    if(arg.preview){
        previewFormated = formated
        return true
    }

    await setWorkflowStep('prompt.build', 'completed')

    if (
        !resumeWorkflow
        && !arg.previewPrompt
        && compiledMainPreset
    ) {
        try {
            if(!outgoingChat.id){
                throw new Error('Cannot start generation because the chat has no id.')
            }
            const snapshotAuxProvider = (mode:'submodel'|'emotion'|'otherAx') => {
                const binding = resolveChatModelBinding(currentChat, mode)
                if(binding.kind !== 'modelPreset') return undefined
                const compiled = compileModelPreset(binding.preset, {
                    jsonSchemaRequested: false,
                })
                return {
                    backend: compiled.backend,
                    modelPreset: safeStructuredClone(compiled.sourcePreset),
                }
            }
            const resumeContext:RevenantWorkflowResumeContext = {
                version: 1,
                chatProcessIndex,
                messageChatId,
                continue: isContinuation,
                rerollSnapshot,
            }
            const postprocessCharacter = safeStructuredClone(nowChatroom)
            postprocessCharacter.chats = [safeStructuredClone(currentChat)]
            postprocessCharacter.chatPage = 0
            const workflowContext:RevenantChatWorkflowContext = {
                schemaVersion: 1,
                kind: 'chat-generation',
                resume: {
                    schemaVersion: 1,
                    chatProcessIndex,
                    messageChatId,
                    isContinuation,
                    rerollSnapshot,
                },
                postprocess: {
                    schemaVersion: 1,
                    messageChatId,
                    isContinuation,
                    rerollSnapshot,
                    providerBackend: compiledMainPreset.backend,
                    modelPreset: safeStructuredClone(compiledMainPreset.sourcePreset),
                    auxProviders: {
                        submodel: snapshotAuxProvider('submodel'),
                        emotion: snapshotAuxProvider('emotion'),
                        otherAx: snapshotAuxProvider('otherAx'),
                    },
                    character: postprocessCharacter,
                    chat: safeStructuredClone(currentChat),
                    database: {
                        presetRegex: safeStructuredClone(DBState.db.presetRegex ?? []),
                        templateDefaultVariables: DBState.db.templateDefaultVariables ?? '',
                        globalChatVariables: safeStructuredClone(DBState.db.globalChatVariables ?? {}),
                        username: DBState.db.username ?? 'User',
                        userIcon: DBState.db.userIcon ?? '',
                        personaPrompt: DBState.db.personaPrompt ?? '',
                        selectedPersona: DBState.db.selectedPersona ?? 0,
                        personas: safeStructuredClone(DBState.db.personas ?? []),
                        dynamicAssets: DBState.db.dynamicAssets ?? false,
                        dynamicAssetsEditDisplay: DBState.db.dynamicAssetsEditDisplay ?? false,
                        igpPrompt: DBState.db.igpPrompt ?? '',
                        notification: DBState.db.notification ?? false,
                        ttsEnabled: DBState.db.ttsEnabled ?? false,
                        ttsAutoSpeech: DBState.db.ttsAutoSpeech ?? false,
                        emotionProcesser: DBState.db.emotionProcesser ?? 'submodel',
                        emotionPrompt2: DBState.db.emotionPrompt2 ?? '',
                    },
                    modules: safeStructuredClone(getModules()),
                    moduleRegexScripts: safeStructuredClone(getModuleRegexScripts()),
                    moduleTriggers: safeStructuredClone(getModuleTriggers()),
                },
            }
            const plan = completeChatGenerationPreModelPlan(createChatGenerationWorkflowPlan({
                resumeContext,
                persistUserMessage: outgoingMessage?.role === 'user',
                hypaEnabled,
                igpEnabled: !!(DBState.db.igpPrompt ?? '').trim(),
                // Main provider dispatch remains on the page that built the
                // prompt. Plugin transports register their durable nativeFetch
                // job through the same ordinary request path as HTTP adapters.
                pluginProvider: false,
            }))
            const workflow = await beginRevenantWorkflow({
                characterId: nowChatroom.chaId,
                roomId: outgoingChat.id,
                context: workflowContext,
                plan,
            })
            revenantWorkflowId = workflow.workflowId
        }
        catch(error){
            const message = error instanceof RevenantWorkflowBusyError
                ? 'This room already has a generation waiting to finish or recover.'
                : error instanceof Error ? error.message : String(error)
            alertError(message)
            doingChat.set(false)
            return false
        }
    }

    if (!arg.previewPrompt) {
        const generationChat = DBState.db.characters[selectedChar].chats[selectedChat]
        ensureGenerationMessageTarget(generationChat, {
            messageChatId,
            characterId: currentChar.chaId,
            isContinuation,
            generationInfo,
            promptInfo,
            rerollSnapshot,
        })

        generationChat.isStreaming = true
        currentChar.reloadKeys += 1
    }

    registerRevenantGenerationMetadata(messageChatId, {
        generationInfo,
        promptInfo,
        rerollSnapshot,
    })

    const requestMainGeneration = (lifecycle: RevenantGenerationLifecycle = {}) =>
        requestChatData({
            formated: formated,
            biasString: biases,
            currentChar: currentChar,
            useStreaming: true,
            isGroupChat: false,
            bias: {},
            continue: isContinuation,
            chatId: messageChatId,
            imageResponse: DBState.db.outputImageModal,
            previewBody: arg.previewPrompt,
            escape: nowChatroom.type === 'character' && nowChatroom.escapeOutput,
            rememberToolUsage: DBState.db.rememberToolUsage,
            revenantWorkflowDependency: revenantMainDependency,
            revenantRoomId: outgoingChat.id,
            revenantContinuationPrefix: continuationFallback,
            onRevenantJobCreated: jobId => {
                revenantMainJobCreated = true
                revenantMainJobId = jobId
                lifecycle.onJobCreated?.(jobId)
            },
            onRevenantJobRegistrationUnavailable: error => {
                revenantMainRegistrationError = error
                lifecycle.onJobRegistrationUnavailable?.(error)
            },
            onRevenantProviderStarted: lifecycle.onProviderStarted,
        }, 'model', abortSignal)
    let req:Awaited<ReturnType<typeof requestMainGeneration>>
    try {
        req = await (async () => {
            if(!revenantWorkflowId) return requestMainGeneration()
            const mainGeneration = coordinateRevenantGeneration(
                requestMainGeneration,
                {
                    // HTTP adapters return a ReadableStream before their lazy async
                    // generator reaches fetchNative. Keep registration open for
                    // that known transport. Plugin providers must register before
                    // returning so a stream-only provider still fails promptly.
                    resultKeepsRegistrationOpen: result =>
                        result.type === 'streaming' && revenantMainBackend === 'http',
                    onProviderStarted: revenantMainDependency
                        ? () => chatProcessStage.set(3)
                        : undefined,
                },
            )
            // The result promise is already running. Waiting on registration first
            // makes the client/server ownership boundary explicit: once a job id
            // exists, the server can finish Hypa and dispatch main independently.
            await mainGeneration.registered
            return mainGeneration.result
        })()
    }
    catch(error) {
        const message = error instanceof Error ? error.message : String(error)
        throwError(message)
        preserveFailedGenerationMessage('')
        finishStreamingDisplay()
        await setWorkflowStep('model.main', 'failed')
        await finishWorkflow('failed')
        doingChat.set(false)
        return false
    }

    // Read through a function so TypeScript does not treat AbortSignal.aborted
    // as permanently false across the async Hypa wait below.
    const generationWasAborted = () => abortSignal.aborted
    if(generationWasAborted()){
        finishStreamingDisplay()
        preserveFailedGenerationMessage()
        await finishWorkflow('cancelled')
        return false
    }
    if(req.type === 'fail'){
        finishStreamingDisplay()
        throwError(req.result)
        preserveFailedGenerationMessage('')
        await setWorkflowStep('model.main', 'failed')
        await finishWorkflow('failed')
        return false
    }

    if(revenantWorkflowId && !revenantMainJobCreated){
        const message = revenantMainRegistrationError instanceof Error
            ? revenantMainRegistrationError.message
            : 'The configured chat provider completed without dispatching a durable model request. The provider must use the shared LLM transport; plugin providers must issue the model request through nativeFetch or risuFetch.'
        finishStreamingDisplay()
        throwError(message)
        preserveFailedGenerationMessage('')
        await setWorkflowStep('model.main', 'failed')
        await finishWorkflow('failed')
        return false
    }

    if(arg.detachSignal?.aborted && req.type !== 'streaming'){
        finishGenerationDetachment()
        return false
    }

    if(revenantMainDependency && revenantWorkflowId){
        const remoteSelection = await waitForRevenantHypaExecution<{
            memory: SerializableHypaV3Data
        }>(revenantWorkflowId, abortSignal)
        currentChat = DBState.db.characters[selectedChar].chats[selectedChat]
        currentChat.hypaV3Data = safeStructuredClone(remoteSelection.memory)
        DBState.db.characters[selectedChar].chats[selectedChat].hypaV3Data = currentChat.hypaV3Data
    }

    console.log(req)
    if(req.model){
        generationInfo.model = getGenerationModelString(req.model)
        console.log(generationInfo.model, req.model)
    }
    try {
        await updateRevenantGenerationMetadata(messageChatId, {
            generationInfo,
            promptInfo,
            rerollSnapshot,
        })
    } catch (error) {
        console.error('[GenerationJob] Failed to update generation metadata:', error)
    }

    if(arg.previewPrompt && req.type === 'success'){
        previewBody = req.result
        return true
    }

    let result = ''
    let rawResult = ''
    let emoChanged = false
    let resendChat = false

    async function finishSuccessfulWorkflow():Promise<true>{
        return true
    }

    if(abortSignal.aborted === true){
        finishStreamingDisplay()
        preserveFailedGenerationMessage()
        await finishWorkflow('cancelled')
        return false
    }
    if(req.type === 'streaming'){
        const reader = req.result.getReader()
        const initialTarget = ensureLiveGenerationTarget()
        if (!initialTarget) {
            void reader.cancel().catch(() => {})
            throw new Error('Generation chat is no longer available')
        }
        let prefix = ''
        if(isContinuation){
            prefix = initialTarget.message.data
        }
        initialTarget.chat.isStreaming = true
        initialTarget.character.reloadKeys += 1
        let lastResponseChunk:{[key:string]:string} = {}
        let streamAborted:boolean = abortSignal.aborted
        let streamDetached:boolean = arg.detachSignal?.aborted === true
        let streamFailure:unknown
        const abortReader = () => {
            streamAborted = true
            void cancelRevenantGeneration(messageChatId).catch(error => {
                console.error('[GenerationJob] Failed to cancel server generation:', error)
            })
            void reader.cancel().catch(() => {})
        }
        const detachReader = () => {
            streamDetached = true
            if(revenantMainJobId){
                setRevenantGenerationLocallyObserved(revenantMainJobId, false)
            }
            void reader.cancel().catch(() => {})
        }
        abortSignal.addEventListener('abort', abortReader, { once: true })
        arg.detachSignal?.addEventListener('abort', detachReader, { once: true })
        if(streamDetached) detachReader()
        try {
            while(streamAborted === false && streamDetached === false){
                let readed: ReadableStreamReadResult<{ [key: string]: string }>
                try {
                    readed = await reader.read()
                }
                catch(error){
                    if(abortSignal.aborted || streamAborted){
                        streamAborted = true
                        break
                    }
                    streamFailure = error
                    break
                }
                if(readed.value){
                    lastResponseChunk = readed.value
                    const firstChunkKey = Object.keys(lastResponseChunk)[0]
                    result = lastResponseChunk[firstChunkKey]
                    if(!result){
                        result = ''
                    }
                    rawResult = prefix + result
                    void checkpointRevenantGeneration(messageChatId, rawResult).catch(error => {
                        console.error('[GenerationJob] Failed to checkpoint parsed response:', error)
                    })
                    const liveTarget = ensureLiveGenerationTarget()
                    if(!liveTarget){
                        streamFailure = new Error('Generation chat is no longer available')
                        break
                    }
                    if(revenantWorkflowId){
                        setGenerationMessageContent(
                            liveTarget.message,
                            reformatContent(prefix + result),
                        )
                    }
                    else{
                        const result2 = await processScriptFull(liveTarget.character, reformatContent(prefix + result), 'editoutput', liveTarget.index)
                        const refreshedTarget = ensureLiveGenerationTarget()
                        if(!refreshedTarget){
                            streamFailure = new Error('Generation chat is no longer available')
                            break
                        }
                        setGenerationMessageContent(refreshedTarget.message, result2.data)
                        emoChanged = result2.emoChanged
                    }
                    liveTarget.character.reloadKeys += 1
                }
                if(readed.done){
                    break
                }
            }
        }
        finally {
            if (result) {
                const checkpoint = checkpointRevenantGeneration(
                    messageChatId,
                    rawResult || prefix + result,
                    true,
                )
                if(streamDetached){
                    void checkpoint.catch(error => {
                        console.error('[GenerationJob] Failed to flush detached response:', error)
                    })
                }
                else{
                    try {
                        await checkpoint
                    } catch (error) {
                        console.error('[GenerationJob] Failed to flush parsed response:', error)
                    }
                }
            }
            abortSignal.removeEventListener('abort', abortReader)
            arg.detachSignal?.removeEventListener('abort', detachReader)
            if(!streamDetached) finishStreamingDisplay()
            void reader.cancel().catch(() => {})
        }

        if(streamDetached){
            finishGenerationDetachment()
            return false
        }
        if(streamAborted || abortSignal.aborted){
            preserveFailedGenerationMessage(rawResult || undefined)
            await finishWorkflow('cancelled')
            return false
        }
        if(streamFailure){
            const message = streamFailure instanceof Error
                ? streamFailure.message
                : String(streamFailure)
            throwError(message)
            preserveFailedGenerationMessage(rawResult || '')
            await setWorkflowStep('model.main', 'failed')
            await finishWorkflow('failed')
            return false
        }

        if(revenantWorkflowId){
            return await waitForServerWorkflow(revenantWorkflowId)
        }

        const completedTarget = ensureLiveGenerationTarget()
        if(!completedTarget){
            throw new Error('Generation chat is no longer available')
        }
        currentChat = runCurrentChatFunction(completedTarget.chat)
        const completedChatIndex = completedTarget.character.chats.findIndex(chat =>
            chat?.id === outgoingChat.id)
        completedTarget.character.chats[completedChatIndex] = currentChat
        await setWorkflowStep('trigger.output', 'running')
        const triggerResult = await runTrigger(currentChar, 'output', {chat:currentChat})
        if(triggerResult && triggerResult.chat){
            currentChat = normalizeChat(triggerResult.chat)
            const liveCharacter = DBState.db.characters.find(character =>
                character?.chaId === nowChatroom.chaId)
            const liveChatIndex = liveCharacter?.chats.findIndex(chat =>
                chat?.id === outgoingChat.id) ?? -1
            if(liveCharacter && liveChatIndex >= 0){
                liveCharacter.chats[liveChatIndex] = currentChat
            }
        }
        if(triggerResult && triggerResult.sendAIprompt){
            resendChat = true
        }
        const inlayTarget = ensureLiveGenerationTarget()
        if(!inlayTarget){
            throw new Error('Generation chat is no longer available')
        }
        const inlayr = runInlayScreen(currentChar, inlayTarget.message.data)
        inlayTarget.message.data = inlayr.text
        if(inlayr.promise){
            const t = await inlayr.promise
            const refreshedInlayTarget = ensureLiveGenerationTarget()
            if(!refreshedInlayTarget){
                throw new Error('Generation chat is no longer available')
            }
            refreshedInlayTarget.message.data = t
        }
        if(DBState.db.ttsEnabled && DBState.db.ttsAutoSpeech){
            await sayTTS(currentChar, result)
        }
    }
    else{
        if(revenantWorkflowId){
            rawResult = req.type === 'success'
                ? req.result
                : req.type === 'multiline'
                    ? req.result.map(message => message[1]).join('\n')
                    : ''
            result = rawResult
            return await waitForServerWorkflow(revenantWorkflowId)
        }
        const msgs = (req.type === 'success') ? [['char',req.result]] as const 
                    : (req.type === 'multiline') ? req.result
                    : []
        let mrerolls:string[] = []
        for(let i=0;i<msgs.length;i++){
            let msg = msgs[i]
            let mess = msg[1]
            if (i === 0) rawResult = mess
            let msgIndex = i === 0
                ? ensureLiveGenerationTarget()?.index ?? -1
                : DBState.db.characters[selectedChar].chats[selectedChat].message.length
            if (i === 0 && msgIndex < 0) {
                throw new Error('Persisted generation placeholder is missing')
            }
            let result2 = await processScriptFull(nowChatroom, reformatContent(mess), 'editoutput', msgIndex)
            if(i === 0 && isContinuation){
                let beforeChat = ensureLiveGenerationTarget()?.message
                if(!beforeChat) throw new Error('Generation continuation target is missing')
                result2 = await processScriptFull(nowChatroom, reformatContent(beforeChat.data + mess), 'editoutput', msgIndex)
            }
            result = result2.data
            const inlayResult = runInlayScreen(currentChar, result)
            result = inlayResult.text
            emoChanged = result2.emoChanged
            if(i === 0 && isContinuation){
                const committedTarget = ensureLiveGenerationTarget()
                if(!committedTarget) throw new Error('Generation continuation target is missing')
                Object.assign(committedTarget.message, {
                    role: 'char' as const,
                    saying: currentChar.chaId,
                    time: Date.now(),
                    generationInfo,
                    promptInfo,
                    chatId: messageChatId,
                })
                setGenerationMessageContent(committedTarget.message, result)
                if(inlayResult.promise){
                    const p = await inlayResult.promise
                    const refreshedTarget = ensureLiveGenerationTarget()
                    if(!refreshedTarget) throw new Error('Generation continuation target is missing')
                    setGenerationMessageContent(refreshedTarget.message, p)
                }
            }
            else if(i===0){
                const committedTarget = ensureLiveGenerationTarget()
                if(!committedTarget) throw new Error('Generation target is missing')
                Object.assign(committedTarget.message, {
                    role: msg[0],
                    saying: currentChar.chaId,
                    time: Date.now(),
                    generationInfo,
                    promptInfo,
                    chatId: messageChatId,
                })
                setGenerationMessageContent(committedTarget.message, result)
                if(inlayResult.promise){
                    const p = await inlayResult.promise
                    const refreshedTarget = ensureLiveGenerationTarget()
                    if(!refreshedTarget) throw new Error('Generation target is missing')
                    setGenerationMessageContent(refreshedTarget.message, p)
                }
                mrerolls.push(result)
            }
            else{
                mrerolls.push(result)
            }
            DBState.db.characters[selectedChar].reloadKeys += 1
            if(DBState.db.ttsEnabled && DBState.db.ttsAutoSpeech){
                await sayTTS(currentChar, result)
            }
        }

        DBState.db.characters[selectedChar].chats[selectedChat] = runCurrentChatFunction(DBState.db.characters[selectedChar].chats[selectedChat])
        currentChat = DBState.db.characters[selectedChar].chats[selectedChat]        

        await setWorkflowStep('trigger.output', 'running')
        const triggerResult = await runTrigger(currentChar, 'output', {chat:currentChat})
        if(triggerResult && triggerResult.chat){
            DBState.db.characters[selectedChar].chats[selectedChat] = normalizeChat(triggerResult.chat)
        }
        if(triggerResult && triggerResult.sendAIprompt){
            resendChat = true
        }
    }
    await setWorkflowStep('output.transform', 'completed')
    await setWorkflowStep('trigger.output', 'completed')
    finishStreamingDisplay()

    const igp = risuChatParser(DBState.db.igpPrompt ?? "")

    if(igp){
        await setWorkflowStep('igp', 'running')
        const igpFormated = parseChatML(igp)
        const rq = await requestChatData({
            formated: igpFormated,
            bias: {},
            currentChar,
            useStreaming: false,
        },'emotion', abortSignal)

        if(rq.type === 'success'){
            DBState.db.characters[selectedChar].chats[selectedChat].message[DBState.db.characters[selectedChar].chats[selectedChat].message.length - 1].data += rq.result
            await setWorkflowStep('igp', 'completed')
        }
        else{
            const reason = rq.type === 'fail' ? rq.result : `unexpected_${rq.type}`
            console.error('[GenerationWorkflow] IGP request failed:', reason)
            await setWorkflowStep('igp', 'skipped', { reason })
        }
    }

    stageTimings.stage3Duration = Date.now() - stageTimings.stage3Start

    if(generationInfo.stageTiming) {
        generationInfo.stageTiming.stage3 = stageTimings.stage3Duration
    }
    chatProcessStage.set(4)
    stageTimings.stage4Start = Date.now()
    await setWorkflowStep('postprocess', 'running')

    if(resendChat){
        stageTimings.stage4Duration = Date.now() - stageTimings.stage4Start
        
        if(generationInfo.stageTiming) {
            generationInfo.stageTiming.stage1 = stageTimings.stage1Duration
            generationInfo.stageTiming.stage2 = stageTimings.stage2Duration
            generationInfo.stageTiming.stage3 = stageTimings.stage3Duration
            generationInfo.stageTiming.stage4 = stageTimings.stage4Duration
        }
        
        const lastMessageIndex = DBState.db.characters[selectedChar].chats[selectedChat].message.length - 1
        if(lastMessageIndex >= 0 && DBState.db.characters[selectedChar].chats[selectedChat].message[lastMessageIndex].generationInfo) {
            DBState.db.characters[selectedChar].chats[selectedChat].message[lastMessageIndex].generationInfo = generationInfo
        }
        
        doingChat.set(false)
        await finishSuccessfulWorkflow()
        return await sendChat(chatProcessIndex, {
            signal: abortSignal,
            detachSignal: arg.detachSignal,
            onDetached: arg.onDetached,
            generationTarget: arg.generationTarget,
        })
    }

    if(DBState.db.notification){
        try {
            const permission = await Notification.requestPermission()
            if(permission === 'granted'){
                const noti = new Notification('Risuai', {
                    body: result
                })
                noti.onclick = () => {
                    window.focus()
                }
            }
        } catch (error) {
            
        }
    }

    if(req.special){
        if(req.special.emotion){
            let charemotions = get(CharEmotion)
            let currentEmotion = currentChar.emotionImages

            let tempEmotion = charemotions[currentChar.chaId]
            if(!tempEmotion){
                tempEmotion = []
            }
            if(tempEmotion.length > 4){
                tempEmotion.splice(0, 1)
            }

            for(const emo of currentEmotion){
                if(emo[0] === req.special.emotion){
                    const emos:[string, string,number] = [emo[0], emo[1], Date.now()]
                    tempEmotion.push(emos)
                    charemotions[currentChar.chaId] = tempEmotion
                    CharEmotion.set(charemotions)
                    emoChanged = true
                    break
                }
            }
        }
    }

    if(!currentChar.inlayViewScreen){
        if(currentChar.viewScreen === 'emotion' && (!emoChanged) && (abortSignal.aborted === false)){

            let currentEmotion = currentChar.emotionImages
            let emotionList = currentEmotion.map((a) => {
                return a[0]
            })
            let charemotions = get(CharEmotion)

            let tempEmotion = charemotions[currentChar.chaId]
            if(!tempEmotion){
                tempEmotion = []
            }
            if(tempEmotion.length > 4){
                tempEmotion.splice(0, 1)
            }

            if(DBState.db.emotionProcesser === 'embedding'){
                const hypaProcesser = new HypaProcesser()
                await hypaProcesser.addText(emotionList.map((v) => 'emotion:' + v))
                let searched = (await hypaProcesser.similaritySearchScored(result)).map((v) => {
                    v[0] = v[0].replace("emotion:",'')
                    return v
                })

                //give panaltys
                for(let i =0;i<tempEmotion.length;i++){
                    const emo = tempEmotion[i]
                    //give panalty index
                    const index = searched.findIndex((v) => {
                        return v[0] === emo[0]
                    })

                    const modifier = ((5 - ((tempEmotion.length - (i + 1))))) / 200

                    if(index !== -1){
                        searched[index][1] -= modifier
                    }
                }

                //make a sorted array by score
                const emoresult = searched.sort((a,b) => {
                    return b[1] - a[1]
                }).map((v) => {
                    return v[0]
                })

                for(const emo of currentEmotion){
                    if(emo[0] === emoresult[0]){
                        const emos:[string, string,number] = [emo[0], emo[1], Date.now()]
                        tempEmotion.push(emos)
                        charemotions[currentChar.chaId] = tempEmotion
                        CharEmotion.set(charemotions)
                        break
                    }
                }

                

                return await finishSuccessfulWorkflow()
            }

            function shuffleArray(array:string[]) {
                for (let i = array.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [array[i], array[j]] = [array[j], array[i]];
                }
                return array
            }

            let emobias:{[key:number]:number} = {}

            for(const emo of emotionList){
                const tokens = await tokenizeNum(emo)
                for(const token of tokens){
                    emobias[token] = 10
                }
            }

            for(let i =0;i<tempEmotion.length;i++){
                const emo = tempEmotion[i]

                const tokens = await tokenizeNum(emo[0])
                const modifier = 20 - ((tempEmotion.length - (i + 1)) * (20/4))

                for(const token of tokens){
                    emobias[token] -= modifier
                    if(emobias[token] < -100){
                        emobias[token] = -100
                    }
                }
            }        

            const promptbody:OpenAIChat[] = [
                {
                    role:'system',
                    content: `${DBState.db.emotionPrompt2 || "From the list below, choose a word that best represents a character's outfit description, action, or emotion in their dialogue. Prioritize selecting words related to outfit first, then action, and lastly emotion. Print out the chosen word."}\n\n list: ${shuffleArray(emotionList).join(', ')} \noutput only one word.`
                },
                {
                    role: 'user',
                    content: `"Good morning, Master! Is there anything I can do for you today?"`
                },
                {
                    role: 'assistant',
                    content: 'happy'
                },
                {
                    role: 'user',
                    content: result
                },
            ]

            const rq = await requestChatData({
                formated: promptbody,
                bias: emobias,
                currentChar: currentChar,
                maxTokens: 30,
            }, 'emotion', abortSignal)

            if(rq.type === 'fail'){
                if(abortSignal.aborted){
                    return await finishSuccessfulWorkflow()
                }
                throwError(rq.result)
                return await finishSuccessfulWorkflow()
            }
            if(rq.type === 'streaming' || rq.type === 'multiline'){
                if(abortSignal.aborted){
                    return await finishSuccessfulWorkflow()
                }
                throwError('Unexpected response type')
                return await finishSuccessfulWorkflow()
            }
            else{
                emotionList = currentEmotion.map((a) => {
                    return a[0]
                })
                try {
                    const emotion:string = rq.result.replace(/ |\n/g,'').trim().toLocaleLowerCase()
                    let emotionSelected = false
                    for(const emo of currentEmotion){
                        if(emo[0] === emotion){
                            const emos:[string, string,number] = [emo[0], emo[1], Date.now()]
                            tempEmotion.push(emos)
                            charemotions[currentChar.chaId] = tempEmotion
                            CharEmotion.set(charemotions)
                            emotionSelected = true
                            break
                        }
                    }
                    if(!emotionSelected){
                        for(const emo of currentEmotion){
                            if(emotion.includes(emo[0])){
                                const emos:[string, string,number] = [emo[0], emo[1], Date.now()]
                                tempEmotion.push(emos)
                                charemotions[currentChar.chaId] = tempEmotion
                                CharEmotion.set(charemotions)
                                emotionSelected = true
                                break
                            }
                        }
                    }
                    if(!emotionSelected && emotionList.includes('neutral')){
                        const emo = currentEmotion[emotionList.indexOf('neutral')]
                        const emos:[string, string,number] = [emo[0], emo[1], Date.now()]
                        tempEmotion.push(emos)
                        charemotions[currentChar.chaId] = tempEmotion
                        CharEmotion.set(charemotions)
                        emotionSelected = true
                    }
                } catch (error) {
                    throwError(language.errors.httpError + `${error}`)
                    return await finishSuccessfulWorkflow()
                }
            }
            
            return await finishSuccessfulWorkflow()


        }
        else if(currentChar.viewScreen === 'imggen'){
            const msgs = DBState.db.characters[selectedChar].chats[selectedChat].message
            let msgStr = ''
            for(let i = (msgs.length - 1);i>=0;i--){
                if(msgs[i].role === 'char'){
                    msgStr = `character: ${msgs[i].data.replace(/\n/g, ' ')} \n` + msgStr
                }
                else{
                    msgStr = `user: ${msgs[i].data.replace(/\n/g, ' ')} \n` + msgStr
                    break
                }
            }


            await stableDiff(currentChar, msgStr)
        }
    }

    stageTimings.stage4Duration = Date.now() - stageTimings.stage4Start
    
    if(generationInfo.stageTiming) {
        generationInfo.stageTiming.stage1 = stageTimings.stage1Duration
        generationInfo.stageTiming.stage2 = stageTimings.stage2Duration
        generationInfo.stageTiming.stage3 = stageTimings.stage3Duration
        generationInfo.stageTiming.stage4 = stageTimings.stage4Duration
    }
    
    const lastMessageIndex = DBState.db.characters[selectedChar].chats[selectedChat].message.length - 1
    if(lastMessageIndex >= 0 && DBState.db.characters[selectedChar].chats[selectedChat].message[lastMessageIndex].generationInfo) {
        DBState.db.characters[selectedChar].chats[selectedChat].message[lastMessageIndex].generationInfo = generationInfo
    }

    return await finishSuccessfulWorkflow()
}

function systemizeChat(chat:OpenAIChat[]){
    for(let i=0;i<chat.length;i++){
        if(chat[i].role === 'user' || chat[i].role === 'assistant'){
            const attr = chat[i].attr ?? []
            if(chat[i].name?.startsWith('example_')){
                chat[i].content = chat[i].name + ': ' + chat[i].content
            }
            else if(!attr.includes('nameAdded')){
                chat[i].content = chat[i].role + ': ' + chat[i].content
            }
            chat[i].role = 'system'
            delete chat[i].memo
            delete chat[i].name
        }
    }
    return chat
}
