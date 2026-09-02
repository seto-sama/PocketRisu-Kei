<script lang="ts" module>
    type StickyAnchorCallback = (stuck: boolean) => void

    interface StickyAnchorObserverRecord {
        observer: IntersectionObserver
        callbacks: Map<Element, StickyAnchorCallback>
    }

    const stickyAnchorObservers = new WeakMap<HTMLElement, StickyAnchorObserverRecord>()

    function observeStickyAnchor(
        root: HTMLElement,
        anchor: HTMLElement,
        callback: StickyAnchorCallback,
    ) {
        let record = stickyAnchorObservers.get(root)
        if (!record) {
            const callbacks = new Map<Element, StickyAnchorCallback>()
            const observer = new IntersectionObserver((entries) => {
                let fallbackRootTop: number | undefined
                for (const entry of entries) {
                    const rootTop = entry.rootBounds?.top
                        ?? (fallbackRootTop ??= root.getBoundingClientRect().top)
                    callbacks.get(entry.target)?.(!entry.isIntersecting && entry.boundingClientRect.top <= rootTop)
                }
            }, { root, threshold: 0 })
            record = { observer, callbacks }
            stickyAnchorObservers.set(root, record)
        }

        record.callbacks.set(anchor, callback)
        record.observer.observe(anchor)

        return () => {
            record?.observer.unobserve(anchor)
            record?.callbacks.delete(anchor)
            if (record?.callbacks.size === 0) {
                record.observer.disconnect()
                stickyAnchorObservers.delete(root)
            }
        }
    }
</script>

