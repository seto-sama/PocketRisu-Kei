import { isDebugEnabled } from 'src/ts/debug'
import { asBuffer } from 'src/ts/util';
import { getChatVarOf, getGlobalChatVar, setChatVarOf } from "../parser/chatVar.svelte";
import { hasher, type simpleCharacterArgument, risuChatParser } from "../parser/parser.svelte";
import { LuaEngine, LuaFactory } from "wasmoon";
import { getCurrentCharacter, getCurrentChat, getDatabase, setDatabase, type Chat, type character, type triggerscript } from "../storage/database.svelte";
import { invalidateChatMessageRender, invalidateDisplay } from "../stores.svelte";
import { alertSelect, alertError, alertInput, alertNormal, alertConfirm, notifyError } from "../alert";
import { HypaProcesser } from "./memory/hypamemory";
import { generateImageThroughWorkflow } from "./revenant/workflow/imageWorkflow";
import { isImageOrientation, type ImageOrientation } from '../imageGeneration/orientation';
import { writeInlayImage, getInlayAsset } from "./files/inlays";
import type { OpenAIChat, MultiModal } from "./index.svelte";
import { requestChatData, type StreamResponseChunk } from "./request/request";
import { createEntityId } from 'src/ts/id';
import { getModuleLorebooks, getModuleTriggers } from "./modules";
import { tokenize } from "../tokenizer";
import {
    fetchNative,
    readImage,
} from "../globalApi.svelte";
import {
    consumeRecoverableAuxiliaryGeneration,
    findRecoverableAuxiliaryGeneration,
    listRecoverableAuxiliaryGenerations,
    resolveRecoverableAuxiliaryGenerations,
} from "./revenant/auxiliary";
import { loadLoreBookV3Prompt } from './lorebook.svelte';
import { getPersonaPrompt, getUserName, getUserIcon } from '../util';
import { commitTriggerChat } from './triggerOrigin';
import {
    createRevenantOperation,
    isRevenantJobActive,
    isRevenantLuaLlmOperation,
    type RecoverableAuxiliaryJob,
    type RevenantLuaLlmOperation,
} from './revenant';
import { wrapRevenantLua } from './revenant/postprocess';
import {
    invokeLuaMode,
    registerLuaCoreApis,
    registerLuaEffectApis,
    type LuaCoreAdapter,
    type LuaEffectAdapter,
    type LuaEffectApiName,
    luaMayListenForEditMode,
} from './luaCore';
import {
    extractLuaLlmInlays,
    luaLlmResult,
    luaLlmRequestIdentity,
    normalizeLuaLlmPrompt,
    parseLuaLlmOptions,
    resolveLuaAxLlmMode,
    type LuaAxLlmMode,
} from './luaLlmCore';
let luaFactory:LuaFactory
let ScriptingSafeIds = new Set<string>()
let ScriptingEditDisplayIds = new Set<string>()
let ScriptingLowLevelIds = new Set<string>()
let lastRequestResetTime = 0
let lastRequestsCount = 0

interface ScriptingEngineState {
    chat?: Chat;
    character?: character|simpleCharacterArgument;
    setVar?: (key:string, value:string) => void,
    getVar?: (key:string) => string,
    revenantLuaExecution?: RevenantLuaExecutionContext,
    luaCoreAdapter?: LuaCoreAdapter,
    luaEffectAdapter?: LuaEffectAdapter,
    luaEffectHandlers?: Partial<Record<LuaEffectApiName, (...args: any[]) => unknown>>,
    moduleId?: string,
    engine?: LuaEngine;
}

let luaFactoryPromise: Promise<void> | null = null;

type RevenantLuaExecutionContext = {
    executionKey: string;
    characterId: string;
    roomId: string;
    mode: string;
    code: string;
    lowLevelAccess: boolean;
    data?: string;
    meta?: object;
    moduleId?: string;
    anchorMessageId: string;
    callIndex: number;
    completedJobIds: Set<string>;
}

async function getLuaReplayJob(replayKey: string): Promise<RecoverableAuxiliaryJob | undefined> {
    return await findRecoverableAuxiliaryGeneration(job =>
        isRevenantLuaLlmOperation(job.operationContext)
        && job.operationContext.replayKey === replayKey)
}

