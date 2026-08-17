<script lang="ts">
    import isEqual from "lodash/isEqual"
    import { DBState } from 'src/ts/stores.svelte'
    import { alertError } from "../../ts/alert"
    import { onDestroy, tick } from 'svelte'
    import { addMetadataToElement, getDistance, prepareMarkdownSource, renderPreparedMarkdown, resolveInlayPlaceholders, trimMarkdown, type CbsConditions, type simpleCharacterArgument } from "../../ts/parser/parser.svelte"
    import { getModuleAssets } from "src/ts/process/modules";
    import { getCurrentCharacter } from "src/ts/storage/database.svelte";
    import { getFileSrc } from "src/ts/globalApi.svelte";
    import { createChatBodyRenderController, translationLoadingHTML } from "./chatBodyRenderController.svelte";
    import type { RevenantChatTranslationRecovery, RevenantChatTranslationRecoverySnapshot } from "src/ts/process/revenant/recovery";
    import { getLLMTranslationCacheRevision } from "src/ts/translator/translator";
    import { getChatBodyRenderCache, setChatBodyRenderCache, waitForChatBodyRenderCacheCommit } from "./chatBodyRenderCache";
    import { createLatestTaskQueue } from "./latestTaskQueue";
    import { StreamingMarkdownBlockRenderer, type StreamingMarkdownRender } from "./streamingMarkdownBlocks";

    interface Props {
        character?: simpleCharacterArgument|string|null
        firstMessage?: boolean
        idx?: number
        msgDisplay?: string
        name?: string
        role: string|null
        translated: boolean
        retranslate: boolean
        onTranslationTaskChange?: (delta:1|-1) => void
        onTranslationCancelAvailabilityChange?: (cancel: (() => void) | null) => void
        bodyRoot?: HTMLElement|null
        modelShortName: string
        translationRevision?: number
        isStreamingDisplay?: boolean
        renderRevision?: string
        renderCacheKey?: string
        translationTaskKey?: string
        revenantTranslationRecovery: RevenantChatTranslationRecovery
        revenantTranslationRecoverySnapshot: RevenantChatTranslationRecoverySnapshot
        translationPending?: boolean
    }

    let {
        character = null,
        idx = 0,
        firstMessage = false,
        msgDisplay,
        role,
        translated = $bindable(false),
        retranslate = $bindable(false),
        onTranslationTaskChange = () => {},
        onTranslationCancelAvailabilityChange = () => {},
        bodyRoot,
        modelShortName = '',
        translationRevision = 0,
        isStreamingDisplay = false,
        renderRevision = '',
        renderCacheKey = '',
        translationTaskKey = '',
        revenantTranslationRecovery,
        revenantTranslationRecoverySnapshot,
        translationPending = false,
    }: Props =  $props()

    // svelte-ignore non_reactive_update
    let lastParsed = ''
    let lastCharArg:string|simpleCharacterArgument = null
    let lastChatId = -10
    let lastTranslationRevision = -1
    let lastRenderRevision = ''
    let lastTranslationCacheKey:string|null|undefined
    let ordinaryTranslationCacheKey: {
        data: string
        chatId: number
        translationRevision: number
        renderRevision: string
        role: string | null
        firstMessage: boolean
        key: string
    } | null = null
    // This controls the loading branch directly. The old {#await} block was
    // invalidated when its promise settled, but the persistent streaming DOM
    // needs this completion flag itself to be reactive.
    let lastParsedTranslated = $state(false)
    let completedRender: {
        data: string
        charArg: string | simpleCharacterArgument | null
        chatId: number
        translationRevision: number
        renderRevision: string
        translationCacheKey: string | null | undefined
        translated: boolean
        role: string | null
        firstMessage: boolean
    } | null = null
    interface MarkParsingRequest {
        data: string
        charArg: string | simpleCharacterArgument | null
        chatId: number
        translated: boolean
        retranslate: boolean
        translationRevision: number
        renderRevision: string
        renderCacheKey: string
        translationTaskKey: string
        streaming: boolean
        recoverySnapshot: RevenantChatTranslationRecoverySnapshot
        role: string | null
        firstMessage: boolean
        allowCachedTranslationStateRestore: boolean
        postRenderStateUpdates?: Array<() => void>
        streamingRender?: StreamingMarkdownRender
    }
    interface ChatBodyRenderResult {
        html: string
        streamingRender?: StreamingMarkdownRender
    }
    let currentMarkParsingPromise: Promise<ChatBodyRenderResult> | null = null
    let currentMarkParsingRequest: MarkParsingRequest | null = null
    let currentMarkParsingSettled = false
    let committedRender = $state<ChatBodyRenderResult | null>(null)
    let committedRenderPromise: Promise<ChatBodyRenderResult> | null = null
    let stopInlayObservation = () => {}
    let skipNextTranslatedRender:boolean|null = null
    const renderController = createChatBodyRenderController(
        (delta) => onTranslationTaskChange(delta),
        (cancel) => onTranslationCancelAvailabilityChange(cancel),
    )
    const streamingBlockRenderer = new StreamingMarkdownBlockRenderer()
    const runMarkParsingRequest = async (request: MarkParsingRequest): Promise<ChatBodyRenderResult> => ({
        html: await markParsing(
            request.data,
            request.charArg,
            request.chatId,
            undefined,
            request,
        ),
        streamingRender: request.streamingRender,
    })
    const markParsingQueue = createLatestTaskQueue<
        MarkParsingRequest,
        ChatBodyRenderResult
    >(runMarkParsingRequest)
    onDestroy(() => {
        stopInlayObservation()
        markParsingQueue.destroy()
        renderController.dispose()
    })

    function getCbsCondition(request?: MarkParsingRequest){
        try{
            const cbsConditions:CbsConditions = {
                firstmsg: request?.firstMessage ?? firstMessage ?? false,
                chatRole: request?.role ?? role,
            }
            return cbsConditions
        }
        catch(e){
            return {
                firstmsg: firstMessage ?? false,
                chatRole: null,
            }
        }
    }

    const markParsing = async (
        data: string,
        charArg: string | simpleCharacterArgument,
        chatID: number,
        tries?:number,
        requestContext?: MarkParsingRequest,
    ): Promise<string> => {
        // track 'translated' and 'retranslate' state
        translated;
        retranslate;
        translationRevision;
        const requestTranslated = requestContext?.translated ?? translated
        const requestRetranslate = requestContext?.retranslate ?? retranslate
        const requestTranslationRevision = requestContext?.translationRevision ?? translationRevision
        const requestRenderRevision = requestContext?.renderRevision ?? renderRevision
        const requestRenderCacheKey = requestContext?.renderCacheKey ?? renderCacheKey
        const requestStreaming = requestContext?.streaming ?? isStreamingDisplay
        const requestRole = requestContext?.role ?? role
        const requestFirstMessage = requestContext?.firstMessage ?? firstMessage
        if (!requestStreaming) streamingBlockRenderer.reset()
        const isCurrentRenderRequest = () =>
            requestContext === undefined || currentMarkParsingRequest === requestContext
        const queuePostRenderStateUpdate = (update: () => void) => {
            if (!requestContext) {
                update()
                return
            }
            requestContext.postRenderStateUpdates ??= []
            requestContext.postRenderStateUpdates.push(update)
        }
        // Cache-key discovery for ordinary auto-translation is render-local;
        // do not mutate the shared revenant snapshot passed down by Chat.
        const recoverySnapshot = {
            ...(requestContext?.recoverySnapshot ?? revenantTranslationRecoverySnapshot),
        }
        const currentTranslationTaskKey = requestContext?.translationTaskKey ?? translationTaskKey
        const activeTranslationCacheKey = renderController.getActiveTranslationCacheKey(currentTranslationTaskKey)
        const translationRecoveryPending = recoverySnapshot.pending || activeTranslationCacheKey !== null
        const recoveryCacheKey = recoverySnapshot.cacheKey
        let translationCacheKey = recoveryCacheKey
            ?? activeTranslationCacheKey
            ?? (
                ordinaryTranslationCacheKey
                && ordinaryTranslationCacheKey.data === data
                && ordinaryTranslationCacheKey.chatId === chatID
                && ordinaryTranslationCacheKey.translationRevision === requestTranslationRevision
                && ordinaryTranslationCacheKey.renderRevision === requestRenderRevision
                && ordinaryTranslationCacheKey.role === requestRole
                && ordinaryTranslationCacheKey.firstMessage === requestFirstMessage
                    ? ordinaryTranslationCacheKey.key
                    : null
            )
        let renderTranslated = requestTranslated
        const renderPass = renderController.beginRender({
            streaming: requestStreaming,
            translationPending: translationRecoveryPending,
        })
        if (
            completedRender
            && !renderPass.invalidated
            && !requestRetranslate
            && completedRender.data === data
            && isEqual(completedRender.charArg, charArg)
            && completedRender.chatId === chatID
            && completedRender.translationRevision === requestTranslationRevision
            && completedRender.renderRevision === requestRenderRevision
            && completedRender.translationCacheKey === recoveryCacheKey
            && completedRender.translated === requestTranslated
            && completedRender.role === requestRole
            && completedRender.firstMessage === requestFirstMessage
        ) {
            return lastParsed
        }
        const persistentRender = requestRenderCacheKey && !requestRetranslate && !translationRecoveryPending && !requestStreaming
            ? getChatBodyRenderCache(
                requestRenderCacheKey,
                data,
                getLLMTranslationCacheRevision(),
                requestContext?.allowCachedTranslationStateRestore ? undefined : requestTranslated,
            )
            : null
        if (persistentRender) {
            // Cache hits otherwise resolve together in one microtask and make
            // Firefox construct an entire long room's DOM in a single frame.
            // Keep lookup/parsing eliminated, but budget HTML commits across
            // frames just as the asynchronous upstream path naturally does.
            await waitForChatBodyRenderCacheCommit(persistentRender.html.length)
            if (!isCurrentRenderRequest()) return lastParsed || persistentRender.html
            translationCacheKey = persistentRender.translationCacheKey
            renderTranslated = persistentRender.translated
            lastParsed = persistentRender.html
            lastParsedTranslated = persistentRender.translated
            completedRender = {
                data,
                charArg,
                chatId: chatID,
                translationRevision: requestTranslationRevision,
                renderRevision: requestRenderRevision,
                translationCacheKey: recoveryCacheKey,
                translated: persistentRender.translated,
                role: requestRole,
                firstMessage: requestFirstMessage,
            }
            if (requestTranslated !== persistentRender.translated) {
                queuePostRenderStateUpdate(() => {
                    if (msgDisplay === data && isCurrentRenderRequest()) {
                        // The cached HTML already represents this state. Keep
                        // the current promise identity when publishing the
                        // control state so Svelte does not replace the same
                        // large subtree a second time.
                        skipNextTranslatedRender = persistentRender.translated
                        translated = persistentRender.translated
                    }
                })
            }
            return persistentRender.html
        }
        const parseMessageMarkdown = (
            value:string,
            mode:'normal'|'back'|'pretranslate'|'notrim',
        ) => renderPass.parseMarkdown(value, charArg, mode, chatID, getCbsCondition(requestContext))
        let lastParsedQueue = ''
        let currentParsedTranslated = false
        let renderResultReady = false
        let translatedStateUpdate:boolean|null = null
        let mode = 'notrim' as const
        try {
            if((!isEqual(lastCharArg, charArg))
                || (chatID !== lastChatId)
                || (requestTranslationRevision !== lastTranslationRevision)
                || (requestRenderRevision !== lastRenderRevision)
                || (recoveryCacheKey !== lastTranslationCacheKey)
                || renderPass.invalidated){
                lastParsedQueue = ''
                try {
                    const translateText =
                        await revenantTranslationRecovery.shouldDisplayTranslation(
                            recoverySnapshot,
                            {
                                data,
                                translated: requestTranslated || activeTranslationCacheKey !== null,
                                streaming: requestStreaming,
                                parseMarkdown: parseMessageMarkdown,
                            },
                        )
                    // Commit the inspection identity only after its async work
                    // completes. A recovery-list notification may start a
                    // concurrent render; publishing these fields beforehand
                    // made that render skip inspection and parse the entire
                    // room once in the untranslated state.
                    lastCharArg = charArg
                    lastChatId = chatID
                    const inspectedRenderRevision = requestRenderRevision
                    lastTranslationRevision = requestTranslationRevision
                    lastRenderRevision = inspectedRenderRevision
                    lastTranslationCacheKey = recoveryCacheKey
                    translationCacheKey = recoverySnapshot.cacheKey
                    if (!recoverySnapshot.pending && translationCacheKey) {
                        ordinaryTranslationCacheKey = {
                            data,
                            chatId: chatID,
                            translationRevision: requestTranslationRevision,
                            renderRevision: inspectedRenderRevision,
                            role: requestRole,
                            firstMessage: requestFirstMessage,
                            key: translationCacheKey,
                        }
                    }
                    renderTranslated = translateText

                    const lastTranslated = requestTranslated

                    if (lastTranslated !== translateText) {
                        // Render the discovered state in this pass, then publish
                        // the reactive flag only after its HTML is complete.
                        // Publishing before the await caused a duplicate pass;
                        // returning here (the upstream behavior) created a
                        // second room-wide wave and kept translation spinners up.
                        translatedStateUpdate = translateText
                    }
                } catch (error) {
                    console.error(error)
                }
            }
            if(requestStreaming && renderTranslated){
                queuePostRenderStateUpdate(() => {
                    if (msgDisplay === data && isCurrentRenderRequest()) translated = false
                })
                renderTranslated = false
            }
            if(!requestStreaming && (requestRetranslate || renderTranslated)){
                await revenantTranslationRecovery.waitForResult(recoverySnapshot)
                const transResult = await renderController.renderTranslation({
                    data,
                    charArg,
                    chatId: chatID,
                    retranslate: requestRetranslate,
                    translationCacheKey,
                    parseMarkdown: parseMessageMarkdown,
                    translationTaskKey: currentTranslationTaskKey,
                })
                lastParsedQueue = transResult
                currentParsedTranslated = true
                lastCharArg = charArg

                if (!translationCacheKey && DBState.db.translatorType === 'llm') {
                    translationCacheKey = DBState.db.translateBeforeHTMLFormatting
                        ? data
                        : await parseMessageMarkdown(
                            data,
                            DBState.db.legacyTranslation ? 'notrim' : 'pretranslate',
                        )
                }
                queuePostRenderStateUpdate(() => {
                    if (isCurrentRenderRequest()) retranslate = false
                })
                await revenantTranslationRecovery.acknowledgeResolved(recoverySnapshot)

                renderResultReady = true
                return transResult
            }
            else{
                let marked: string
                if (requestContext?.streaming && mode === 'notrim') {
                    const preparedSource = await prepareMarkdownSource(
                        data,
                        charArg,
                        mode,
                        chatID,
                        getCbsCondition(requestContext),
                        { inlineThoughts: true },
                    )
                    const contextKey = [
                        chatID,
                        requestContext.translationRevision,
                        requestContext.renderRevision,
                        requestContext.role ?? '',
                        requestContext.firstMessage ? 1 : 0,
                    ].join(':')
                    requestContext.streamingRender = await streamingBlockRenderer.render(
                        preparedSource,
                        contextKey,
                        source => renderPreparedMarkdown(source, mode),
                    )
                    marked = requestContext.streamingRender.html
                }
                else {
                    if (requestContext) requestContext.streamingRender = undefined
                    marked = await streamingBlockRenderer.renderFinal(
                        data,
                        source => parseMessageMarkdown(source, mode),
                    )
                }
                lastParsedQueue = marked
                currentParsedTranslated = false
                lastCharArg = charArg
                renderResultReady = true
                return marked
            }   
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                if (renderController.isDisposed()) return lastParsed || data
                if (isCurrentRenderRequest()) {
                    retranslate = false
                    translated = false
                }
                lastParsedQueue = await parseMessageMarkdown(data, mode)
                currentParsedTranslated = false
                renderResultReady = true
                return lastParsedQueue
            }
            //retry
            if(tries > 2){

                alertError(`Error while parsing chat message: ${requestTranslated}, ${error.message}, ${error.stack}`)
                lastParsedQueue = data
                currentParsedTranslated = false
                renderResultReady = true
                return data
            }
            return await markParsing(data, charArg, chatID, (tries ?? 0) + 1, requestContext)
        }
        finally{
            if (renderResultReady && isCurrentRenderRequest()) {
                const settledRenderRevision = requestContext?.renderRevision ?? renderRevision
                const settledRenderCacheKey = requestContext?.renderCacheKey ?? renderCacheKey
                //since trimMarkdown is fast, we don't need to cache it
                lastParsed = lastParsedQueue
                lastParsedTranslated = currentParsedTranslated
                completedRender = {
                    data,
                    charArg,
                    chatId: chatID,
                    translationRevision: requestTranslationRevision,
                    renderRevision: settledRenderRevision,
                    translationCacheKey: recoveryCacheKey,
                    translated: currentParsedTranslated,
                    role: requestRole,
                    firstMessage: requestFirstMessage,
                }
                if (
                    settledRenderCacheKey
                    && !requestStreaming
                    && !translationRecoveryPending
                ) {
                    setChatBodyRenderCache(settledRenderCacheKey, {
                        sourceData: data,
                        html: lastParsedQueue,
                        translated: currentParsedTranslated,
                        translationCacheKey: translationCacheKey ?? null,
                        translationCacheRevision: getLLMTranslationCacheRevision(),
                    })
                }
                if (translatedStateUpdate !== null) {
                    queuePostRenderStateUpdate(() => {
                        if (msgDisplay === data && isCurrentRenderRequest()) {
                            // Chat's controls still need the published state,
                            // but the HTML represented by that state is already
                            // the result of the current promise. Reuse it once
                            // so Svelte does not replace the same large subtree.
                            skipNextTranslatedRender = translatedStateUpdate
                            translated = translatedStateUpdate!
                        }
                    })
                }
            }
        }
    }

    const checkImg = () => {
        if(!DBState.db.newImageHandlingBeta || !bodyRoot){
            return
        }
        const imgs = bodyRoot.querySelectorAll('img:not([src^="data:"]):not([src^="http:"]):not([src^="https:"]):not([src^="blob:"]):not([src^="file:"]):not([src^="tauri:"]):not([src^="/"]):not([noimage])') as NodeListOf<HTMLImageElement>
        
        if (imgs.length > 0) {
            const currentCharacter = getCurrentCharacter()
            const styl = currentCharacter.prebuiltAssetStyle
            const assets = getModuleAssets().concat(currentCharacter.additionalAssets ?? [])
            const normalizedAssets = assets.map((asset) => {
                return {
                    name: asset[0].toLocaleLowerCase(),
                    path: asset[1]
                }
            })
            const exactAssets = new Map(normalizedAssets.map((asset) => [asset.name, asset.path]))

            imgs.forEach(async (img) => {
                const name = img.getAttribute('src')?.toLocaleLowerCase() || ''
                console.log(name)

                if(
                    name.length > 200 ||
                    name.includes(':')
                ){
                    img.setAttribute('noimage', 'true')
                    return
                }
                
                const foundAsset = exactAssets.get(name)
                console.log('Checking image:', name, 'Assets:', assets)
                if(foundAsset){
                    img.classList.add('root-loaded-image')
                    img.classList.add('root-loaded-image-' + styl)
                    img.src = await getFileSrc(foundAsset)
                    return
                }

                if(name.length < 3){
                    img.setAttribute('noimage', 'true')
                    return
                }
                const prefixLoc = name.lastIndexOf('.')
                const prefix = prefixLoc > 0 ? name.substring(0, prefixLoc) : ''
                let currentDistance = 1000
                let currentFound = ''
                for(const asset of normalizedAssets){
                    if(!asset.name.startsWith(prefix)){
                        continue
                    }
                    const distance = getDistance(name, asset.name)
                    if(distance < currentDistance){
                        currentDistance = distance
                        currentFound = asset.path
                    }
                }
                if(currentFound){
                    const got = await getFileSrc(currentFound)
                    const name2 = img.getAttribute('src')?.toLocaleLowerCase() || ''
                    if(name === name2){
                        img.setAttribute('src', got)
                    }

                    if(img.classList.length === 0){
                        img.classList.add('root-loaded-image')
                        img.classList.add('root-loaded-image-' + styl)
                    }
                    img.removeAttribute('noimage')
                }
                else{
                    img.setAttribute('noimage', 'true')
                }
            })
        }
    }

    let markParsingResult = $derived.by(() => {
        const data = msgDisplay
        const charArg = character
        const chatId = idx
        const translatedState = translated
        // A fresh body may restore both its HTML and translated state from the
        // room cache. Once this body has rendered, or the requested state has
        // changed while its first render is in flight, a mismatched cache entry
        // must not undo the user's translation toggle.
        const allowCachedTranslationStateRestore = completedRender === null
            && (
                currentMarkParsingRequest === null
                || currentMarkParsingRequest.translated === translatedState
            )
        const request: MarkParsingRequest = {
            data,
            charArg,
            chatId,
            translated: translatedState,
            retranslate,
            translationRevision,
            renderRevision,
            renderCacheKey,
            translationTaskKey,
            streaming: isStreamingDisplay,
            recoverySnapshot: revenantTranslationRecoverySnapshot,
            role,
            firstMessage,
            allowCachedTranslationStateRestore,
        }
        if (
            currentMarkParsingPromise
            && skipNextTranslatedRender === translatedState
        ) {
            skipNextTranslatedRender = null
            // Keep the request object passed to markParsing alive. A module
            // signature/display revision can settle while the translated
            // state is being published; replacing this object would make the
            // completed HTML get cached under the transient revision.
            if (currentMarkParsingRequest) {
                Object.assign(currentMarkParsingRequest, request)
            }
            else {
                currentMarkParsingRequest = request
            }
            return currentMarkParsingPromise
        }
        skipNextTranslatedRender = null
        if (
            currentMarkParsingPromise
            && currentMarkParsingRequest
            && currentMarkParsingRequest.data === request.data
            && isEqual(currentMarkParsingRequest.charArg, request.charArg)
            && currentMarkParsingRequest.chatId === request.chatId
            && currentMarkParsingRequest.translated === request.translated
            && currentMarkParsingRequest.retranslate === request.retranslate
            && currentMarkParsingRequest.translationRevision === request.translationRevision
            && currentMarkParsingRequest.renderRevision === request.renderRevision
            && currentMarkParsingRequest.renderCacheKey === request.renderCacheKey
            && currentMarkParsingRequest.translationTaskKey === request.translationTaskKey
            && currentMarkParsingRequest.streaming === request.streaming
            && isEqual(currentMarkParsingRequest.recoverySnapshot, request.recoverySnapshot)
            && currentMarkParsingRequest.role === request.role
            && currentMarkParsingRequest.firstMessage === request.firstMessage
        ) {
            return currentMarkParsingPromise
        }
        if (
            currentMarkParsingPromise
            && !currentMarkParsingSettled
            && currentMarkParsingRequest
            && currentMarkParsingRequest.data === request.data
            && isEqual(currentMarkParsingRequest.charArg, request.charArg)
            && currentMarkParsingRequest.chatId === request.chatId
            && currentMarkParsingRequest.translated === request.translated
            && currentMarkParsingRequest.retranslate === request.retranslate
            && currentMarkParsingRequest.translationRevision === request.translationRevision
            && currentMarkParsingRequest.translationTaskKey === request.translationTaskKey
            && currentMarkParsingRequest.streaming === request.streaming
            && isEqual(currentMarkParsingRequest.recoverySnapshot, request.recoverySnapshot)
            && currentMarkParsingRequest.role === request.role
            && currentMarkParsingRequest.firstMessage === request.firstMessage
        ) {
            // A global display reload can arrive in the same tick as a room
            // switch. The render already observes the newly selected room's
            // state; remounting every body here only duplicates the in-flight
            // work and clears its DOM/cache state.
            currentMarkParsingRequest.renderRevision = request.renderRevision
            currentMarkParsingRequest.renderCacheKey = request.renderCacheKey
            return currentMarkParsingPromise
        }
        const previousRequest = currentMarkParsingRequest
        const completesStreaming = previousRequest?.streaming === true
            && !request.streaming
            && previousRequest.chatId === request.chatId
            && previousRequest.role === request.role
        currentMarkParsingRequest = request
        currentMarkParsingSettled = false
        const promise = request.streaming || completesStreaming
            ? markParsingQueue.enqueue(request)
            : (() => {
                // Swipe/edit/translation transitions are user-visible state
                // changes and must not wait behind a long streaming parse.
                markParsingQueue.clearPending()
                return runMarkParsingRequest(request)
            })()
        currentMarkParsingPromise = promise
        void promise.finally(() => {
            if (currentMarkParsingPromise === promise) currentMarkParsingSettled = true
        })
        void promise.then(async () => {
            // Publish bindable control state only after the resolved HTML has
            // been committed. This avoids recursively starting a duplicate
            // parse without relying on an arbitrary timer delay.
            await tick()
            if (currentMarkParsingPromise !== promise || currentMarkParsingRequest !== request) return
            const updates = request.postRenderStateUpdates?.splice(0) ?? []
            for (const update of updates) update()
        }, () => {})
        return currentMarkParsingPromise
    })

    $effect(() => {
        const promise = markParsingResult
        stopInlayObservation()
        stopInlayObservation = () => {}
        committedRenderPromise = promise
        checkImg()
        void promise.then(async (result) => {
            if (committedRenderPromise !== promise) return
            committedRender = result
            await tick()
            if (committedRenderPromise !== promise) return
            checkImg()
            if (bodyRoot) {
                const cleanup = resolveInlayPlaceholders(bodyRoot)
                stopInlayObservation = typeof cleanup === 'function' ? cleanup : () => {}
            }
        }, () => {})
    })
</script>

{#if DBState.db.showTranslationLoading && (translationPending || retranslate || (translated && !lastParsedTranslated))}
    {@html addMetadataToElement(trimMarkdown(translationLoadingHTML), modelShortName)}
{:else if committedRender}
    {#if committedRender.streamingRender && committedRender.streamingRender.stableBlocks.length > 0}
        {#each committedRender.streamingRender.stableBlocks as block (block.key)}
            {@html addMetadataToElement(trimMarkdown(block.html), modelShortName, false)}
        {/each}
        {@html addMetadataToElement(trimMarkdown(committedRender.streamingRender.tail.html), modelShortName)}
    {:else}
        {@html addMetadataToElement(trimMarkdown(committedRender.html), modelShortName)}
    {/if}
{:else}
    {@html addMetadataToElement(trimMarkdown(lastParsed), modelShortName)}
{/if}