<script lang="ts">
    import { ArrowLeftIcon, ArrowLeftRightIcon, ArrowRightIcon, BookmarkIcon, BotIcon, CircleQuestionMarkIcon, CopyIcon, ImagePlusIcon, MessageSquareOffIcon, MessageSquarePlusIcon, HamburgerIcon, LanguagesIcon, LinkIcon, MenuIcon, SquarePenIcon, RefreshCcwIcon, SplitIcon, TrashIcon, Volume2Icon, ScissorsIcon, EyeOffIcon } from "@lucide/svelte"
    import { aiLawApplies, changeChatTo, foldChatToMessage, getFileSrc, createPersistedChatCopy, requestImmediateSave } from "src/ts/globalApi.svelte"
    import { ColorSchemeTypeStore } from "src/ts/gui/colorscheme"
    import { DEFAULT_TEXT_SCREEN_COLOR } from "src/ts/gui/textOutline"
    import { getModelInfo } from "src/ts/model/modellist"
    import { runLuaButtonTrigger } from 'src/ts/process/scriptings'
    import { risuChatParser } from "src/ts/process/scripts"
    import { runTrigger } from 'src/ts/process/triggers'
    import { sayTTS } from "src/ts/process/tts"
    import { DBState, ReloadChatPointer, CurrentTriggerIdStore, invalidateChatMessageRender } from 'src/ts/stores.svelte'

    import { capitalize, getUserIcon, getUserName, sleep } from "src/ts/util"
    import { onDestroy, onMount, tick } from "svelte"
    import { type Unsubscriber } from "svelte/store"
    import { v4 as uuidv4, v4 } from 'uuid'
    import { language } from "../../lang"
    import { alertClear, alertConfirm, alertConfirmMulti, alertError, alertInput, alertRequestData, alertWait, notifyInfo, notifySuccess, type AlertAction } from "../../ts/alert"
    import { ParseMarkdown, type CbsConditions, type simpleCharacterArgument } from "../../ts/parser/parser.svelte"
    import { copyLLMCache, getLLMCache, setLLMCache } from "../../ts/translator/translator"
    import { getCurrentCharacter, getCurrentChat, getStickyChatToolbarVariant, normalizeChat, type MessageGenerationInfo } from "../../ts/storage/database.svelte"
    import { selectedCharID } from "../../ts/stores.svelte"
    import { HideIconStore, ReloadGUIPointer, selIdState } from "../../ts/stores.svelte"
    import TextAreaInput from "../UI/GUI/TextAreaInput.svelte"
    import ChatBody from './ChatBody.svelte'
    import PopupButton from "../UI/PopupButton.svelte";
    import { createRevenantChatTranslationRecovery, type RevenantChatTranslationRecoveryContext, type RevenantChatTranslationRecoveryScope } from "src/ts/process/revenant/recovery";
    import { resolveRequestDiagnosticContext } from "src/ts/requestDiagnostics";
    import type { RevenantChatMessageTranslationTarget } from "src/ts/process/revenant";
    import IconButton, { iconButtonSizeValues } from "../UI/GUI/IconButton.svelte";
    import IconButtonGroup from "../UI/GUI/IconButtonGroup.svelte";
    import { PRODUCT_NAME } from "src/ts/branding";
    import { createSubscriber } from "svelte/reactivity";
    import { hasSharedTranslationTask, subscribeSharedTranslationTaskChanges, subscribeTranslationResume } from "./chatBodyRenderController.svelte";
    import type { ChatScrollController } from "./chatScroll";
    import ChatAdaptiveAction from "./ChatAdaptiveAction.svelte";
    import ShDropdownMenuItem from "../UI/GUI/ShDropdownMenuItem.svelte";
    import ShTooltip from "../UI/GUI/ShTooltip.svelte";
    import {
        bookmarkKey,
        bookmarkKeys,
        createBookmark,
        deleteBookmark,
        ensureBookmarkCatalog,
    } from "src/ts/bookmarks/bookmarkService";
    import { canonicalizeInlayTokens } from "src/ts/util/inlayTokens";
    import { addGeneratedInlayToCharacter, GeneratedInlayAssetError, type GeneratedImageAssetTarget } from "src/ts/imageGeneration/addInlayToCharacter";
    import { isTextLikelyDifferentFromUiLanguage } from "src/ts/translator/textLanguage";

    let translating = $state(false)
    let editMode = $state(false)
    let editDraft = $state('')
    let statusMessage:string = $state('')
    let retranslate = $state(false)
    let editTranslationMode = $state(false)
    let editTranslationKeyMode = $state(false)
    let editTranslationText = $state('')
    let editTranslationCacheKey = $state<string | null>(null)
    let translationRevision = $state(0)
    let originalEditTranslationKey = $state<string | null>(null)
    let bodyRoot:HTMLElement|null = $state(null)
    let partialEditRoot: HTMLDivElement | null = $state(null)
    let floatingToolbarStuck = $state(false)
    const chatToolbarRowHeight = `${iconButtonSizeValues.lg.cell}px`
    const stickyChatToolbarVariant = $derived(getStickyChatToolbarVariant(DBState.db.theme))
    const generationInfoAlignsLeft = $derived(DBState.db.theme === '')
    const floatingToolbarBackground = $derived(
        DBState.db.theme === 'waifu'
            ? `${DBState.db.textScreenColor ?? DEFAULT_TEXT_SCREEN_COLOR}80`
            : 'color-mix(in srgb, var(--risu-theme-bgcolor) 72%, transparent)'
    )
    let activeTranslationTasks = 0
    let cancelTranslationRequest: (() => void) | null = $state(null)
    let autoTranslationSuppressed = $state(false)
    let messageEditTextAreaStyle = $derived(`font-size:${0.875 * (DBState.db.zoomsize / 100)}rem;line-height:${(DBState.db.lineHeight ?? 1.25) * (DBState.db.zoomsize / 100)}rem`)
    const translationDisabledClasses = 'disabled:opacity-50 disabled:cursor-not-allowed'
    interface Props {
        message?: string;
        name?: string;
        largePortrait?: boolean;
        img?: string|Promise<string>;
        idx?: number;
        messageGenerationInfo?: MessageGenerationInfo|null;
        rerollIcon?: boolean|'dynamic'|'force';
        role?: string;
        totalLength?: number;
        onReroll?: () => void;
        onNextSwipe?: () => void;
        unReroll?: () => void;
        onDeleteSwipe?: () => void;
        character?: simpleCharacterArgument|string|null;
        firstMessage?: boolean;
        altGreeting?: boolean;
        currentPage?: number;
        totalPages?: number;
        swipeNavigationOnly?: boolean;
        isStreamingDisplay?: boolean;
        generationOwned?: boolean;
        hideSender?: boolean;
        isComment?: boolean;
        disabled?: boolean | 'allBefore';
        renderCacheKey?: string;
        translationRecoveryContext?: RevenantChatTranslationRecoveryContext;
        translationRecoveryScope?: RevenantChatTranslationRecoveryScope | null;
        translationRecoveryTarget?: RevenantChatMessageTranslationTarget | null;
        getScrollController?: () => ChatScrollController | null;
        adjacentSwipeMessages?: readonly string[];
        isImageGeneration?: boolean;
        isLastMessage?: boolean;
    }

    let {
        message = '',
        name = '',
        largePortrait = false,
        img = '',
        idx = -1,
        rerollIcon = false,
        messageGenerationInfo = null,
        role = null,
        totalLength = 0,
        onReroll = () => {},
        onNextSwipe = () => {},
        unReroll = () => {},
        onDeleteSwipe = () => {},
        character = null,
        firstMessage = false,
        altGreeting = false,
        currentPage = 1,
        totalPages = 1,
        swipeNavigationOnly = false,
        isStreamingDisplay = false,
        generationOwned = false,
        hideSender = false,
        isComment = false,
        disabled = false,
        renderCacheKey = '',
        translationRecoveryContext,
        translationRecoveryScope,
        translationRecoveryTarget,
        getScrollController = () => null,
        adjacentSwipeMessages = [],
        isImageGeneration = false,
        isLastMessage = false,
    }: Props = $props();

    function toggleMessageRole() {
        const currentCharacter = DBState.db.characters[selIdState.selId]
        const currentMessage = currentCharacter?.chats[currentCharacter.chatPage]?.message?.[idx]
        if (!currentMessage) return
        currentMessage.role = currentMessage.role === 'char' ? 'user' : 'char'
        invalidateChatMessageRender(idx)
    }

    let addingImageGenerationAsset = $state(false)

    async function addImageGenerationAsset() {
        if (addingImageGenerationAsset) return
        const currentCharacter = DBState.db.characters[selIdState.selId]
        if (currentCharacter?.type !== 'character') return
        const currentMessage = currentCharacter.chats[currentCharacter.chatPage]?.message?.[idx]
        if (!currentMessage || currentMessage.kind !== 'imageGeneration') return

        addingImageGenerationAsset = true
        try {
            const actions: { id: GeneratedImageAssetTarget, label: string }[] = [
                { id: 'icon', label: language.charIcon },
                { id: 'emotion', label: language.emotionImage },
                { id: 'additional', label: language.additionalAssets },
            ]
            const selected = await alertConfirmMulti(language.addInlayImagePrompt, actions)
            if (selected < 0 || !actions[selected]) return

            await addGeneratedInlayToCharacter(currentMessage.data, currentCharacter, actions[selected].id)
            currentCharacter.reloadKeys = (currentCharacter.reloadKeys ?? 0) + 1
            await requestImmediateSave({ characterIds: [currentCharacter.chaId] })
            notifySuccess(language.inlayImageAddedToAssets)
        }
        catch (error) {
            alertError(error instanceof GeneratedInlayAssetError
                ? language.inlayGallery.inlayMissing
                : error)
        }
        finally {
            addingImageGenerationAsset = false
        }
    }

    let msgDisplay = $state('')
    let translated = $state(false)
    const lastOutputAutoTranslationEligible = $derived(
        DBState.db.autoTranslate === true
        && DBState.db.autoTranslateLastOutputOnly === true
        && !isStreamingDisplay
        && role === 'char'
        && isLastMessage
        && isTextLikelyDifferentFromUiLanguage(message, DBState.db.language)
    )
    const showFloatingToolbarDetails = $derived(Boolean(
        messageGenerationInfo && (DBState.db.requestInfoInsideChat || aiLawApplies())
        || DBState.db.translatorType === 'llm' && ((editMode && originalEditTranslationKey !== null) || translated)
    ))
    const translationTaskKey = $derived(renderCacheKey
        ? JSON.stringify([
            renderCacheKey,
            translationRecoveryTarget?.swipeId ?? (firstMessage ? currentPage - 1 : 0),
        ])
        : '')
    const translationSourceIdentity = $derived(JSON.stringify([
        renderCacheKey,
        translationRecoveryTarget?.messageChatId ?? null,
        translationRecoveryTarget?.swipeId ?? (firstMessage ? currentPage - 1 : 0),
    ]))
    let previousTranslationSource: {
        identity: string
        message: string
        streaming: boolean
    } | null = null
    let preservedTranslationMessage: string | null = null
    const trackSharedTranslationTasks = createSubscriber((update) =>
        subscribeSharedTranslationTaskChanges(update)
    )
    const sharedTranslationPending = $derived.by(() => {
        trackSharedTranslationTasks()
        return hasSharedTranslationTask(translationTaskKey)
    })

    async function rm(){
        if (generationOwned) return
        const messages = DBState.db.characters[selIdState.selId].chats[DBState.db.characters[selIdState.selId].chatPage].message
        const cascadeCount = messages.length - idx

        const actions: (AlertAction & { id: 'swipe' | 'message' | 'cascade' })[] = []
        if(totalPages > 1){
            actions.push({
                id: 'swipe',
                label: language.deleteRerollMessage,
                variant: 'destructive',
            })
        }
        actions.push({
            id: 'message',
            label: language.removeMessageOnly,
            variant: 'destructive',
        })
        if(cascadeCount > 1){
            actions.push({
                id: 'cascade',
                label: language.removeMessageAndAfter.replace('{}', cascadeCount.toString()),
                variant: 'destructive',
            })
        }
        const sel = await alertConfirmMulti(language.removeChat, actions)
        if(sel < 0) return
        const selectedAction = actions[sel]
        if(!selectedAction) return
        if(DBState.db.confirmMessageDelete && !(await alertConfirm(language.removeConfirm + selectedAction.label))){
            return
        }
        const action = selectedAction.id
        if(action === 'swipe'){
            // Deleting the selected swipe also navigates to the response that
            // takes its place. Use the same transition as the arrow controls
            // so cached-only auto translation inspects the new source text.
            changeSwipe(onDeleteSwipe)
            return
        }
        let msg = DBState.db.characters[selIdState.selId].chats[DBState.db.characters[selIdState.selId].chatPage].message
        if(action === 'cascade'){
            msg = msg.slice(0, idx)
            notifySuccess(language.messagesRemoved.replace('{}', cascadeCount.toString()))
        }
        else{
            msg.splice(idx, 1)
            notifySuccess(language.messageRemoved)
        }
        DBState.db.characters[selIdState.selId].chats[DBState.db.characters[selIdState.selId].chatPage].message = msg
    }

    async function edit(nextMessage:string){
        const msg = DBState.db.characters[selIdState.selId].chats[DBState.db.characters[selIdState.selId].chatPage].message[idx]
        const canonicalMessage = canonicalizeInlayTokens(nextMessage)
        msg.data = canonicalMessage
        if (msg.swipes && msg.swipeId !== undefined) {
            msg.swipes[msg.swipeId] = canonicalMessage
        }
    }

    async function preserveMessagePosition(update: () => void | Promise<void>) {
        const release = partialEditRoot
            ? getScrollController()?.preserveElementPosition(partialEditRoot, {
                edge: 'bottom',
                followLayout: true,
            })
            : undefined
        try {
            const updateResult = update()
            await updateResult
            // Commit the initial control DOM before handing later size changes
            // to the scroll controller's persistent follow-layout anchor.
            await tick()
        }
        finally {
            release?.()
        }
    }

    async function enterEditMode() {
        // Keep the editor independent from streaming/recovery prop updates.
        // Otherwise a parent refresh can replace every keystroke with the
        // latest server-owned display value.
        await preserveMessagePosition(() => {
            editDraft = message
            editTranslationKeyMode = false
            editMode = true
        })
        if (DBState.db.translatorType === 'llm') {
            const key = await getTranslationCacheKey()
            originalEditTranslationKey = await getLLMCache(key) === null ? null : key
            editTranslationKeyMode = originalEditTranslationKey !== null
        }
        else {
            editTranslationKeyMode = false
            originalEditTranslationKey = null
        }
    }

    async function saveOriginalEdit() {
        const oldKey = originalEditTranslationKey
        const shouldMigrateTranslationKey = editTranslationKeyMode
        const nextMessage = editDraft
        if (shouldMigrateTranslationKey && oldKey) {
            const nextDisplay = getDisplayMessage(nextMessage)
            const newKey = await getTranslationCacheKey(nextDisplay)
            // Populate the new key before publishing the edited source so the
            // reactive render never observes a transient cache miss.
            if (await copyLLMCache(oldKey, newKey)) {
                preservedTranslationMessage = nextMessage
            }
        }
        await preserveMessagePosition(async () => {
            editMode = false
            editTranslationKeyMode = false
            await edit(nextMessage)
            displaya(nextMessage)
        })

        originalEditTranslationKey = null
    }

    async function getTranslationPartialEditContext() {
        if (!translated || DBState.db.translatorType !== 'llm') {
            return null
        }

        const key = await getTranslationCacheKey()
        const data = await getLLMCache(key)
        if (data === null) {
            return null
        }

        return { key, data }
    }

    function handlePartialEditTranslationContext(event: Event) {
        const detail = (event as CustomEvent<{
            respond: (context: Promise<{ key: string; data: string } | null>) => void
        }>).detail
        detail.respond(getTranslationPartialEditContext())
    }

    async function handlePartialEditTranslationSave(event: Event) {
        const { key, data } = (event as CustomEvent<{ key: string; data: string }>).detail
        await setLLMCache(key, data)
        await preserveMessagePosition(() => {
            if (editTranslationMode) editTranslationText = data
            if (translated) translationRevision += 1
        })
    }

    function getCbsCondition(){
        try{
            const cbsConditions:CbsConditions = {
                firstmsg: firstMessage ?? false,
                chatRole: DBState.db.characters[selIdState.selId].chats[DBState.db.characters[selIdState.selId].chatPage]?.message?.[idx]?.role ?? role ?? null,
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

    async function getTranslationCacheKey(source = msgDisplay): Promise<string> {
        if(DBState.db.translateBeforeHTMLFormatting){
            return source
        }
        return await ParseMarkdown(source, character, 'pretranslate', idx, getCbsCondition())
    }

    function getTranslationTarget(): RevenantChatMessageTranslationTarget | null {
        if (translationRecoveryTarget !== undefined) {
            return translationRecoveryTarget
        }
        if (idx < 0) return null
        const currentCharacter = DBState.db.characters[selIdState.selId]
        const message = currentCharacter?.chats?.[currentCharacter.chatPage]?.message?.[idx]
        if (!message) return null
        return {
            kind: 'chat-message',
            messageChatId: message.chatId ?? null,
            messageIndex: idx,
            swipeId: message.swipeId ?? 0,
        }
    }

    const revenantTranslationRecovery = createRevenantChatTranslationRecovery({
        getTarget: getTranslationTarget,
        getScope: () => translationRecoveryScope,
        translationCache: {
            get: getLLMCache,
            store: setLLMCache,
        },
        getContext: () => translationRecoveryContext,
    })
    const revenantTranslationRecoverySnapshot = $derived.by(() =>
        revenantTranslationRecovery.capture()
    )
    const translationPending = $derived(
        (DBState.db.translatorType === 'llm'
            ? sharedTranslationPending && !autoTranslationSuppressed
            : translating)
        || (revenantTranslationRecoverySnapshot.pending && !autoTranslationSuppressed)
    )
    const revenantTranslationInspectionReady = $derived(
        revenantTranslationRecovery.inspectionReady
    )

    async function loadTranslationForEdit() {
        const key = await getTranslationCacheKey()
        const cached = await getLLMCache(key)
        await preserveMessagePosition(() => {
            editTranslationCacheKey = key
            editTranslationText = cached ?? ''
            editTranslationMode = true
        })
    }

    async function saveTranslationEdit() {
        const key = editTranslationCacheKey
        if (key === null) return
        await setLLMCache(key, editTranslationText)
        await preserveMessagePosition(() => {
            editTranslationMode = false
            editTranslationCacheKey = null
        })
    }

    async function cancelOriginalEdit() {
        await preserveMessagePosition(() => {
            editMode = false
            editTranslationKeyMode = false
            originalEditTranslationKey = null
        })
    }

    function isTranslationBusy() {
        return translationPending || retranslate
    }

    function isTranslationControlBusy() {
        return isTranslationBusy() || !revenantTranslationInspectionReady
    }

    const currentTextEditActive = $derived(editMode || editTranslationMode)
    const controlDisabled = $derived.by(() => ({
        translationToggle: generationOwned || currentTextEditActive
            || (isTranslationControlBusy() && cancelTranslationRequest === null),
        translationAction: generationOwned || currentTextEditActive || isTranslationControlBusy(),
        swipe: generationOwned || currentTextEditActive || isTranslationBusy(),
        edit: generationOwned || isTranslationBusy()
            || (translated
                && DBState.db.translatorType === 'llm'
                && !revenantTranslationInspectionReady),
        partialEdit: generationOwned || currentTextEditActive || isTranslationBusy(),
    }))

    function updateTranslationTasks(delta:1|-1) {
        activeTranslationTasks = Math.max(0, activeTranslationTasks + delta)
        translating = activeTranslationTasks > 0
    }

    async function reconcileCompletedTranslation(taskKeys: ReadonlySet<string>) {
        if (
            document.visibilityState === 'hidden'
            || DBState.db.translatorType !== 'llm'
            || !translated
            || !taskKeys.has(translationTaskKey)
        ) return

        const sourceIdentity = translationSourceIdentity
        const cacheKey = await getTranslationCacheKey()
        const cached = await getLLMCache(cacheKey)
        if (
            sourceIdentity !== translationSourceIdentity
            || hasSharedTranslationTask(translationTaskKey)
        ) return

        if (cached === null && revenantTranslationRecoverySnapshot.pending) return

        // Mobile browsers can suspend Svelte's DOM flush after the request has
        // durably populated the cache. Reconcile from that durable boundary on
        // resume. A missing result is also terminal once no local/shared or
        // recoverable task owns it; return to the original instead of leaving
        // loading markup stranded forever.
        activeTranslationTasks = 0
        translating = false
        cancelTranslationRequest = null
        retranslate = false
        if (cached === null) translated = false
        translationRevision += 1
    }

    function toggleTranslation() {
        if (!isTranslationControlBusy()) translated = !translated
    }

    function resetTranslationState() {
        translated = false
        retranslate = false
    }

    // Local controls and remote canonical sync both eventually replace this
    // message source. Reset at that shared boundary so a translated old swipe
    // cannot initiate a translation for the new one. Cached-only auto
    // translation may then inspect and restore the new swipe's existing cache.
    $effect.pre(() => {
        const nextSource = {
            identity: translationSourceIdentity,
            message,
            streaming: isStreamingDisplay,
        }
        const previousSource = previousTranslationSource
        previousTranslationSource = nextSource
        if (previousSource === null) {
            return
        }
        const identityChanged = previousSource.identity !== nextSource.identity
        const settledMessageChanged = !previousSource.streaming
            && !nextSource.streaming
            && previousSource.message !== nextSource.message
        if (!identityChanged && !settledMessageChanged) return
        const preserveTranslation = !identityChanged
            && settledMessageChanged
            && preservedTranslationMessage === nextSource.message
        preservedTranslationMessage = null
        if (preserveTranslation) {
            retranslate = false
            translationRevision += 1
            return
        }
        autoTranslationSuppressed = false
        cancelTranslationRequest?.()
        resetTranslationState()
        translationRevision += 1
    })

    async function handleTranslationButton() {
        if (currentTextEditActive) return
        await preserveMessagePosition(() => {
            if (isTranslationBusy()) {
                autoTranslationSuppressed = true
                cancelTranslationRequest?.()
                resetTranslationState()
                return
            }
            // Turning a completed translation off is also an explicit request
            // to keep showing the original. Turning it on clears that intent.
            autoTranslationSuppressed = translated
            toggleTranslation()
        })
    }

    async function requestRetranslation() {
        if (controlDisabled.translationAction) return
        await preserveMessagePosition(() => {
            retranslate = true
        })
    }

    async function changeSwipe(change: () => void) {
        if (controlDisabled.swipe) return
        await preserveMessagePosition(change)
    }

    async function toggleCurrentTextEdit() {
        if (isTranslationBusy()) return
        if (editTranslationMode) {
            await saveTranslationEdit()
            return
        }
        if (editMode) {
            await saveOriginalEdit()
            return
        }
        if (translated && DBState.db.translatorType === 'llm') {
            if (isTranslationControlBusy()) return
            await loadTranslationForEdit()
            return
        }
        await enterEditMode()
    }

    async function editOppositeText(event: MouseEvent) {
        // Only LLM translations have an editable translation cache. Preserve
        // the browser context menu for translators whose output cannot be
        // edited independently from the source message.
        if (DBState.db.translatorType !== 'llm') return
        event.preventDefault()
        if (isTranslationBusy()) return
        if (currentTextEditActive) {
            await toggleCurrentTextEdit()
            return
        }
        if (translated) {
            await enterEditMode()
            return
        }
        await loadTranslationForEdit()
    }

    function getDisplayMessage(message: string) {
        return risuChatParser(message, {chara: name, chatID: idx, rmVar: true, visualize: true, cbsConditions: getCbsCondition()})
    }

    function displaya(message:string){
        msgDisplay = getDisplayMessage(message)
    }

    const setStatusMessage = (message:string, timeout:number = 0)=>{
        statusMessage = message
        if(timeout === 0) return
        setTimeout(() => {
            statusMessage = ''
        }, timeout)
    }


    let blankMessage = $derived((message === '{{none}}' || message === '{{blank}}' || message === '') && idx === -1 && !altGreeting || isComment)
    const isBranchedFromComment = $derived(Boolean(isComment && message?.startsWith('{{specialcomment::branchedfrom::')))
    let nodeOnlyWidthClass = $derived(
        DBState.db.nodeOnlyStandardChatWidth === 'full' ? 'max-w-full' :
        DBState.db.nodeOnlyStandardChatWidth === 'wide' ? 'max-w-6xl' :
        'max-w-3xl'
    )

    function trackFloatingToolbar(node: HTMLElement) {
        const anchor = node.previousElementSibling as HTMLElement | null
        const scrollRoot = node.closest('.default-chat-screen') as HTMLElement | null
        if (!anchor || !scrollRoot || typeof IntersectionObserver === 'undefined') {
            floatingToolbarStuck = false
            return
        }

        const stopObserving = observeStickyAnchor(scrollRoot, anchor, (stuck) => {
            floatingToolbarStuck = stuck
        })

        return {
            destroy() {
                stopObserving()
                floatingToolbarStuck = false
            }
        }
    }

    $effect.pre(() => {
        displaya(message)
    });

    const unsubscribers:Unsubscriber[] = []

    onMount(()=>{
        unsubscribers.push(ReloadGUIPointer.subscribe((v) => {
            displaya(message)
        }))
        unsubscribers.push(subscribeTranslationResume((taskKeys) => {
            void reconcileCompletedTranslation(taskKeys).catch(error => {
                console.error('[Translation] Failed to reconcile resumed message:', error)
            })
        }))
    })

    onDestroy(()=>{
        unsubscribers.forEach(u => u())
    })

    $effect(() => {
        const root = partialEditRoot
        if (
            !root
            || (!DBState.db.enableBlockPartialEdit && !DBState.db.enableDragPartialEdit)
        ) return
        root.addEventListener('risu-partial-edit-translation-context', handlePartialEditTranslationContext)
        root.addEventListener('risu-partial-edit-translation-save', handlePartialEditTranslationSave)
        return () => {
            root.removeEventListener('risu-partial-edit-translation-context', handlePartialEditTranslationContext)
            root.removeEventListener('risu-partial-edit-translation-save', handlePartialEditTranslationSave)
        }
    })

    function RenderGUIHtml(html:string){
        try {
            const parser = new DOMParser()
            const doc = parser.parseFromString(risuChatParser(html ?? '', {cbsConditions: getCbsCondition()}), 'text/html')
            return doc.body   
        } catch (error) {
            const placeholder = document.createElement('div')
            return placeholder
        }
    }

    const renderedGuiHtml = $derived.by(() => {
        if (DBState.db.theme !== 'customHTML') {
            return null
        }

        return RenderGUIHtml(DBState.db.guiHTML)
    })

    async function handleButtonTriggerWithin(event: UIEvent) {
        const currentChar = getCurrentCharacter()
        if(!currentChar){
            return
        }
        const characterId = currentChar.chaId
        const currentChat = getCurrentChat()
        const roomId = currentChat?.id
        if (!characterId || !roomId) return

        const target = event.target as HTMLElement
        const origin = target.closest('[risu-trigger], [risu-btn]')
        if (!origin) {
            return
        }

        const triggerName = origin.getAttribute('risu-trigger')
        const triggerId = origin.getAttribute('risu-id')
        const btnEvent = origin.getAttribute('risu-btn')

        // A trigger may update reactive Lua/CBS state before its promise
        // returns. Disable translation first so an intermediate render cannot
        // start a new automatic translation request.
        resetTranslationState()

        const triggerResult =
            triggerName ?
                await runTrigger(currentChar, 'manual', {
                    chat: currentChat,
                    manualName: triggerName,
                    triggerId: triggerId || undefined,
                }) :
            btnEvent ?
                await runLuaButtonTrigger(currentChar, btnEvent) :
            null

        if(triggerResult) {
            const targetCharacter = DBState.db.characters.find(character =>
                character?.chaId === characterId)
            const targetChatIndex = targetCharacter?.chats?.findIndex(chat =>
                chat?.id === roomId) ?? -1
            if (targetCharacter && targetChatIndex >= 0) {
                targetCharacter.chats[targetChatIndex] = normalizeChat(triggerResult.chat)
            }
            invalidateChatMessageRender(idx)
        }
        
        if(triggerName && triggerId) {
            setTimeout(() => {
                CurrentTriggerIdStore.set(null)
            }, 100) // Small delay to allow display mode to complete
        }
    }

    let bookmarkTarget = $derived.by(() => {
        const character = DBState.db.characters[selIdState.selId]
        const chat = character?.chats[character.chatPage]
        const messageId = chat?.message[idx]?.chatId
        return character?.chaId && chat?.id && messageId
            ? { characterId: character.chaId, chatId: chat.id, messageId }
            : null
    })
    let isBookmarked = $derived(bookmarkTarget ? $bookmarkKeys.has(bookmarkKey(bookmarkTarget)) : false)

    async function toggleBookmark() {
        await ensureBookmarkCatalog()
        const chat = DBState.db.characters[selIdState.selId].chats[DBState.db.characters[selIdState.selId].chatPage];
        
        if(!chat.message[idx]) return;

        let messageId = chat.message[idx]?.chatId;
        const messageContent = chat.message[idx]?.data;

        const assignedMessageId = !messageId;
        if (assignedMessageId) {
            messageId = uuidv4();
            chat.message[idx].chatId = messageId;
        }

        const characterId = DBState.db.characters[selIdState.selId].chaId;
        const target = { characterId, chatId: chat.id, messageId };
        if (assignedMessageId) {
            await requestImmediateSave({
                characterIds: [characterId],
                chatTargets: [{ characterId, chatId: chat.id }],
            })
        }
        if (isBookmarked) {
            await deleteBookmark(target);
        } else {
            const msgSender = chat.message[idx]?.role === 'user' ? getUserName() : name;
            const newName= await alertInput(language.bookmarkAskNameOrDefault, [], '');
            let bookmarkName: string;

            if (newName && newName.trim() !== '') {
                bookmarkName = newName.trim();
            } else {
                let defaultName;

                const blacklist = ['!', '@', '#', '$', '%', '^', '&', '*', '(', ')', '_', '+', '-', '=', '[', ']', '{', '}', '|', ';', ':', '"', "'", ',', '.', '<', '>', '/', '?'];
                let lines = messageContent.split('\n');
                lines = lines.splice(Math.floor(lines.length * 0.5));
                for (const line of lines) {
                    if (line && !blacklist.some(char => line.startsWith(char))) {
                        defaultName = line.trim().slice(0, 50) + '...';
                        break;
                    }
                }
                if (!defaultName) {
                    defaultName = messageContent.slice(0, 50) + '...';
                }
                bookmarkName = msgSender + '| ' + defaultName;
            }
            await createBookmark(target, bookmarkName);
        }
    }
</script>


{#snippet genInfo()}
    <IconButtonGroup
        size="lg"
        className={`chat-generation-info flex-wrap gap-1 ${generationInfoAlignsLeft ? 'justify-start' : 'chat-width w-full justify-end'}`}
        style="min-height:var(--icon-cell-size)"
    >
        {#if messageGenerationInfo && (DBState.db.requestInfoInsideChat || aiLawApplies())}
            {@const diagnosticMessage = idx >= 0
                ? DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage].message[idx]
                : undefined}
            {@const diagnosticGenerationInfo = diagnosticMessage
                ? resolveRequestDiagnosticContext(diagnosticMessage, messageGenerationInfo).generationInfo
                : messageGenerationInfo}
            {@const modelLabel = diagnosticGenerationInfo?.model
                ? capitalize(getModelInfo(diagnosticGenerationInfo.model).shortName.replace(/^pluginmodel:::/, ''))
                : language.requestDiagnostics.unavailable}
            <IconButton
                expanded
                className={`text-sm ${generationInfoAlignsLeft ? '' : 'order-last'}`}
                aria-label={modelLabel}
                title={modelLabel}
                onclick={() => {
                    alertRequestData({
                        genInfo: diagnosticGenerationInfo ?? {},
                        idx: idx,
                    })
                }}
            >
                <BotIcon />
                <span class="hidden max-w-[288px] truncate sm:inline">
                    {modelLabel}
                </span>
            </IconButton>
        {/if}
        {#if DBState.db.translatorType === 'llm'}
            {#if editMode && originalEditTranslationKey !== null}
                <IconButton
                    expanded
                    className="button-icon-keep-translation text-sm"
                    active={editTranslationKeyMode}
                    activeColor="primary"
                    disabled={generationOwned || isTranslationBusy()}
                    aria-label={language.keepTranslation}
                    title={language.keepTranslation}
                    onclick={() => { editTranslationKeyMode = !editTranslationKeyMode }}
                >
                    <LinkIcon />
                    <span>{language.keepTranslation}</span>
                </IconButton>
            {:else if translated}
                <IconButton
                    expanded
                    className="text-sm"
                    disabled={controlDisabled.translationAction}
                    aria-label={language.retranslate}
                    title={language.retranslate}
                    onclick={requestRetranslation}
                >
                    <RefreshCcwIcon />
                    <span>{language.retranslate}</span>
                </IconButton>
            {/if}
        {/if}
    </IconButtonGroup>
{/snippet}

{#snippet floatingChatToolbar()}
    <div
        class="chat-toolbar-sticky-layer chat-toolbar-floating-layer"
        class:chat-toolbar-is-stuck={floatingToolbarStuck}
        use:trackFloatingToolbar
    >
        <div class="chat-toolbar-floating-card" style:--chat-toolbar-floating-bg={floatingToolbarBackground}>
            <div class="chat-message-actions chat-toolbar-actions">
                {@render iconButtons()}
            </div>
            {#if showFloatingToolbarDetails}
                <div class="chat-toolbar-generation-info">
                    {@render genInfo()}
                </div>
            {/if}
        </div>
    </div>
{/snippet}

{#snippet stickyChatFooter()}
    <div
        class="chat-toolbar-sticky-layer chat-toolbar-sticky-footer-layer"
        class:chat-toolbar-above-fixed-composer={DBState.db.fixedChatTextarea}
    >
        <div class="chat-toolbar-sticky-footer">
            <div class="chat-toolbar-sticky-footer-content">
                <div class="chat-toolbar-generation-info">
                    {@render genInfo()}
                </div>
                <div class="chat-message-actions chat-toolbar-actions">
                    {@render iconButtons()}
                </div>
            </div>
        </div>
    </div>
{/snippet}

{#snippet textBox()}
    {#if editTranslationMode}
        <TextAreaInput bind:value={editTranslationText} commitMode="input" autoResize actionBar={false} fullwidth padding={false} contentClassName="p-2 message-edit-area" style={messageEditTextAreaStyle} onLongPress={() => {
            saveTranslationEdit()
        }} />
    {:else if editMode}
        <TextAreaInput bind:value={editDraft} commitMode="input" autoResize actionBar={false} fullwidth padding={false} contentClassName="p-2 message-edit-area" style={messageEditTextAreaStyle} onLongPress={() => {
            void cancelOriginalEdit()
        }} />
    {:else if isComment}
        <div class={{
            "flex justify-center text-textcolor2 italic": true,
            "branched-from-comment-text": isBranchedFromComment,
            "min-w-0 text-sm leading-5": isBranchedFromComment,
            "w-full mb-12": !isBranchedFromComment,
        }}>

            {#if msgDisplay.startsWith('{{specialcomment')}
                {@const parts = msgDisplay.split('::')}
                {@const type = parts[1]}

                {#if type === 'branchedfrom'}
                    <button class="min-w-0 text-center text-primary hover:underline"
                        onclick={() => {
                            changeChatTo(parts[2] ?? '')
                            foldChatToMessage(parts[4])
                        }}
                    >
                        {language.branchedText.replace("{}", parts[3] ?? '')}
                    </button>
                {/if}
            {:else}
                {msgDisplay}
            {/if}
        </div>
    {:else if blankMessage}
        <div class="w-full flex justify-center text-textcolor2 italic mb-12">
            {language.noMessage}
        </div>
    {:else}
        <!-- Streaming content is already propagated through the reactive message
             prop. Remounting ChatBody for every chunk resets the browser's scroll
             anchor and pulls a user who is reading history back to the bottom. -->
        {@const chatReloadPointer = `${$ReloadGUIPointer}|${isStreamingDisplay ? 0 : ($ReloadChatPointer[idx] ?? 0)}`}
        {@const totalLengthPointer = (idx > totalLength - 6) ? totalLength : 0}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <span class="text chat-width chattext prose minw-0"
            class:prose-invert={$ColorSchemeTypeStore === 'dark'}
            bind:this={bodyRoot}
            onclick={async () => {
            if(DBState.db.clickToEdit && idx > -1 && !controlDisabled.partialEdit){
                await enterEditMode()
            }
        }}
            style:font-size="{0.875 * (DBState.db.zoomsize / 100)}rem"
            style:line-height="{(DBState.db.lineHeight ?? 1.25) * (DBState.db.zoomsize / 100)}rem"
        >
            <ChatBody
                {character}
                {firstMessage}
                {idx}
                {msgDisplay}
                {name}
                {bodyRoot}
                {translationRevision}
                {isStreamingDisplay}
                {translationTaskKey}
                renderRevision={`${totalLengthPointer}|${chatReloadPointer}`}
                renderCacheKey={renderCacheKey ? `${renderCacheKey}|${totalLengthPointer}|${chatReloadPointer}` : ''}
                {revenantTranslationRecovery}
                {revenantTranslationRecoverySnapshot}
                {translationPending}
                {autoTranslationSuppressed}
                {lastOutputAutoTranslationEligible}
                {adjacentSwipeMessages}
                modelShortName={
                    messageGenerationInfo ? getModelInfo(messageGenerationInfo?.model).shortName : ''
                }
                role={role ?? null}
                onTranslationTaskChange={updateTranslationTasks}
                onTranslationCancelAvailabilityChange={(cancel) => cancelTranslationRequest = cancel}
                bind:translated={translated}
                bind:retranslate={retranslate} />
        </span>
    {/if}
{/snippet}

{#snippet branchedFromCommentRow()}
    <div class="branched-from-comment-row grid w-full min-w-0 grid-cols-[2.5rem_minmax(0,1fr)_2.5rem] items-center py-1">
        <span aria-hidden="true"></span>
        <div class="min-w-0">
            {@render textBox()}
        </div>
        <div class="flex justify-center">
            {@render iconButtons({grow: false, compactComment: true})}
        </div>
    </div>
{/snippet}

{#snippet iconButtons(options:{applyTextColors?:boolean; grow?:boolean; compactComment?:boolean} = {})}
    <div class="flex items-center justify-end" class:grow={options.grow !== false} class:text-textcolor2={options.applyTextColors !== false}>
        {#if isComment}
            <IconButton
                size={options.compactComment ? "default" : "lg"}
                tone="destructive"
                className="button-icon-remove"
                onclick={async () => {
                    await rm()
                }}
            >
                <TrashIcon />
            </IconButton>
        {:else}
            <span class="text-xs">{statusMessage}</span>
            <IconButtonGroup size="lg" className="ml-2 flex-wrap justify-end">
                {#if window.innerWidth >= 640}
                    {@render ttsButton(false)}
                    {@render translationButton()}
                    {@render copyButton(false)}
                    {@render deleteButton(false)}
                    {#if DBState.db.characters[selIdState.selId] && idx > -1}
                        <PopupButton>
                            {@render minorMenuItems()}
                        </PopupButton>
                    {/if}
                {:else}
                    {@render translationButton()}
                    {#if DBState.db.characters[selIdState.selId] && idx > -1}
                        <PopupButton>
                            {@render copyButton(true)}
                            {@render ttsButton(true)}
                            {@render deleteButton(true)}
                            {@render minorMenuItems()}
                        </PopupButton>
                    {:else}
                        {@render copyButton(false)}
                        {@render ttsButton(false)}
                        {@render deleteButton(false)}
                    {/if}
                {/if}
                {#if firstMessage}
                    <IconButton className={disabled === true ? 'text-draculared' : ''} onclick={async () => {
                        await sleep(1)
                        const chat = DBState.db.characters[selIdState.selId].chats[DBState.db.characters[selIdState.selId].chatPage]
                        if(chat.firstMessageDisabled){
                            chat.firstMessageDisabled = false
                        } else if(await alertConfirm(language.disableFirstMessageConfirm)){
                            chat.firstMessageDisabled = true
                        }
                    }}>
                        <EyeOffIcon />
                    </IconButton>
                {/if}
                <IconButtonGroup size="lg" className={isTranslationBusy() ? 'opacity-50' : ''}>
                    {@render rerolls()}
                </IconButtonGroup>
            </IconButtonGroup>
        {/if}
    </div>
{/snippet}


{#snippet copyButton(showNames:boolean)}
    {#if !blankMessage}
    <ChatAdaptiveAction menu={showNames} className="button-icon-copy" onclick={async ()=>{
        if(window.navigator.clipboard.write){
            try {
                alertWait(language.loading)
                const root = document.querySelector(':root') as HTMLElement;

                const parser = new DOMParser()
                const doc = parser.parseFromString(
                    await ParseMarkdown(msgDisplay, getCurrentCharacter(), 'normal', idx, getCbsCondition())
                , 'text/html')
                
                doc.querySelectorAll('mark').forEach((el) => {
                    const d = el.getAttribute('risu-mark')
                    if(d === 'quote1' || d === 'quote2'){
                        const newEle = document.createElement('div')
                        newEle.textContent = el.textContent
                        newEle.setAttribute('style', `background: transparent; color: ${
                            root.style.getPropertyValue('--FontColorQuote' + d.slice(-1))
                        };`)
                        el.replaceWith(newEle)
                        return
                    }
                })
                doc.querySelectorAll('p').forEach((el) => {
                    el.setAttribute('style', `color: ${root.style.getPropertyValue('--FontColorStandard')};`)
                })
                doc.querySelectorAll('em').forEach((el) => {
                    el.setAttribute('style', `font-style: italic; color: ${root.style.getPropertyValue('--FontColorItalic')};`)
                })
                doc.querySelectorAll('strong').forEach((el) => {
                    el.setAttribute('style', `font-weight: bold; color: ${root.style.getPropertyValue('--FontColorBold')};`)
                })
                doc.querySelectorAll('em strong').forEach((el) => {
                    el.setAttribute('style', `font-weight: bold; font-style: italic; color: ${root.style.getPropertyValue('--FontColorItalicBold')};`)
                })
                doc.querySelectorAll('strong em').forEach((el) => {
                    el.setAttribute('style', `font-weight: bold; font-style: italic; color: ${root.style.getPropertyValue('--FontColorItalicBold')};`)
                })
                
                const imgs = doc.querySelectorAll('img')
                for(const img of imgs){
                    img.setAttribute('alt', `from ${PRODUCT_NAME}`)
                    const url = img.getAttribute('src')
                    
                    img.setAttribute('style', `
                        max-width: 100%;
                        margin: 10px 0;
                        border-radius: 8px;
                        display: block;
                        margin-left: auto;
                        margin-right: auto;
                    `)
                    
                    if(url && (url.startsWith('http://asset.localhost') || url.startsWith('https://asset.localhost') || url.startsWith('https://sv.risuai') || url.startsWith('data:') || url.startsWith('http') || url.startsWith('/'))){
                        try {
                            let fetchUrl = url
                            if(url.startsWith('/')) {
                                fetchUrl = window.location.origin + url
                            }
                            
                            const data = await fetch(fetchUrl)
                            if (data.ok) {
                                const canvas = document.createElement('canvas')
                                const ctx = canvas.getContext('2d')
                                const imgElement = new Image()
                                imgElement.crossOrigin = 'anonymous'
                                imgElement.src = await data.blob().then((b) => new Promise((resolve, reject) => {
                                    const reader = new FileReader()
                                    reader.onload = () => resolve(reader.result as string)
                                    reader.onerror = reject
                                    reader.readAsDataURL(b)
                                }))
                                await new Promise((resolve) => {
                                    imgElement.onload = resolve
                                })
                                canvas.width = imgElement.width
                                canvas.height = imgElement.height
                                ctx.drawImage(imgElement, 0, 0)
                                const dataURL = canvas.toDataURL('image/jpeg', 0.6)
                                img.setAttribute('src', dataURL)
                            }
                        } catch (error) {
                            console.error('Image error:', error)
                        }
                    }
                }

                let iconDataUrl = ''
                let hasValidImage = false
                
                try {
                    const iconImage = (await getFileSrc(DBState.db.characters[selIdState.selId].image ?? '')) ?? ''
                    
                    if(iconImage && (iconImage.startsWith('http://asset.localhost') || iconImage.startsWith('https://asset.localhost') || iconImage.startsWith('https://sv.risuai') || iconImage.startsWith('data:') || iconImage.startsWith('http') || iconImage.startsWith('/'))){
                        if(iconImage.startsWith('data:')){
                            iconDataUrl = iconImage
                            hasValidImage = true
                        } else {
                            const data = await fetch(iconImage)
                            if (data.ok) {
                                const canvas = document.createElement('canvas')
                                const ctx = canvas.getContext('2d')
                                const img = new Image()
                                img.crossOrigin = 'anonymous'
                                img.src = await data.blob().then((b) => new Promise((resolve, reject) => {
                                    const reader = new FileReader()
                                    reader.onload = () => resolve(reader.result as string)
                                    reader.onerror = reject
                                    reader.readAsDataURL(b)
                                }))
                                await new Promise((resolve, reject) => {
                                    img.onload = () => {
                                        canvas.width = img.width
                                        canvas.height = img.height
                                        ctx.drawImage(img, 0, 0)
                                        iconDataUrl = canvas.toDataURL('image/jpeg', 0.9)
                                        hasValidImage = true
                                        resolve(true)
                                    }
                                    img.onerror = () => {
                                        hasValidImage = false
                                        resolve(false)
                                    }
                                })
                            }
                        }
                    }
                } catch (error) {
                    console.error('Icon error:', error)
                    hasValidImage = false
                }

                const isUserMessage = role === 'user'
                const displayName = isUserMessage ? getUserName() : name
                const modelInfo = messageGenerationInfo ? capitalize(getModelInfo(messageGenerationInfo.model).shortName) : (isUserMessage ? 'User' : 'AI')
                
                let finalIconDataUrl = iconDataUrl
                let finalHasValidImage = hasValidImage
                
                if (isUserMessage) {
                    finalHasValidImage = false
                    const userIcon = getUserIcon()
                    if (userIcon) {
                        try {
                            const userIconSrc = await getFileSrc(userIcon)
                            if (userIconSrc && (userIconSrc.startsWith('http://asset.localhost') || userIconSrc.startsWith('https://asset.localhost') || userIconSrc.startsWith('https://sv.risuai') || userIconSrc.startsWith('data:') || userIconSrc.startsWith('http') || userIconSrc.startsWith('/'))) {
                                if (userIconSrc.startsWith('data:')) {
                                    finalIconDataUrl = userIconSrc
                                    finalHasValidImage = true
                                } else {
                                    const data = await fetch(userIconSrc)
                                    if (data.ok) {
                                        const canvas = document.createElement('canvas')
                                        const ctx = canvas.getContext('2d')
                                        const img = new Image()
                                        img.crossOrigin = 'anonymous'
                                        img.src = await data.blob().then((b) => new Promise((resolve, reject) => {
                                            const reader = new FileReader()
                                            reader.onload = () => resolve(reader.result as string)
                                            reader.onerror = reject
                                            reader.readAsDataURL(b)
                                        }))
                                        await new Promise((resolve, reject) => {
                                            img.onload = () => {
                                                canvas.width = img.width
                                                canvas.height = img.height
                                                ctx.drawImage(img, 0, 0)
                                                finalIconDataUrl = canvas.toDataURL('image/jpeg', 0.9)
                                                finalHasValidImage = true
                                                resolve(true)
                                            }
                                            img.onerror = () => {
                                                finalHasValidImage = false
                                                resolve(false)
                                            }
                                        })
                                    }
                                }
                            }
                        } catch (error) {
                            console.error('User icon error:', error)
                            finalHasValidImage = false
                        }
                    }
                }
                
                const html = `<div style="font-family: 'Segoe UI', Roboto, Arial, sans-serif; color: ${root.style.getPropertyValue('--risu-theme-textcolor')}; line-height: 1.6; max-width: 600px; margin: 1rem auto; background: ${root.style.getPropertyValue('--risu-theme-bgcolor')}; border-radius: 12px; overflow: hidden;">
<div style="padding: 20px;">
<div style="display: flex; flex-direction: column; align-items: center; margin-bottom: 1rem; text-align: center;">
    ${finalHasValidImage ? `<img style="width: 80px; height: 80px; border-radius: 50%; border: 3px solid ${root.style.getPropertyValue('--risu-theme-darkborderc')}; margin-bottom: 0.75rem; object-fit: cover;" src="${finalIconDataUrl}" alt="profile">` : ''}
    <h3 style="color: ${root.style.getPropertyValue('--risu-theme-textcolor')}; font-weight: 600; font-size: 1.5rem; margin: 0 0 0.5rem 0;">${displayName}</h3>
    ${!isUserMessage ? `<span style="display: inline-block; border-radius: 16px; font-size: 0.8rem; padding: 0.25rem 0.75rem; background: ${root.style.getPropertyValue('--risu-theme-darkbg')}; color: ${root.style.getPropertyValue('--risu-theme-textcolor')}; border: 1px solid ${root.style.getPropertyValue('--risu-theme-darkborderc')};">${modelInfo}</span>` : ''}
</div>
<div style="border-top: 1px solid ${root.style.getPropertyValue('--risu-theme-darkborderc')}; padding-top: 1rem;">
    ${doc.body.innerHTML}
</div>
<div style="text-align: center; margin-top: 1rem; padding-top: 0.75rem; border-top: 1px solid ${root.style.getPropertyValue('--risu-theme-darkborderc')};">
    <span style="font-size: 0.75rem; color: ${root.style.getPropertyValue('--risu-theme-textcolor2')}; opacity: 0.7;">From ${PRODUCT_NAME}</span>
</div>
</div>
</div>`

                await window.navigator.clipboard.write([
                    new ClipboardItem({
                        'text/plain': new Blob([msgDisplay], {type: 'text/plain'}),
                        'text/html': new Blob([html], {type: 'text/html'})
                    })
                ])
                notifyInfo(language.copied)
                return
            }
            catch (e) {
                alertClear()
                window.navigator.clipboard.writeText(msgDisplay).then(() => {
                    setStatusMessage(language.copied)
                })
            }
        }
        window.navigator.clipboard.writeText(msgDisplay).then(() => {
            setStatusMessage(language.copied)
        })
    }}>
        <CopyIcon />
        {#if showNames}
            <span>{language.copy}</span>
        {/if}
    </ChatAdaptiveAction>
    {/if}
{/snippet}

{#snippet ttsButton(showNames:boolean)}
    {#if idx > -1 && DBState.db.ttsEnabled && DBState.db.characters[selIdState.selId].ttsMode !== 'none' && DBState.db.characters[selIdState.selId].ttsMode}
        <ChatAdaptiveAction menu={showNames} className="button-icon-tts" onclick={()=>{
            return sayTTS(null, message)
        }}>
            <Volume2Icon />
            {#if showNames}
                <span>TTS</span>
            {/if}
        </ChatAdaptiveAction>
    {/if}
{/snippet}

{#snippet deleteButton(showNames:boolean)}
    {#if idx > -1}
    <ChatAdaptiveAction menu={showNames} tone="destructive" className="button-icon-remove" disabled={generationOwned} onclick={rm}>
        <TrashIcon />

        {#if showNames}
            <span>{language.remove}</span>
        {/if}
    </ChatAdaptiveAction>
    {/if}
{/snippet}

{#snippet translationButton(showNames = false)}
    {#if DBState.db.translator !== '' && !blankMessage}
        <IconButton
            size="lg"
            expanded={showNames}
            active={translated}
            activeColor="primary"
             tone={cancelTranslationRequest ? 'destructive' : 'default'}
             className={"button-icon-translate " + translationDisabledClasses + (translationPending ? ' translating' : '')}
             disabled={controlDisabled.translationToggle}
            aria-label={cancelTranslationRequest ? language.cancel : language.translate}
            title={cancelTranslationRequest ? language.cancel : language.translate}
            onclick={handleTranslationButton}>
            <LanguagesIcon />
            {#if showNames}
                <span class="ml-1">{cancelTranslationRequest ? language.cancel : language.translate}</span>
            {/if}
        </IconButton>
    {/if}
    {#if idx > -1}
        <IconButton
            size="lg"
            expanded={showNames}
            active={currentTextEditActive}
            activeColor="primary"
            className={"button-icon-edit " + translationDisabledClasses}
            disabled={controlDisabled.edit}
            aria-label={translated && DBState.db.translatorType === 'llm' ? language.editTranslation : language.edit}
            title={translated && DBState.db.translatorType === 'llm' ? language.editTranslation : language.edit}
            onclick={toggleCurrentTextEdit}
            oncontextmenu={editOppositeText}>
            <SquarePenIcon />

            {#if showNames}
                <span class="ml-1">{language.edit}</span>
            {/if}
        </IconButton>
    {/if}
{/snippet}

{#snippet rerolls()}
    {#if (rerollIcon || altGreeting) && role !== 'user'}
        <fieldset class="contents" disabled={controlDisabled.swipe}>
        {#if altGreeting}
            <!-- First message: ← counter → -->
            <IconButton size="lg" className="button-icon-unreroll" onclick={() => changeSwipe(unReroll)}>
                <ArrowLeftIcon />
            </IconButton>
            {#if !DBState.db.hideMessagePageCount}
                <span class="flex items-center text-xs text-textcolor2 shrink overflow-hidden whitespace-nowrap min-w-0">{currentPage}/{totalPages}</span>
            {/if}
            <IconButton size="lg" className="button-icon-reroll" onclick={() => changeSwipe(onReroll)}>
                <ArrowRightIcon />
            </IconButton>
        {:else}
            <!-- Normal messages: ← counter → ↻ -->
            <IconButton size="lg" className={'button-icon-unreroll ' + ((rerollIcon === 'dynamic' || rerollIcon === 'force') ? 'dyna-icon ' : '') + (rerollIcon === 'force' ? 'force-show' : '')} onclick={async () => {
                if (swipeNavigationOnly) {
                    if (totalPages > 1) changeSwipe(unReroll)
                } else if (totalPages <= 1) {
                    if (!DBState.db.confirmReroll || await alertConfirm(language.noSwipesRerollConfirm)) onReroll()
                } else {
                    changeSwipe(unReroll)
                }
            }}>
                <ArrowLeftIcon />
            </IconButton>
            {#if !DBState.db.hideMessagePageCount}
                <span class="flex items-center text-xs text-textcolor2 shrink overflow-hidden whitespace-nowrap min-w-0" class:dyna-icon={rerollIcon === 'dynamic' || rerollIcon === 'force'} class:force-show={rerollIcon === 'force'}>{currentPage}/{totalPages}</span>
            {/if}
            <IconButton size="lg" className={'button-icon-reroll ' + ((rerollIcon === 'dynamic' || rerollIcon === 'force') ? 'dyna-icon ' : '') + (rerollIcon === 'force' ? 'force-show' : '')} onclick={async () => {
                if (swipeNavigationOnly) {
                    if (totalPages > 1) changeSwipe(onNextSwipe)
                } else if (totalPages <= 1) {
                    if (!DBState.db.confirmReroll || await alertConfirm(language.noSwipesRerollConfirm)) onReroll()
                } else {
                    changeSwipe(onNextSwipe)
                }
            }}>
                <ArrowRightIcon />
            </IconButton>
            {#if !swipeNavigationOnly}
                <IconButton size="lg" className={'button-icon-reroll ' + ((rerollIcon === 'dynamic' || rerollIcon === 'force') ? 'dyna-icon ' : '') + (rerollIcon === 'force' ? 'force-show' : '')} onclick={async () => {
                    if (!DBState.db.confirmReroll || await alertConfirm(language.rerollConfirm)) onReroll()
                }}>
                    <RefreshCcwIcon />
                </IconButton>
            {/if}
        {/if}
        </fieldset>
    {/if}
{/snippet}

{#snippet minorMenuItems()}
    {#if idx > -1}
        {#if isImageGeneration}
            <ShDropdownMenuItem disabled={generationOwned || addingImageGenerationAsset} onSelect={addImageGenerationAsset}>
                <ImagePlusIcon />
                <span>{language.addInlayImageToAssets}</span>
            </ShDropdownMenuItem>
        {:else}
            <ShDropdownMenuItem disabled={generationOwned} onSelect={toggleMessageRole}>
                <ArrowLeftRightIcon />
                <span>{language.changeMessageRole}</span>
            </ShDropdownMenuItem>
        {/if}

        <ShDropdownMenuItem disabled={generationOwned} class={isBookmarked ? 'button-icon-bookmark text-primary' : 'button-icon-bookmark'} onSelect={toggleBookmark}>
            <BookmarkIcon />
            <span>{language.bookmark}</span>
        </ShDropdownMenuItem>

    <ShDropdownMenuItem disabled={generationOwned} onSelect={async () => {
        const currentChat = DBState.db.characters[selIdState.selId].chats[DBState.db.characters[selIdState.selId].chatPage]

        if(DBState.db.createFolderOnBranch && !currentChat.folderId){
            const folderId = v4()
            DBState.db.characters[selIdState.selId].chatFolders ??= []
            DBState.db.characters[selIdState.selId].chatFolders.unshift({
                id: folderId,
                name: `Branches of ${currentChat.name}`,
                folded: false,
            })
            currentChat.folderId = folderId
        }
        
        const currentMessage = currentChat.message[idx]
        try {
            await createPersistedChatCopy(
                DBState.db.characters[selIdState.selId],
                currentChat,
                'Branch',
                newChat => {
                    newChat.message = newChat.message.slice(0, idx + 1)
                    newChat.message.push({
                        role: 'char',
                        data: '{{specialcomment::branchedfrom::' + currentChat.id + '::' + currentChat.name + '::' + currentMessage.chatId + '::}}',
                        isComment: true,
                        disabled: true,
                        chatId: v4(),
                    })
                },
            )
        } catch (error) {
            alertError(error)
        }
    }}>
        <SplitIcon />
        <span>{language.branch}</span>
    </ShDropdownMenuItem>

    <ShDropdownMenuItem disabled={generationOwned} onSelect={() => {
        const currentMessage = DBState.db.characters[selIdState.selId].chats[DBState.db.characters[selIdState.selId].chatPage].message[idx]
        DBState.db.characters[selIdState.selId].chats[DBState.db.characters[selIdState.selId].chatPage].message[idx].disabled = !currentMessage.disabled
    }}>
        {#if disabled === true}
            <MessageSquarePlusIcon />
        {:else}
            <MessageSquareOffIcon />
        {/if}
        <span>{disabled === true ? language.enableMessage : language.disableMessage}</span>
    </ShDropdownMenuItem>

    <ShDropdownMenuItem disabled={generationOwned} onSelect={() => {
        const currentMessage = DBState.db.characters[selIdState.selId].chats[DBState.db.characters[selIdState.selId].chatPage].message[idx]
        DBState.db.characters[selIdState.selId].chats[DBState.db.characters[selIdState.selId].chatPage].message[idx].disabled = currentMessage.disabled === 'allBefore' ? false : 'allBefore'
    }}>
        <ScissorsIcon />
        <span>{language.disableAbove}</span>
        <ShTooltip>
            {#snippet trigger(props)}
                <button
                    {...props}
                    type="button"
                    class="ml-auto inline-flex items-center border-0 bg-transparent p-0 text-textcolor2"
                    tabindex="-1"
                    aria-label={language.disableAboveHelp}
                    onpointerdown={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                    }}
                    onclick={(event) => event.stopPropagation()}
                >
                    <CircleQuestionMarkIcon />
                </button>
            {/snippet}
            {language.disableAboveHelp}
        </ShTooltip>
    </ShDropdownMenuItem>
    {/if}
{/snippet}

{#snippet senderIcon(options:{rounded?:boolean,styleFix?:string} = {})}
    {#if !blankMessage && !$HideIconStore && !hideSender}
        {#await img}
            <div class="shadow-lg bg-textcolor2" style={options?.styleFix ??`height:${DBState.db.iconsize * 3.5 / 100}rem;width:${DBState.db.iconsize * 3.5 / 100}rem;min-width:${DBState.db.iconsize * 3.5 / 100}rem`}
            class:rounded-md={!options?.rounded} class:rounded-full={options?.rounded}></div>
        {:then m}
            {#if largePortrait && (!options?.rounded)}
                <div class="shadow-lg bg-textcolor2" style={m + (options?.styleFix ?? `height:${DBState.db.iconsize * 3.5 / 100 / 0.75}rem;width:${DBState.db.iconsize * 3.5 / 100}rem;min-width:${DBState.db.iconsize * 3.5 / 100}rem`)}
                class:rounded-md={!options?.rounded} class:rounded-full={options?.rounded}></div>
            {:else}
                <div class="shadow-lg bg-textcolor2" style={m + (options?.styleFix ?? `height:${DBState.db.iconsize * 3.5 / 100}rem;width:${DBState.db.iconsize * 3.5 / 100}rem;min-width:${DBState.db.iconsize * 3.5 / 100}rem`)}
                class:rounded-md={!options?.rounded} class:rounded-full={options?.rounded}></div>
            {/if}
        {/await}
    {/if}
{/snippet}

{#snippet renderGuiHtmlPart(dom:HTMLElement)}
    {#if dom.tagName === 'IMG'}
        <img class={dom.getAttribute('class') ?? ''} alt="" style={dom.getAttribute('style') ?? ''} />
    {:else if dom.tagName === 'A'}
        <a target="_blank" rel="noreferrer" href={
            (dom.getAttribute('href') && dom.getAttribute('href').startsWith('https')) ? dom.getAttribute('href') : ''
        } class={dom.getAttribute('class') ?? ''} style={dom.getAttribute('style') ?? ''}>
            {@render renderChilds(dom)}
        </a>
    {:else if dom.tagName === 'SPAN'}
        <span class={dom.getAttribute('class') ?? ''} style={dom.getAttribute('style') ?? ''}>
            {@render renderChilds(dom)}
        </span>
    {:else if dom.tagName === 'DIV'}
        <div class={dom.getAttribute('class') ?? ''} style={dom.getAttribute('style') ?? ''}>
            {@render renderChilds(dom)}
        </div>
    {:else if dom.tagName === 'P'}
        <p class={dom.getAttribute('class') ?? ''} style={dom.getAttribute('style') ?? ''}>
            {@render renderChilds(dom)}
        </p>
    {:else if dom.tagName === 'H1'}
        <h1 class={dom.getAttribute('class') ?? ''} style={dom.getAttribute('style') ?? ''}>
            {@render renderChilds(dom)}
        </h1>
    {:else if dom.tagName === 'H2'}
        <h2 class={dom.getAttribute('class') ?? ''} style={dom.getAttribute('style') ?? ''}>
            {@render renderChilds(dom)}
        </h2>
    {:else if dom.tagName === 'H3'}
        <h3 class={dom.getAttribute('class') ?? ''} style={dom.getAttribute('style') ?? ''}>
            {@render renderChilds(dom)}
        </h3>
    {:else if dom.tagName === 'H4'}
        <h4 class={dom.getAttribute('class') ?? ''} style={dom.getAttribute('style') ?? ''}>
            {@render renderChilds(dom)}
        </h4>
    {:else if dom.tagName === 'H5'}
        <h5 class={dom.getAttribute('class') ?? ''} style={dom.getAttribute('style') ?? ''}>
            {@render renderChilds(dom)}
        </h5>
    {:else if dom.tagName === 'H6'}
        <h6 class={dom.getAttribute('class') ?? ''} style={dom.getAttribute('style') ?? ''}>
            {@render renderChilds(dom)}
        </h6>
    {:else if dom.tagName === 'UL'}
        <ul class={dom.getAttribute('class') ?? ''} style={dom.getAttribute('style') ?? ''}>
            {@render renderChilds(dom)}
        </ul>
    {:else if dom.tagName === 'OL'}
        <ol class={dom.getAttribute('class') ?? ''} style={dom.getAttribute('style') ?? ''}>
            {@render renderChilds(dom)}
        </ol>
    {:else if dom.tagName === 'LI'}
        <li class={dom.getAttribute('class') ?? ''} style={dom.getAttribute('style') ?? ''}>
            {@render renderChilds(dom)}
        </li>
    {:else if dom.tagName === 'TABLE'}
        <table class={dom.getAttribute('class') ?? ''} style={dom.getAttribute('style') ?? ''}>
            {@render renderChilds(dom)}
        </table>
    {:else if dom.tagName === 'TR'}
        <tr class={dom.getAttribute('class') ?? ''} style={dom.getAttribute('style') ?? ''}>
            {@render renderChilds(dom)}
        </tr>
    {:else if dom.tagName === 'TD'}
        <td class={dom.getAttribute('class') ?? ''} style={dom.getAttribute('style') ?? ''}>
            {@render renderChilds(dom)}
        </td>
    {:else if dom.tagName === 'TH'}
        <th class={dom.getAttribute('class') ?? ''} style={dom.getAttribute('style') ?? ''}>
            {@render renderChilds(dom)}
        </th>
    {:else if dom.tagName === 'HR'}
        <hr class={dom.getAttribute('class') ?? ''} style={dom.getAttribute('style') ?? ''} />
    {:else if dom.tagName === 'BR'}
        <br class={dom.getAttribute('class') ?? ''} style={dom.getAttribute('style') ?? ''} />
    {:else if dom.tagName === 'CODE'}
        <code class={dom.getAttribute('class') ?? ''} style={dom.getAttribute('style') ?? ''}>
            {@render renderChilds(dom)}
        </code>
    {:else if dom.tagName === 'PRE'}
        <pre class={dom.getAttribute('class') ?? ''} style={dom.getAttribute('style') ?? ''}>
            {@render renderChilds(dom)}
        </pre>
    {:else if dom.tagName === 'BLOCKQUOTE'}
        <blockquote class={dom.getAttribute('class') ?? ''} style={dom.getAttribute('style') ?? ''}>
            {@render renderChilds(dom)}
        </blockquote>
    {:else if dom.tagName === 'EM'}
        <em class={dom.getAttribute('class') ?? ''} style={dom.getAttribute('style') ?? ''}>
            {@render renderChilds(dom)}
        </em>
    {:else if dom.tagName === 'STRONG'}
        <strong class={dom.getAttribute('class') ?? ''} style={dom.getAttribute('style') ?? ''}>
            {@render renderChilds(dom)}
        </strong>
    {:else if dom.tagName === 'U'}
        <u class={dom.getAttribute('class') ?? ''} style={dom.getAttribute('style') ?? ''}>
            {@render renderChilds(dom)}
        </u>
    {:else if dom.tagName === 'DEL'}
        <del class={dom.getAttribute('class') ?? ''} style={dom.getAttribute('style') ?? ''}>
            {@render renderChilds(dom)}
        </del>
    {:else if dom.tagName === 'BUTTON'}
        <button class={dom.getAttribute('class') ?? ''} style={dom.getAttribute('style') ?? ''}>
            {@render renderChilds(dom)}
        </button>
    {:else if dom.tagName === 'RISUTEXTBOX'}
        {@render textBox()}
    {:else if dom.tagName === 'RISUICON'}
        {@render senderIcon()}
    {:else if dom.tagName === 'RISUBUTTONS'}
        {@render iconButtons()}
    {:else if dom.tagName === 'RISUGENINFO'}
        {@render genInfo()}
    {:else if dom.tagName === 'STYLE'}
        <svelte:element this={'style'}>
            {dom.innerHTML}
        </svelte:element>
    {:else}
        <div class={dom.getAttribute('class') ?? ''} style={dom.getAttribute('style') ?? ''}>
            {@render renderChilds(dom)}
        </div>
    {/if}

    
{/snippet}

{#snippet renderChilds(dom:HTMLElement)}
    {#each dom.childNodes as node}
        {#if node.nodeType === Node.TEXT_NODE}
            {node.textContent}
        {:else if node.nodeType === Node.ELEMENT_NODE}
            {@render renderGuiHtmlPart((node as HTMLElement))}
        {/if}
    {/each}
{/snippet}


{#if disabled === true}
<div class="w-full border-t-2 border-dashed border-primary"></div>
{/if}
{#if DBState.db.theme === ''}
<!-- NodeOnly Standard: 전용 외부 구조 -->
<div class="flex max-w-full justify-center risu-chat"
     bind:this={partialEditRoot}
     data-chat-index={idx}
     data-chat-id={DBState.db.characters?.[selIdState.selId]?.chats?.[DBState.db.characters?.[selIdState.selId]?.chatPage]?.message?.[idx]?.chatId ?? ''}
     data-partial-edit-disabled={controlDisabled.partialEdit}
     data-partial-edit-translated={translated && DBState.db.translatorType === 'llm'}
     onclickcapture={handleButtonTriggerWithin}>
    <div
        class="text-textcolor grow max-w-full sm:px-4"
        class:py-2={isBranchedFromComment}
        class:py-4={!isBranchedFromComment}
    >
        {#if !blankMessage}
            <div
                class="chat-message-shell flex flex-col w-full min-w-0 {nodeOnlyWidthClass} mx-auto bg-bgcolor sm:rounded-lg"
                class:chat-message-shell-sticky={DBState.db.stickyChatToolbar}
            >
                {#if !hideSender}
                    <!-- Header: icon + name -->
                    <div class="flex items-center gap-3 mb-4">
                        {@render senderIcon({rounded: DBState.db.roundIcons})}
                        {#if !$HideIconStore}
                            <span class="text-lg sm:text-xl text-textcolor">{name}</span>
                        {/if}
                    </div>
                {/if}
                <!-- Body: message text -->
                <div class="chat-message-body mb-3 leading-relaxed">
                    {@render textBox()}
                </div>
                <!-- Footer: geninfo + buttons -->
                {#if DBState.db.stickyChatToolbar}
                    {@render stickyChatFooter()}
                {:else}
                    <div class="flex flex-wrap items-center justify-between pt-2 border-t border-darkborderc border-opacity-30 text-textcolor2 gap-2">
                        <div class="min-w-0">
                            {@render genInfo()}
                        </div>
                        <div class="chat-message-actions w-auto ml-auto">
                            {@render iconButtons()}
                        </div>
                    </div>
                {/if}
            </div>
        {:else if isComment}
            <div class="flex flex-col w-full min-w-0 {nodeOnlyWidthClass} mx-auto px-4 sm:px-8">
                {#if isBranchedFromComment}
                    {@render branchedFromCommentRow()}
                {:else}
                    <div class="flexium items-center">
                        {@render iconButtons()}
                    </div>
                    {@render textBox()}
                {/if}
            </div>
        {/if}
    </div>
</div>
{:else}
<!-- 기존 테마: 공유 외부 구조 -->
<div class="flex max-w-full justify-center risu-chat"
     bind:this={partialEditRoot}
     data-chat-index={idx}
     data-chat-id={DBState.db.characters?.[selIdState.selId]?.chats?.[DBState.db.characters?.[selIdState.selId]?.chatPage]?.message?.[idx]?.chatId ?? ''}
     data-partial-edit-disabled={controlDisabled.partialEdit}
     data-partial-edit-translated={translated && DBState.db.translatorType === 'llm'}
     onclickcapture={handleButtonTriggerWithin}>
    <div
        class="text-textcolor mt-1 ml-4 mr-4 mb-1 px-2 bg-transparent grow border-t-gray-900 border-opacity/30 border-transparent flexium items-start max-w-full"
        class:py-1={isBranchedFromComment}
        class:py-2={!isBranchedFromComment}
    >
        {#if DBState.db.theme === 'mobilechat' && !blankMessage}
            <div class={role === 'user' ? "flex items-start w-full justify-end" : "flex items-start"}>
                {#if role !== 'user'}
                    {@render senderIcon({rounded: DBState.db.roundIcons})}
                {/if}
                <div
                    class="bg-darkbg rounded-lg p-3 max-w-[70%] mx-2"
                    class:rounded-tl-none={role !== 'user'}
                    class:rounded-tr-none={role === 'user'}
                >
                    <p class="text-textcolor">{@render textBox()}</p>
                    {#if DBState.db.characters?.[selIdState.selId]?.chats?.[DBState.db.characters?.[selIdState.selId]?.chatPage]?.message?.[idx]?.time}
                        <span class="text-xs text-textcolor2 mt-1 block">
                            {new Intl.DateTimeFormat(undefined, {
                                hour: '2-digit',
                                minute: '2-digit',
                                second: '2-digit',
                                month: '2-digit',
                                day: '2-digit',
                                hour12: false
                            }).format(DBState.db.characters[selIdState.selId].chats[DBState.db.characters[selIdState.selId].chatPage].message[idx].time)}
                        </span>
                    {/if}
                </div>
                {#if role === 'user'}
                    {@render senderIcon({rounded: DBState.db.roundIcons})}
                {/if}
            </div>
        {:else if DBState.db.theme === 'customHTML' && !blankMessage && renderedGuiHtml}
            {@render renderGuiHtmlPart(renderedGuiHtml)}
        {:else if stickyChatToolbarVariant === 'floating' && !blankMessage}
            {@render senderIcon({rounded: DBState.db.roundIcons})}
            <span
                class="chat-toolbar-message flex flex-col ml-4 w-full max-w-full min-w-0"
                style:--chat-toolbar-row-height={chatToolbarRowHeight}
            >
                <div class="chat-message-title flexium items-center chat-width">
                    {#if !$HideIconStore && !hideSender}
                        <div class="chat-width text-xl unmargin text-textcolor flex items-center">
                            <span>{name}</span>
                        </div>
                    {/if}
                    {#if !DBState.db.stickyChatToolbar}
                        {@render iconButtons()}
                    {/if}
                </div>
                {#if DBState.db.stickyChatToolbar}
                    {#key DBState.db.theme}
                        <span class="chat-toolbar-stick-anchor" aria-hidden="true"></span>
                        {@render floatingChatToolbar()}
                    {/key}
                {:else}
                    {@render genInfo()}
                {/if}
                {@render textBox()}
            </span>
        {:else if isBranchedFromComment}
            <span class="w-full max-w-full min-w-0">
                {@render branchedFromCommentRow()}
            </span>
        {:else}
            {@render senderIcon({rounded: DBState.db.roundIcons})}
            <span class="flex flex-col ml-4 w-full max-w-full min-w-0">
                <div class="flexium items-center chat-width">
                    {#if !blankMessage && !$HideIconStore && !hideSender}
                        <div class="chat-width text-xl unmargin text-textcolor flex items-center">
                            <span>{name}</span>
                        </div>
                    {/if}
                    {@render iconButtons()}
                </div>
                {@render genInfo()}
                {@render textBox()}
            </span>
        {/if}
    </div>
</div>
{/if}

{#if disabled}
<div class={{
    "w-full border-t-2 border-dashed": true,
    "border-primary": disabled === true,
    "border-warning": disabled === 'allBefore',
}}></div>
{/if}

<style>
    .chat-toolbar-sticky-layer {
        position: sticky;
        top: var(--chat-toolbar-sticky-top);
        z-index: var(--risu-z-sticky);
        isolation: isolate;
        display: flex;
        justify-content: flex-end;
        width: 100%;
        max-width: 100%;
        margin-block: 0.25rem;
        pointer-events: none;
    }

    .chat-toolbar-sticky-footer-layer {
        top: auto;
        bottom: 0;
        width: calc(100% + var(--chat-shell-inline-padding) + var(--chat-shell-inline-padding));
        max-width: none;
        margin: 0 calc(0px - var(--chat-shell-inline-padding));
        /* Keep the footer on one compositor surface in Firefox so its
           one-pixel separator retains the same raster phase after scrolling. */
        transform: translateZ(0);
    }

    .chat-toolbar-sticky-footer-layer.chat-toolbar-above-fixed-composer {
        bottom: var(--chat-fixed-composer-height, 0px);
    }

    .chat-toolbar-message {
        --chat-toolbar-sticky-top: max(2rem, calc(env(safe-area-inset-top) + 0.25rem));
    }

    .chat-message-title {
        min-height: var(--chat-toolbar-row-height);
    }

    .chat-toolbar-stick-anchor {
        align-self: flex-end;
        width: 1px;
        height: 1px;
        margin-bottom: -1px;
        transform: translateY(calc(0px - var(--chat-toolbar-row-height) - var(--chat-toolbar-sticky-top)));
        opacity: 0;
        pointer-events: none;
    }

    .chat-toolbar-floating-layer {
        --chat-toolbar-sticky-top: inherit;
        align-self: flex-end;
        width: fit-content;
        margin: calc(0px - var(--chat-toolbar-row-height)) 0 0.25rem;
    }

    .chat-toolbar-floating-card {
        position: relative;
        z-index: 0;
        display: flex;
        flex-direction: column;
        align-items: stretch;
        gap: 0.125rem;
        width: fit-content;
        max-width: 100%;
        pointer-events: auto;
    }

    .chat-toolbar-is-stuck .chat-toolbar-floating-card::before {
        content: "";
        position: absolute;
        inset: -0.25rem -0.375rem;
        z-index: -1;
        border: 1px solid color-mix(in srgb, var(--risu-theme-borderc) 50%, transparent);
        border-radius: 0.5rem;
        background: var(--chat-toolbar-floating-bg);
        box-shadow: 0 0.375rem 1.25rem color-mix(in srgb, var(--risu-theme-darkbg) 40%, transparent);
        -webkit-backdrop-filter: blur(12px) saturate(1.15);
        backdrop-filter: blur(12px) saturate(1.15);
        pointer-events: none;
    }

    .chat-toolbar-floating-card .chat-toolbar-generation-info {
        width: 100%;
    }

    .chat-toolbar-floating-card .chat-toolbar-actions {
        align-self: flex-end;
        margin-left: 0;
    }

    .chat-toolbar-floating-card .chat-toolbar-generation-info :global(.chat-generation-info) {
        width: 100%;
    }

    .chat-toolbar-sticky-footer {
        width: 100%;
        max-width: 100%;
        padding: 0 var(--chat-shell-inline-padding) var(--chat-shell-block-padding);
        background: var(--risu-theme-bgcolor);
        color: var(--risu-theme-textcolor2);
        pointer-events: auto;
    }

    .chat-toolbar-sticky-footer-content {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem;
        width: 100%;
        max-width: 100%;
        padding-top: 0.5rem;
        border-top: 1px solid color-mix(in srgb, var(--risu-theme-darkborderc) 30%, transparent);
    }

    .chat-message-shell {
        --chat-shell-inline-padding: 1rem;
        --chat-shell-block-padding: 1.5rem;
        padding: var(--chat-shell-block-padding) var(--chat-shell-inline-padding);
    }

    .chat-message-shell.chat-message-shell-sticky {
        padding-bottom: 0;
    }

    @media (min-width: 640px) {
        .chat-message-shell {
            --chat-shell-inline-padding: 2rem;
        }

        .chat-toolbar-sticky-footer {
            border-radius: 0 0 0.5rem 0.5rem;
        }
    }

    .chat-toolbar-generation-info {
        flex: 0 1 auto;
        min-width: 0;
        max-width: 100%;
    }

    .chat-toolbar-generation-info :global(.chat-generation-info) {
        width: auto;
        max-width: 100%;
    }

    .chat-toolbar-actions {
        flex: 0 0 auto;
        margin-left: auto;
    }
</style>