export async function runScripted(code:string, arg:{
    char?:character|simpleCharacterArgument,
    chat?:Chat
    data?: string|OpenAIChat[],
    setVar?: (key:string, value:string) => void,
    getVar?: (key:string) => string,
    lowLevelAccess?: boolean,
    meta?: object,
    mode?: string,
    moduleId?: string
    revenantReplayJobIds?: string[]
}){
    const requestedCharacter = arg.char ?? getCurrentCharacter()
    const char = requestedCharacter.type === 'simple' && requestedCharacter.chaId
        ? getDatabase().characters.find(character => character.chaId === requestedCharacter.chaId) ?? requestedCharacter
        : requestedCharacter
    const data = arg.data ?? ''
    const chat = arg.chat ?? getCurrentChat()
    const setVar = arg.setVar ?? ((key, value) => setChatVarOf(chat, key, value))
    const getVar = arg.getVar ?? (key => getChatVarOf(chat, key, char.type === 'simple' ? '' : char.defaultVariables))
    const meta = arg.meta ?? {}
    const mode = arg.mode ?? 'manual'

    let stopSending = false
    let lowLevelAccess = arg.lowLevelAccess ?? false
    let revenantLuaExecution: RevenantLuaExecutionContext | undefined
    if (
        char.type === 'character'
        && char.chaId
        && chat?.id
        && lowLevelAccess
    ) {
        const lastMessage = chat.message?.at(-1)
        const anchorMessageId = lastMessage?.chatId
            ?? await hasher(new TextEncoder().encode(
                `${chat.message?.length ?? 0}:${lastMessage?.role ?? ''}:${lastMessage?.data ?? ''}`,
            ))
        const codeHash = await hasher(new TextEncoder().encode(code))
        const interactionInput = (mode === 'onButtonClick' || mode === 'onFormSubmit') && typeof data === 'string'
            ? { data, meta }
            : undefined
        const inputHash = interactionInput
            ? await hasher(new TextEncoder().encode(JSON.stringify([data, meta])))
            : undefined
        revenantLuaExecution = {
            executionKey: `${char.chaId}:${chat.id}:${mode}:${arg.moduleId ?? ''}:${anchorMessageId}:${codeHash}${inputHash ? `:${inputHash}` : ''}`,
            characterId: char.chaId,
            roomId: chat.id,
            mode,
            code,
            lowLevelAccess,
            ...interactionInput,
            moduleId: arg.moduleId,
            anchorMessageId,
            callIndex: 0,
            completedJobIds: new Set(arg.revenantReplayJobIds ?? []),
        }
    }

    await ensureLuaFactory()
    const ScriptingEngineState: ScriptingEngineState = {}
    
    try {
        ScriptingEngineState.moduleId = arg.moduleId
        ScriptingEngineState.chat = chat
        ScriptingEngineState.character = char
        ScriptingEngineState.setVar = setVar
        ScriptingEngineState.getVar = getVar
        ScriptingEngineState.revenantLuaExecution = revenantLuaExecution
        ScriptingEngineState.luaCoreAdapter = {
            canSetVariable: accessKey => (
                ScriptingSafeIds.has(accessKey) || ScriptingEditDisplayIds.has(accessKey)
            ),
            canMutate: accessKey => ScriptingSafeIds.has(accessKey),
            getChat: () => ScriptingEngineState.chat!,
            getCharacter: () => {
                const db = getDatabase()
                return db.characters.find(character => character.chaId === char.chaId) ?? (char as character)
            },
            getVar: key => ScriptingEngineState.getVar?.(key) ?? 'null',
            setVar: (key, value) => ScriptingEngineState.setVar?.(key, value),
            getGlobalVar: getGlobalChatVar,
            stop: () => { stopSending = true },
            render: value => risuChatParser(value, { chara: char.type === 'character' ? char : undefined }),
        }
        ScriptingEngineState.luaEffectAdapter = {
            canUseSafeApi: accessKey => ScriptingSafeIds.has(accessKey),
            canUseLowLevelApi: accessKey => ScriptingLowLevelIds.has(accessKey),
            invoke: (name, args) => ScriptingEngineState.luaEffectHandlers?.[name]?.(...args),
        }
        {
            let declareAPI:(name: string, func:Function) => void

            ScriptingEngineState.engine = await luaFactory.createEngine({ injectObjects: true, enableProxy: false })
            const luaEngine = ScriptingEngineState.engine
            declareAPI = (name:string, func:Function) => {
                luaEngine.global.set(name, func)
            }
            registerLuaCoreApis(
                declareAPI as (name: string, handler: (...args: any[]) => unknown) => void,
                () => ScriptingEngineState.luaCoreAdapter!,
            )
            const effectHandlers: Partial<Record<LuaEffectApiName, (...args: any[]) => unknown>> = {}
            const addEffect = (name: LuaEffectApiName, handler: (...args: any[]) => unknown) => {
                effectHandlers[name] = handler
            }
            ScriptingEngineState.luaEffectHandlers = effectHandlers
            registerLuaEffectApis(
                declareAPI as (name: string, handler: (...args: any[]) => unknown) => void,
                () => ScriptingEngineState.luaEffectAdapter!,
            )
            addEffect('alertError', (id:string, value:string) => {
                alertError(value)
            })
            addEffect('alertNormal', (id:string, value:string) => {
                alertNormal(value)
            })
            addEffect('alertInput', (id:string, value:string) => {
                return alertInput(value)
            })
            addEffect('alertSelect', (id:string, value:string[]) => {
                return alertSelect(value)
            })
            addEffect('alertConfirm', (id:string, value:string) => {
                return alertConfirm(value).then(res => res ? true : false)
            })

            addEffect('getTokens', async (id:string, value:string) => {
                return await tokenize(value)
            })

            addEffect('sleep', (id:string, time:number) => {
                return new Promise((resolve) => {
                    setTimeout(() => {
                        resolve(true)
                    }, time)
                })
            })

            addEffect('logMain', (value:string) => {
                if (isDebugEnabled()) {
                    console.debug(JSON.parse(value))
                }
            })

            addEffect('reloadDisplay', (id:string) => {
                invalidateDisplay()
            })

            addEffect('reloadChat', (id: string, index: number) => {
                invalidateChatMessageRender(index)
            })

            //Low Level Access
            addEffect('similarity', async (id:string, source:string, value:string[]) => {
                const processer = new HypaProcesser()
                await processer.addText(value)
                return await processer.similaritySearch(source)
            })

            addEffect('request', async (id:string, url:string) => {
                if(lastRequestResetTime + 60000 < Date.now()){
                    lastRequestsCount = 0
                    lastRequestResetTime = Date.now()
                }
                
                if(lastRequestsCount > 5){
                    return JSON.stringify({
                        status: 429,
                        data: 'Too many requests. you can request 5 times per minute'
                    })
                }

                lastRequestsCount++

                try {
                    if(url.length > 120){
                        return JSON.stringify({
                            status: 413,
                            data: 'URL to large. max is 120 characters'
                        })
                    }

                    if(!url.startsWith('https://')){
                        return JSON.stringify({
                            status: 400,
                            data: "Only https requests are allowed"
                        })
                    }

                    const bannedURL = [
                        "https://realm.risuai.net",
                        "https://risuai.net",
                        "https://risuai.xyz"
                    ]

                    for(const burl of bannedURL){

                        if(url.startsWith(burl)){
                            return JSON.stringify({
                                status: 400,
                                data: "request to " + url + ' is not allowed'
                            })
                        }
                    }

                    const d = await fetchNative(url, {
                        method: "GET"
                    })
                    const text = await d.text()
                    return JSON.stringify({
                        status: d.status,
                        data: text
                    })

                } catch (error) {
                    return JSON.stringify({
                        status: 400,
                        data: 'internal error'
                    })
                }
            })

            addEffect('generateImage', async (id:string, value:string, negValue:string = '', options?: { orientation?: ImageOrientation }) => {
                const orientation = options?.orientation
                if (orientation !== undefined && !isImageOrientation(orientation)) return 'Error: Image orientation must be landscape or portrait, received ' + orientation
                const imageCharacter = ScriptingEngineState.character?.type === 'character'
                    ? ScriptingEngineState.character
                    : getCurrentCharacter()
                try {
                    return await generateImageThroughWorkflow({
                        characterId: imageCharacter.chaId,
                        roomId: chat.id,
                        prompt: value,
                        negativePrompt: negValue,
                        orientation,
                    })
                } catch (error) {
                    notifyError(error)
                    return 'Error: Image generation failed'
                }
            })

            addEffect('getCharacterImageMain', async (id:string) => {
                try {
                    const character = ScriptingEngineState.character
                    
                    if (character?.type !== 'character' || !character.image) {
                        return ''
                    }
                    
                    const img = await readImage(character.image)
                    const imgObj = new Image()
                    const extention = character.image.split('.').at(-1)

                    imgObj.src = URL.createObjectURL(new Blob([asBuffer(img)], {type: `image/${extention}`}))

                    const imgid = await writeInlayImage(imgObj, { name: character.image, ext: extention, id: character.image})

                    if (imgid) {
                        return `{{inlayed::${imgid}}}`
                    }
                    console.warn('Failed to create character image inlay')
                    return ''
                } catch (error) {
                    console.error('Error in getCharacterImageMain:', error)
                    return ''
                }
            })

            addEffect('getPersonaImageMain', async (id:string) => {
                try {
                    const icon = getUserIcon()

                    if(!icon) {
                        return ''
                    }

                    const img = await readImage(icon)
                    const imgObj = new Image()
                    const extention = icon.split('.').at(-1)

                    imgObj.src = URL.createObjectURL(new Blob([asBuffer(img)], {type: `image/${extention}`}))

                    const imgid = await writeInlayImage(imgObj, { name: icon, ext: extention, id: icon})

                    if (imgid) {
                        return `{{inlayed::${imgid}}}`
                    }
                    
                    console.warn('Failed to create character image inlay')
                    return ''
                } catch (error) {
                    console.error('Error in getCharacterImageMain:', error)
                    return ''
                }
            })

            addEffect('hash', async (id:string, value:string) => {
                return await hasher(new TextEncoder().encode(value))
            })

            const collectLuaStreamText = async (stream: ReadableStream<StreamResponseChunk>) => {
                const reader = stream.getReader();
                let text = '';
                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        if (value && typeof value['0'] === 'string') {
                            text = value['0'];
                        }
                    }
                } finally {
                    reader.releaseLock();
                }
                return text;
            };

            const prepareRevenantLuaCall = async (
                modelMode: 'model' | LuaAxLlmMode,
                requestIdentity: string,
            ): Promise<{
                replay?: string;
                operationContext?: RevenantLuaLlmOperation;
            }> => {
                const execution = ScriptingEngineState.revenantLuaExecution;
                if (!execution) return {};
                const callIndex = execution.callIndex++;
                const requestHash = await hasher(new TextEncoder().encode(
                    `${modelMode}\n${requestIdentity}`,
                ));
                const replayKey = `${execution.executionKey}:${callIndex}:${requestHash}`;
                const existing = await getLuaReplayJob(replayKey);
                const projectedContent = existing?.projection?.content ?? '';
                if (existing?.status === 'generated' && projectedContent.length > 0) {
                    execution.completedJobIds.add(existing.jobId);
                    return { replay: projectedContent };
                }
                if (existing) {
                    // Interrupted/failed work cannot provide a reliable return
                    // value. Consume it before retrying the same deterministic
                    // Lua call.
                    await consumeRecoverableAuxiliaryGeneration(existing.jobId);
                }
                return {
                    operationContext: createRevenantOperation({
                        kind: 'lua-llm',
                        executionKey: execution.executionKey,
                        replayKey,
                        characterId: execution.characterId,
                        roomId: execution.roomId,
                        mode: execution.mode,
                        code: execution.code,
                        lowLevelAccess: execution.lowLevelAccess,
                        data: execution.data,
                        meta: execution.meta,
                        moduleId: execution.moduleId,
                        anchorMessageId: execution.anchorMessageId,
                        callIndex,
                    }),
                };
            };

            const completeRevenantLuaCall = async (
                operationContext: RevenantLuaLlmOperation | undefined,
            ): Promise<boolean> => {
                if (!operationContext) return true;
                const jobs = await listRecoverableAuxiliaryGenerations(true);
                const job = jobs.find(candidate =>
                    isRevenantLuaLlmOperation(candidate.operationContext)
                    && candidate.operationContext.operationId === operationContext.operationId);
                if (!job) return false;
                if (isRevenantJobActive(job.status)) return false;
                ScriptingEngineState.revenantLuaExecution?.completedJobIds.add(job.jobId);
                return true;
            };

            const runLuaLlm = async (
                modelMode: 'model' | LuaAxLlmMode,
                promptStr: string,
                useMultimodal = false,
                optionsStr?: string,
                options = parseLuaLlmOptions(optionsStr),
            ): Promise<string> => {
                const promptbody: OpenAIChat[] = normalizeLuaLlmPrompt(promptStr)
                // Built before multimodal handling rewrites the message content.
                const requestIdentity = luaLlmRequestIdentity(promptbody, useMultimodal, options)
                if(useMultimodal){
                    for(const message of promptbody){
                        const normalized = extractLuaLlmInlays({
                            role: message.role === 'system' || message.role === 'user'
                                ? message.role
                                : 'assistant',
                            content: String(message.content ?? ''),
                        })
                        message.content = normalized.content
                        const multimodals: MultiModal[] = await Promise.all(normalized.inlayIds.map(async inlayId => {
                            const inlayData = await getInlayAsset(inlayId)
                            return {
                                type: inlayData?.type,
                                base64: inlayData?.data,
                                width: inlayData?.width,
                                height: inlayData?.height,
                            }
                        }))
                        message.multimodals = multimodals.length > 0 ? multimodals : undefined
                    }
                }

                const revenantCall = await prepareRevenantLuaCall(modelMode, requestIdentity)
                if(revenantCall.replay !== undefined){
                    return JSON.stringify(luaLlmResult(true, revenantCall.replay))
                }
                const result = await requestChatData({
                    formated: promptbody,
                    bias: {},
                    currentChar: ScriptingEngineState.character?.type === 'character'
                        ? ScriptingEngineState.character
                        : undefined,
                    useStreaming: options.streaming === true,
                    forceStreaming: options.streaming === true,
                    noMultiGen: true,
                    revenantOperationContext: revenantCall.operationContext,
                    moduleId: ScriptingEngineState.moduleId,
                    currentChat: chat,
                }, modelMode)

                if(result.type === 'fail'){
                    const failure = luaLlmResult(false, result.result, true)
                    const completed = await completeRevenantLuaCall(revenantCall.operationContext)
                    if(!completed && revenantCall.operationContext){
                        throw new Error('Revenant Lua generation detached; awaiting automatic recovery')
                    }
                    return JSON.stringify(failure)
                }
                if(result.type === 'streaming'){
                    try {
                        const text = await collectLuaStreamText(result.result)
                        await completeRevenantLuaCall(revenantCall.operationContext)
                        return JSON.stringify(luaLlmResult(true, text))
                    }
                    catch(error){
                        if(revenantCall.operationContext) throw error
                        return JSON.stringify(luaLlmResult(false, error, true))
                    }
                }
                if(result.type === 'multiline'){
                    return JSON.stringify(luaLlmResult(false, result.result))
                }
                await completeRevenantLuaCall(revenantCall.operationContext)
                return JSON.stringify(luaLlmResult(true, result.result))
            }

            addEffect('LLMMain', async (
                _id: string,
                promptStr: string,
                useMultimodal = false,
                optionsStr?: string,
            ) => await runLuaLlm('model', promptStr, useMultimodal, optionsStr))

            addEffect('simpleLLM', async (_id:string, prompt:string) => {
                const revenantCall = await prepareRevenantLuaCall('model', prompt)
                if (revenantCall.replay !== undefined) {
                    return luaLlmResult(true, revenantCall.replay)
                }
                const result = await requestChatData({
                    formated: [{
                        role: 'user',
                        content: prompt
                    }],
                    bias: {},
                    currentChar: ScriptingEngineState.character?.type === 'character'
                        ? ScriptingEngineState.character
                        : undefined,
                    useStreaming: false,
                    noMultiGen: true,
                    revenantOperationContext: revenantCall.operationContext,
                    moduleId: ScriptingEngineState.moduleId,
                    currentChat: chat,
                }, 'model')

                if(result.type === 'fail'){
                    const failure = luaLlmResult(false, result.result, true)
                    const completed = await completeRevenantLuaCall(revenantCall.operationContext)
                    if (!completed && revenantCall.operationContext) {
                        throw new Error('Revenant Lua generation detached; awaiting automatic recovery')
                    }
                    return failure
                }

                if(result.type === 'streaming' || result.type === 'multiline'){
                    return luaLlmResult(false, result.result)
                }

                await completeRevenantLuaCall(revenantCall.operationContext)
                return luaLlmResult(true, result.result)
            })
            
            addEffect('getPersonaName', (id:string) => {
                return getUserName()
            })

            addEffect('getPersonaDescription', (id:string) => {
                return risuChatParser(getPersonaPrompt(), { chara: char.type === 'character' ? char : undefined })
            })

            addEffect('getLoreBooksMain', (id:string, search:string) => {
                const selectedChar = ScriptingEngineState.character
                if (selectedChar.type !== 'character') {
                    return
                }

                const loreSources = [
                    chat.localLore ?? [],
                    selectedChar.globalLore,
                    getModuleLorebooks(selectedChar, chat)
                ]

                const found = []
                for (const source of loreSources) {
                    for (const b of source) {
                        if (b.comment === search) {
                            found.push({ ...b, content: risuChatParser(b.content, { chara: selectedChar }) })
                        }
                    }
                }

                return JSON.stringify(found)
            })

            type upsertLoreBookOptions = {
                alwaysActive?: boolean
                insertOrder?: number
                key?: string
                secondKey?: string
                regex?: boolean
            }

            addEffect('upsertLocalLoreBook', (id:string, name:string, content:string, options:upsertLoreBookOptions) => {
                const activeCharacter = ScriptingEngineState.character
                if (activeCharacter?.type !== 'character') {
                    return
                }

                const {
                    alwaysActive = false,
                    insertOrder = 100,
                    key = '',
                    regex = false,
                    secondKey = '',
                } = options

                const newLocalLoreBooks = (chat.localLore ?? []).filter((book) => book.comment !== name)
                newLocalLoreBooks.push({
                    alwaysActive,
                    comment: name,
                    content: content,
                    insertorder: insertOrder,
                    mode: 'normal',
                    key,
                    secondkey: secondKey,
                    selective: !!secondKey,
                    useRegex: regex,
                })
                chat.localLore = newLocalLoreBooks
            })

            addEffect('loadLoreBooksMain', async (id:string, reserve:number) => {
                const db = getDatabase()

                const selectedChar = ScriptingEngineState.character

                if (selectedChar.type !== 'character') {
                    return
                }

                const fullLoreBooks = (await loadLoreBookV3Prompt({ character: selectedChar, chat })).actives
                const maxContext = db.maxContext - reserve
                if (maxContext < 0) {
                    return JSON.stringify([])
                }

                let totalTokens = 0
                const loreBooks = []

                for (const book of fullLoreBooks) {
                    const parsed = risuChatParser(book.prompt, { chara: selectedChar }).trim()
                    if (parsed.length === 0) {
                        continue
                    }

                    const tokens = await tokenize(parsed)

                    if (totalTokens + tokens > maxContext) {
                        break
                    }
                    totalTokens += tokens
                    loreBooks.push({
                        data: parsed,
                        role: book.role === 'assistant' ? 'char' : book.role,
                    })
                }

                return JSON.stringify(loreBooks)
            })

            addEffect('axLLMMain', async (
                _id: string,
                promptStr: string,
                useMultimodal = false,
                optionsStr?: string,
            ) => {
                const options = parseLuaLlmOptions(optionsStr)
                let mode: LuaAxLlmMode
                try {
                    mode = resolveLuaAxLlmMode(options)
                } catch (error) {
                    return JSON.stringify(luaLlmResult(false, error instanceof Error ? error.message : error, true))
                }
                return runLuaLlm(mode, promptStr, useMultimodal, optionsStr, options)
            })

            await ScriptingEngineState.engine?.doString(wrapRevenantLua(code))
        }
        let accessKey = createEntityId()
        if(mode === 'editDisplay'){
            ScriptingEditDisplayIds.add(accessKey)
        }
        else{
            ScriptingSafeIds.add(accessKey)
            if(lowLevelAccess){
                ScriptingLowLevelIds.add(accessKey)
            }
        }
        let res:any
        let scriptCompleted = false
        const luaEngine = ScriptingEngineState.engine
        try {
            const invoked = await invokeLuaMode(luaEngine.global, mode, accessKey, data, meta)
            res = invoked.result
            if(res === false){
                stopSending = true
            }
            scriptCompleted = true
        } catch (error) {
            console.error(error)
        }
        ScriptingSafeIds.delete(accessKey)
        ScriptingLowLevelIds.delete(accessKey)
        ScriptingEditDisplayIds.delete(accessKey)
        const completedLuaJobIds = ScriptingEngineState.revenantLuaExecution?.completedJobIds
        let chatSaved = false
        if (scriptCompleted && completedLuaJobIds && completedLuaJobIds.size > 0 && char.type === 'character' && chat?.id) {
            // Save side effects before acknowledging the provider results so recovery can replay safely.
            chatSaved = await commitTriggerChat({ characterId: char.chaId, chatId: chat.id }, chat)
            if (!chatSaved) {
                throw new Error(`Revenant Lua target chat not found: ${chat.id}`)
            }
            for (const jobId of completedLuaJobIds) {
                await consumeRecoverableAuxiliaryGeneration(jobId)
            }
        }
        ScriptingEngineState.revenantLuaExecution = undefined

        return {
            stopSending, chat, res, chatSaved
        }
    } finally {
        ScriptingEngineState.engine?.global.close()
    }
}

