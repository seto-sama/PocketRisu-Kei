<script lang="ts">
    import isEqual from "lodash/isEqual"
    import { DBState } from 'src/ts/stores.svelte'
    import { alertError } from "../../ts/alert"
    import { onDestroy, tick } from 'svelte'
    import { addMetadataToElement, getDistance, resolveInlayPlaceholders, trimMarkdown, type CbsConditions, type simpleCharacterArgument } from "../../ts/parser/parser.svelte"
    import { getModuleAssets } from "src/ts/process/modules";
    import { getCurrentCharacter } from "src/ts/storage/database.svelte";
    import { getFileSrc } from "src/ts/globalApi.svelte";
    import { createChatBodyRenderController, translationLoadingHTML } from "./chatBodyRenderController.svelte";
    import type { RevenantChatTranslationRecovery } from "src/ts/process/revenant/chatRecovery.svelte";

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
        revenantTranslationRecovery: RevenantChatTranslationRecovery
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
        revenantTranslationRecovery,
    }: Props =  $props()

    // svelte-ignore non_reactive_update
    let lastParsed = ''
    let lastCharArg:string|simpleCharacterArgument = null
    let lastChatId = -10
    let lastTranslationRevision = -1
    let lastTranslationCacheKey:string|null|undefined
    // svelte-ignore non_reactive_update
    let lastParsedTranslated = false
    const renderController = createChatBodyRenderController(
        (delta) => onTranslationTaskChange(delta),
        (cancel) => onTranslationCancelAvailabilityChange(cancel),
    )
    onDestroy(() => renderController.dispose())

    function getCbsCondition(){
        try{
            const cbsConditions:CbsConditions = {
                firstmsg: firstMessage ?? false,
                chatRole: role,
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

    const markParsing = async (data: string, charArg: string | simpleCharacterArgument, chatID: number, tries?:number) => {
        // track 'translated' and 'retranslate' state
        translated;
        retranslate;
        translationRevision;
        const recoverySnapshot = revenantTranslationRecovery.capture()
        const translationRecoveryPending = recoverySnapshot.pending
        const translationCacheKey = recoverySnapshot.cacheKey
        const renderPass = renderController.beginRender({
            streaming: isStreamingDisplay,
            translationPending: translationRecoveryPending,
        })
        const parseMessageMarkdown = (
            value:string,
            mode:'normal'|'back'|'pretranslate'|'notrim',
        ) => renderPass.parseMarkdown(value, charArg, mode, chatID, getCbsCondition())
        let lastParsedQueue = ''
        let currentParsedTranslated = false
        let mode = 'notrim' as const
        try {
            if((!isEqual(lastCharArg, charArg))
                || (chatID !== lastChatId)
                || (translationRevision !== lastTranslationRevision)
                || (translationCacheKey !== lastTranslationCacheKey)
                || renderPass.invalidated){
                lastParsedQueue = ''
                lastCharArg = charArg
                lastChatId = chatID
                lastTranslationRevision = translationRevision
                lastTranslationCacheKey = translationCacheKey
                try {
                    const translateText =
                        await revenantTranslationRecovery.shouldDisplayTranslation(
                            recoverySnapshot,
                            {
                                data,
                                translated,
                                streaming: isStreamingDisplay,
                                parseMarkdown: parseMessageMarkdown,
                            },
                        )

                    const lastTranslated = translated

                    if (lastTranslated !== translateText) {
                        const marked = await parseMessageMarkdown(data, mode)
                        lastParsedQueue = marked
                        currentParsedTranslated = false
                        lastCharArg = charArg
                        setTimeout(() => {
                            if (msgDisplay === data) translated = translateText
                        }, 10)
                        return lastParsedQueue
                    }
                } catch (error) {
                    console.error(error)
                }
            }
            if(isStreamingDisplay && translated){
                setTimeout(() => {
                    if (msgDisplay === data) translated = false
                }, 10)
            }
            if(!isStreamingDisplay && (retranslate || translated)){
                await revenantTranslationRecovery.waitForResult(recoverySnapshot)
                const transResult = await renderController.renderTranslation({
                    data,
                    charArg,
                    chatId: chatID,
                    retranslate,
                    translationCacheKey,
                    parseMarkdown: parseMessageMarkdown,
                })
                lastParsedQueue = transResult
                currentParsedTranslated = true
                lastCharArg = charArg

                setTimeout(() => {
                    retranslate = false
                }, 10);
                await revenantTranslationRecovery.acknowledgeResolved(recoverySnapshot)

                return transResult
            }
            else{
                const marked = await parseMessageMarkdown(data, mode)
                lastParsedQueue = marked
                currentParsedTranslated = false
                lastCharArg = charArg
                return marked
            }   
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                retranslate = false
                translated = false
                lastParsedQueue = await parseMessageMarkdown(data, mode)
                currentParsedTranslated = false
                return lastParsedQueue
            }
            //retry
            if(tries > 2){

                alertError(`Error while parsing chat message: ${translated}, ${error.message}, ${error.stack}`)
                return data
            }
            return await markParsing(data, charArg, chatID, (tries ?? 0) + 1)
        }
        finally{
            //since trimMarkdown is fast, we don't need to cache it
            lastParsed = lastParsedQueue
            lastParsedTranslated = currentParsedTranslated
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

    let markParsingResult = $derived.by(async () => {
        return await markParsing(msgDisplay, character, idx)
    })

    $effect(() => {
        markParsingResult
        checkImg()
        markParsingResult.then(async () => {
            checkImg()
            await tick() // Wait for Svelte to re-render the {:then} block into DOM
            if (bodyRoot) resolveInlayPlaceholders(bodyRoot)
        })
    })
</script>

{#await markParsingResult}
    {@html addMetadataToElement(trimMarkdown(DBState.db.showTranslationLoading && (renderController.isTranslationBusy(revenantTranslationRecovery.pending, retranslate) || (translated && !lastParsedTranslated)) ? translationLoadingHTML : lastParsed), modelShortName)}
{:then md}
    {@html addMetadataToElement(trimMarkdown(md), modelShortName)}
{/await}