const recoveringRevenantLuaChats = new Map<string, Promise<number>>()
let revenantLuaRecoveryCheckedAt = 0

export async function recoverRevenantLuaJobsForChat(
    char: character,
    chat: Chat,
): Promise<number> {
    if (!char?.chaId || !chat?.id || chat._placeholder) return 0
    const recoveryKey = `${char.chaId}/${chat.id}`
    const existing = recoveringRevenantLuaChats.get(recoveryKey)
    if (existing) return existing
    if (Date.now() - revenantLuaRecoveryCheckedAt < 1000) return 0
    revenantLuaRecoveryCheckedAt = Date.now()

    const recovery = (async () => {
        const jobs = await resolveRecoverableAuxiliaryGenerations({
            jobType: 'otherAx',
            isContext: isRevenantLuaLlmOperation,
            matchesContext: context =>
                context.characterId === char.chaId && context.roomId === chat.id,
        })
        const grouped = new Map<string, {
            context: RevenantLuaLlmOperation
            jobIds: string[]
        }>()
        for (const job of jobs) {
            const context = job.operationContext
            const group = grouped.get(context.executionKey) ?? { context, jobIds: [] }
            group.jobIds.push(job.jobId)
            grouped.set(context.executionKey, group)
        }

        let recovered = 0
        const availableLuaCodes = new Set(
            char.triggerscript
                .concat(getModuleTriggers(char, chat))
                .flatMap(trigger => trigger.effect)
                .flatMap(effect => effect.type === 'triggerlua' ? [effect.code] : []),
        )
        for (const { context, jobIds } of grouped.values()) {
            if (!availableLuaCodes.has(context.code)) {
                // Never execute code solely because it was persisted in a job;
                // it must still be installed on the current character/module.
                for (const jobId of jobIds) {
                    await consumeRecoverableAuxiliaryGeneration(jobId)
                }
                continue
            }
            const anchorExists = chat.message.some(message =>
                message?.chatId === context.anchorMessageId)
            if (!anchorExists && chat.message.at(-1)?.chatId) {
                // Do not apply an old script result to a chat whose triggering
                // message has been removed or replaced.
                continue
            }
            await runScripted(context.code, {
                char,
                chat,
                lowLevelAccess: context.lowLevelAccess,
                data: context.data,
                meta: context.meta,
                moduleId: context.moduleId,
                mode: context.mode,
                revenantReplayJobIds: jobIds,
            })
            recovered += 1
        }
        return recovered
    })().finally(() => {
        recoveringRevenantLuaChats.delete(recoveryKey)
    })
    recoveringRevenantLuaChats.set(recoveryKey, recovery)
    return recovery
}

async function makeLuaFactory(){
    const _luaFactory = new LuaFactory()
    async function mountFile(name:string){
        let code = ''
        for(let i = 0; i < 3; i++){
            try {
                const res = await fetch('/lua/' + name)
                if(res.status >= 200 && res.status < 300){
                    code = await res.text()
                    break
                }
            } catch (error) {}
        }
        await _luaFactory.mountFile(name,code)
    }

    await mountFile('json.lua')
    luaFactory = _luaFactory
}

async function ensureLuaFactory() {
    if (luaFactory) return;
    
    if (luaFactoryPromise) {
        await luaFactoryPromise;
        return
    }

    try {
        luaFactoryPromise = makeLuaFactory();
        await luaFactoryPromise;
    } finally {
        luaFactoryPromise = null;
    }
}

export async function runLuaEditTrigger<T extends string|OpenAIChat[]>(char:character|simpleCharacterArgument, mode:string, content:T, meta?:object):Promise<T>{
    switch(mode){
        case 'editinput':
            mode = 'editInput'
            break
        case 'editoutput':
            mode = 'editOutput'
            break
        case 'editdisplay':
            mode = 'editDisplay'
            break
        case 'editprocess':
            return content
    }

    try {
        let data = content

        const triggers = char.triggerscript.concat(getModuleTriggers())
    
        for(let trigger of triggers){
            if(trigger?.effect?.[0]?.type === 'triggerlua'){
                const code = trigger.effect[0].code
                if (!luaMayListenForEditMode(code, mode)) continue
                const runResult = await runScripted(trigger.effect[0].code, {
                    char: char,
                    lowLevelAccess: false,
                    mode: mode,
                    data,
                    meta,
                })
                data = runResult.res ?? data
            }
        }
        
    
        return data   
    } catch (error) {
        return content
    }
}

export function hasLuaEditListener(
    char: character|simpleCharacterArgument,
    mode: 'editinput'|'editoutput'|'editdisplay'|'editRequest',
): boolean {
    const runtimeMode = mode === 'editinput' ? 'editInput'
        : mode === 'editoutput' ? 'editOutput'
            : mode === 'editdisplay' ? 'editDisplay'
                : mode
    return char.triggerscript
        .concat(getModuleTriggers())
        .some(trigger => {
            const effect = trigger?.effect?.[0]
            if (effect?.type !== 'triggerlua') return false
            return luaMayListenForEditMode(effect.code, runtimeMode)
        })
}

export function hasLuaEditRequestListener(char: character|simpleCharacterArgument): boolean {
    return hasLuaEditListener(char, 'editRequest')
}

export async function runLuaInteractionTrigger(type:'button'|'form', char:character|simpleCharacterArgument, data:string, chat:Chat, meta:object = {}){
    let runResult
    const mode = type === 'button' ? 'onButtonClick' : 'onFormSubmit'
    const triggers = char.triggerscript.map<triggerscript>((v) => ({
        ...v,
        lowLevelAccess: char.type !== 'simple' ? char.lowLevelAccess ?? false : false
    })).concat(getModuleTriggers(char.type === 'character' ? char : undefined, chat))

    for (const trigger of triggers) {
        const effect = trigger?.effect?.[0]
        if (effect?.type !== 'triggerlua') continue
        runResult = await runScripted(effect.code, {
            char,
            chat,
            lowLevelAccess: trigger.lowLevelAccess,
            mode,
            data,
            meta,
            moduleId: trigger.moduleId,
        })
    }
    return runResult   
}
