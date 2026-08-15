<script lang="ts">
    import { ArrowLeft, ArrowLeftRightIcon, ArrowRight, BookmarkIcon, BotIcon, CopyIcon, PowerOff, GitBranch, HamburgerIcon, LanguagesIcon, MenuIcon, PencilIcon, RefreshCcwIcon, SplitIcon, TrashIcon, UserIcon, Volume2Icon, Scissors, EyeOff } from "@lucide/svelte"
    import { aiLawApplies, changeChatTo, foldChatToMessage, getFileSrc, createChatCopyName } from "src/ts/globalApi.svelte"
    import { ColorSchemeTypeStore } from "src/ts/gui/colorscheme"
    import { getModelInfo } from "src/ts/model/modellist"
    import { runLuaButtonTrigger } from 'src/ts/process/scriptings'
    import { risuChatParser } from "src/ts/process/scripts"
    import { runTrigger } from 'src/ts/process/triggers'
    import { sayTTS } from "src/ts/process/tts"
    import { DBState, ReloadChatPointer, CurrentTriggerIdStore, popupStore } from 'src/ts/stores.svelte'

    import { capitalize, getUserIcon, getUserName, sleep } from "src/ts/util"
    import { onDestroy, onMount, tick } from "svelte"
    import { type Unsubscriber } from "svelte/store"
    import { v4 as uuidv4, v4 } from 'uuid'
    import { language } from "../../lang"
    import { alertClear, alertConfirm, alertConfirmMulti, alertInput, alertRequestData, alertWait, notifyInfo, notifySuccess, type AlertAction } from "../../ts/alert"
    import { ParseMarkdown, type CbsConditions, type simpleCharacterArgument } from "../../ts/parser/parser.svelte"
    import { getLLMCache, setLLMCache } from "../../ts/translator/translator"
    import { getCurrentCharacter, getCurrentChat, normalizeChat, type MessageGenerationInfo } from "../../ts/storage/database.svelte"
    import { selectedCharID } from "../../ts/stores.svelte"
    import { HideIconStore, ReloadGUIPointer, selIdState } from "../../ts/stores.svelte"
    import TextAreaInput from "../UI/GUI/TextAreaInput.svelte"
    import ChatBody from './ChatBody.svelte'
    import PopupButton from "../UI/PopupButton.svelte";
    import { createRevenantChatTranslationRecovery, type RevenantChatTranslationRecoveryContext, type RevenantChatTranslationRecoveryScope } from "src/ts/process/revenant/recovery";
    import { getActiveSwipeMetadata } from "src/ts/process/revenant/recovery/chatGenerationTarget";
    import type { RevenantChatMessageTranslationTarget } from "src/ts/process/revenant";
    import IconButton from "../UI/GUI/IconButton.svelte";
    import IconButtonGroup from "../UI/GUI/IconButtonGroup.svelte";
    import { PRODUCT_NAME } from "src/ts/branding";
    import { createSubscriber } from "svelte/reactivity";
    import { hasSharedTranslationTask, subscribeSharedTranslationTaskChanges } from "./chatBodyRenderController.svelte";
    import type { ChatScrollController } from "./chatScroll";

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
    let activeTranslationTasks = 0
    let cancelTranslationRequest: (() => void) | null = $state(null)
    let messageEditTextAreaStyle = $derived(`font-size:${0.875 * (DBState.db.zoomsize / 100)}rem;line-height:${(DBState.db.lineHeight ?? 1.25) * (DBState.db.zoomsize / 100)}rem`)
    const translationDisabledClasses = 'disabled:opacity-50 disabled:cursor-not-allowed'
    interface Props {
        message?: string;
        name?: string;
        largePortrait?: boolean;
        isLastMemory: boolean;
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
        isComment?: boolean;
        disabled?: boolean | 'allBefore';
        renderCacheKey?: string;
        translationRecoveryContext?: RevenantChatTranslationRecoveryContext;
        translationRecoveryScope?: RevenantChatTranslationRecoveryScope | null;
        translationRecoveryTarget?: RevenantChatMessageTranslationTarget | null;
        getScrollController?: () => ChatScrollController | null;
    }

    let {
        message = '',
        name = '',
        largePortrait = false,
        isLastMemory,
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
        isComment = false,
        disabled = false,
        renderCacheKey = '',
        translationRecoveryContext,
        translationRecoveryScope,
        translationRecoveryTarget,
        getScrollController = () => null,
    }: Props = $props();

    let msgDisplay = $state('')
    let translated = $state(false)
    const translationTaskKey = $derived(renderCacheKey
        ? JSON.stringify([
            renderCacheKey,
            translationRecoveryTarget?.swipeId ?? (firstMessage ? currentPage - 1 : 0),
        ])
        : '')
    const trackSharedTranslationTasks = createSubscriber((update) =>
        subscribeSharedTranslationTaskChanges(update)
    )
    const sharedTranslationPending = $derived.by(() => {
        trackSharedTranslationTasks()
        return hasSharedTranslationTask(translationTaskKey)
    })

    async function rm(){
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
            onDeleteSwipe()
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
        msg.data = nextMessage
        if (msg.swipes && msg.swipeId !== undefined) {
            msg.swipes[msg.swipeId] = nextMessage
        }
    }

    async function preservePositionWhileEditing(update: () => void | Promise<void>) {
        const release = partialEditRoot
            ? getScrollController()?.preserveElementPosition(partialEditRoot)
            : undefined
        try {
            await update()
            // The editor first mounts and then measures its scrollHeight on a
            // following Svelte tick. Keep the old message anchor through both
            // layouts so the intermediate 44px textarea cannot move the view.
            await tick()
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
        await preservePositionWhileEditing(() => {
            editDraft = message
            editMode = true
        })
        if (translated && DBState.db.translatorType === 'llm') {
            editTranslationKeyMode = true
            originalEditTranslationKey = await getTranslationCacheKey()
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
        await preservePositionWhileEditing(async () => {
            editMode = false
            editTranslationKeyMode = false
            await edit(nextMessage)
            displaya(nextMessage)
        })

        if (shouldMigrateTranslationKey && oldKey) {
            const newKey = await getTranslationCacheKey()
            if (oldKey !== newKey) {
                const cached = await getLLMCache(oldKey)
                if (cached !== null) {
                    await setLLMCache(newKey, cached)
                }
            }
        }

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
        await preservePositionWhileEditing(() => {
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
        if(!DBState.db.legacyTranslation){
            return await ParseMarkdown(source, character, 'pretranslate', idx, getCbsCondition())
        }
        return await ParseMarkdown(source, character, 'notrim', idx, getCbsCondition())
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
        (DBState.db.translatorType === 'llm' ? sharedTranslationPending : translating)
        || revenantTranslationRecoverySnapshot.pending
    )
    const revenantTranslationInspectionReady = $derived(
        revenantTranslationRecovery.inspectionReady
    )

    async function loadTranslationForEdit() {
        const key = await getTranslationCacheKey()
        const cached = await getLLMCache(key)
        await preservePositionWhileEditing(() => {
            editTranslationCacheKey = key
            editTranslationText = cached ?? ''
            editTranslationMode = true
        })
    }

    async function saveTranslationEdit() {
        const key = editTranslationCacheKey
        if (key === null) return
        await setLLMCache(key, editTranslationText)
        await preservePositionWhileEditing(() => {
            editTranslationMode = false
            editTranslationCacheKey = null
        })
    }

    async function cancelOriginalEdit() {
        await preservePositionWhileEditing(() => {
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
        translationToggle: currentTextEditActive
            || (isTranslationControlBusy() && cancelTranslationRequest === null),
        translationAction: currentTextEditActive || isTranslationControlBusy(),
        swipe: currentTextEditActive || isTranslationBusy(),
        edit: isTranslationBusy()
            || (translated
                && DBState.db.translatorType === 'llm'
                && !revenantTranslationInspectionReady),
        partialEdit: currentTextEditActive || isTranslationBusy() || isStreamingDisplay,
    }))

    function updateTranslationTasks(delta:1|-1) {
        activeTranslationTasks = Math.max(0, activeTranslationTasks + delta)
        translating = activeTranslationTasks > 0
    }

    function toggleTranslation() {
        if (!isTranslationControlBusy()) translated = !translated
    }

    function resetTranslationState() {
        translated = false
        retranslate = false
    }

    function handleTranslationButton() {
        if (currentTextEditActive) return
        if (isTranslationBusy()) {
            cancelTranslationRequest?.()
            resetTranslationState()
            return
        }
        toggleTranslation()
    }

    function requestRetranslation() {
        if (!controlDisabled.translationAction) retranslate = true
    }

    function changeSwipe(change: () => void) {
        if (controlDisabled.swipe) return
        resetTranslationState()
        change()
        translationRevision += 1
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

    function displaya(message:string){
        msgDisplay = risuChatParser(message, {chara: name, chatID: idx, rmVar: true, visualize: true, cbsConditions: getCbsCondition()})
    }

    const setStatusMessage = (message:string, timeout:number = 0)=>{
        statusMessage = message
        if(timeout === 0) return
        setTimeout(() => {
            statusMessage = ''
        }, timeout)
    }


    let blankMessage = $derived((message === '{{none}}' || message === '{{blank}}' || message === '') && idx === -1 && !altGreeting || isComment)

    $effect.pre(() => {
        displaya(message)
    });

    const unsubscribers:Unsubscriber[] = []

    onMount(()=>{
        unsubscribers.push(ReloadGUIPointer.subscribe((v) => {
            displaya(message)
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
            ReloadChatPointer.update((v) => {
                v[idx] = (v[idx] ?? 0) + 1
                return v
            })
        }
        
        if(triggerName && triggerId) {
            setTimeout(() => {
                CurrentTriggerIdStore.set(null)
            }, 100) // Small delay to allow display mode to complete
        }
    }

    let isBookmarked = $derived(
        DBState.db.characters[selIdState.selId]
            ?.chats[DBState.db.characters[selIdState.selId].chatPage]
            ?.bookmarks?.includes(DBState.db.characters[selIdState.selId].chats[DBState.db.characters[selIdState.selId].chatPage].message[idx]?.chatId) ?? false
    );

    async function toggleBookmark() {
        const chat = DBState.db.characters[selIdState.selId].chats[DBState.db.characters[selIdState.selId].chatPage];
        
        if(!chat.message[idx]) return;

        let messageId = chat.message[idx]?.chatId;
        const messageContent = chat.message[idx]?.data;

        if (!messageId) {
            messageId = uuidv4();
            chat.message[idx].chatId = messageId;
        }

        chat.bookmarks ??= [];
        chat.bookmarkNames ??= {};

        const bookmarkIndex = chat.bookmarks.indexOf(messageId);

        if (bookmarkIndex > -1) {
            chat.bookmarks.splice(bookmarkIndex, 1);
            delete chat.bookmarkNames[messageId];
        } else {
            chat.bookmarks.push(messageId);

            const msgSender = chat.message[idx]?.role === 'user' ? getUserName() : name;
            const newName= await alertInput(language.bookmarkAskNameOrDefault, [], chat.bookmarkNames[messageId] || '');

            if (newName && newName.trim() !== '') {
                chat.bookmarkNames[messageId] = newName;
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
                chat.bookmarkNames[messageId] = msgSender + '| ' + defaultName;
            }
        }

        chat.bookmarks = [...chat.bookmarks];
    }
</script>


{#snippet genInfo()}
    <IconButtonGroup
        size="lg"
        className={`chat-generation-info flex-wrap justify-end gap-1 ${DBState.db.theme === 'standardRisu' ? 'flex-row-reverse' : ''}`}
        style="min-height:var(--icon-cell-size)"
    >
        {#if messageGenerationInfo && (DBState.db.requestInfoInsideChat || aiLawApplies())}
            {@const diagnosticMessage = idx >= 0
                ? DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage].message[idx]
                : undefined}
            {@const diagnosticGenerationInfo = diagnosticMessage
                ? (diagnosticMessage.swipes
                    ? getActiveSwipeMetadata(diagnosticMessage)?.generationInfo ?? diagnosticMessage.generationInfo
                    : diagnosticMessage.generationInfo)
                : messageGenerationInfo}
            {@const modelLabel = diagnosticGenerationInfo?.model
                ? capitalize(getModelInfo(diagnosticGenerationInfo.model).shortName.replace(/^pluginmodel:::/, ''))
                : language.requestDiagnostics.title}
            <IconButton
                expanded
                className="text-sm"
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
        {#if DBState.db.translatorType === 'llm' && translated}
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
    </IconButtonGroup>
{/snippet}

{#snippet textBox()}
    {#if editTranslationMode}
        <TextAreaInput bind:value={editTranslationText} autoResize actionBar={false} fullwidth padding={false} contentClassName="p-2 message-edit-area" style={messageEditTextAreaStyle} onLongPress={() => {
            saveTranslationEdit()
        }} />
    {:else if editMode}
        <TextAreaInput bind:value={editDraft} autoResize actionBar={false} fullwidth padding={false} contentClassName="p-2 message-edit-area" style={messageEditTextAreaStyle} onLongPress={() => {
            void cancelOriginalEdit()
        }} />
    {:else if isComment}
        <div class="w-full flex justify-center text-textcolor2 italic mb-12">

            {#if msgDisplay.startsWith('{{specialcomment')}
                {@const parts = msgDisplay.split('::')}
                {@const type = parts[1]}

                {#if type === 'branchedfrom'}
                    <button class="text-primary hover:underline"
                        onclick={() => {
                            console.log(parts)
                            changeChatTo(parts[2] ?? '')
                            foldChatToMessage(parts[4])
                        }}
                    >
                        <GitBranch size={20} class="inline-block mr-1" />
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

{#snippet iconButtons(options:{applyTextColors?:boolean} = {})}
    <div class="grow flex items-center justify-end" class:text-textcolor2={options?.applyTextColors !== false}>
        {#if isComment}
            <IconButton
                size="lg"
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
                {@render translationButton()}
                {#if window.innerWidth >= 640}
                    {@render majorIconButtonsBody(false)}
                    {#if DBState.db.characters[selIdState.selId] && idx > -1}
                        <PopupButton>
                            {@render minorIconButtonsBody(true)}
                        </PopupButton>
                    {/if}
                {:else}
                    {#if DBState.db.characters[selIdState.selId] && idx > -1}
                        <PopupButton>
                            {@render majorIconButtonsBody(true)}
                            {@render minorIconButtonsBody(true)}
                        </PopupButton>
                    {:else}
                        {@render majorIconButtonsBody(false)}
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
                        <EyeOff />
                    </IconButton>
                {/if}
                <IconButtonGroup size="lg" className={isTranslationBusy() ? 'opacity-50' : ''}>
                    {@render rerolls()}
                </IconButtonGroup>
            </IconButtonGroup>
        {/if}
    </div>
{/snippet}


{#snippet majorIconButtonsBody(showNames:boolean)}
    {#if !blankMessage}
    <IconButton size="lg" expanded={showNames} className="button-icon-copy" onclick={async ()=>{
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
            <span class="ml-1">{language.copy}</span>
        {/if}
    </IconButton>
{/if}
{#if idx > -1}
    {#if DBState.db.ttsEnabled && DBState.db.characters[selIdState.selId].ttsMode !== 'none' && (DBState.db.characters[selIdState.selId].ttsMode)}
        <IconButton size="lg" expanded={showNames} className="button-icon-tts" onclick={()=>{
            return sayTTS(null, message)
        }}>
            <Volume2Icon />
            {#if showNames}
                <span class="ml-1">TTS</span>
            {/if}
        </IconButton>
    {/if}
    <IconButton size="lg" expanded={showNames} tone="destructive" className="button-icon-remove" onclick={rm}>
        <TrashIcon />

        {#if showNames}
            <span class="ml-1">{language.remove}</span>
        {/if}
    </IconButton>
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
            onclick={toggleCurrentTextEdit}>
            <PencilIcon />

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
                <ArrowLeft />
            </IconButton>
            {#if !DBState.db.hideMessagePageCount}
                <span class="flex items-center text-xs text-textcolor2 shrink overflow-hidden whitespace-nowrap min-w-0">{currentPage}/{totalPages}</span>
            {/if}
            <IconButton size="lg" className="button-icon-reroll" onclick={() => changeSwipe(onReroll)}>
                <ArrowRight />
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
                <ArrowLeft />
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
                <ArrowRight />
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

{#snippet minorIconButtonsBody(showNames:boolean)}
    {#if idx > -1}
        <IconButton size="lg" expanded={showNames} active={isBookmarked} activeColor="primary" className="button-icon-bookmark" onclick={async () => {
            await sleep(1)
            toggleBookmark()
        }}>
            <BookmarkIcon />
            {#if showNames}
                <span class="ml-1">{language.bookmark}</span>
            {/if}
        </IconButton>

    <IconButton size="lg" expanded={showNames} onclick={async () => {
        await sleep(1)
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
        const newChat = $state.snapshot(currentChat)
        newChat.name = createChatCopyName(newChat.name, 'Branch')
        newChat.id = v4()
        newChat.message = newChat.message.slice(0, idx + 1)
        newChat.message.push({
            role: 'char',
            data: '{{specialcomment::branchedfrom::' + currentChat.id + '::' + currentChat.name + '::' + currentMessage.chatId + '::}}',
            isComment: true,
            disabled: true,
            chatId: v4(),
        })

        DBState.db.characters[selIdState.selId].chats.unshift(newChat)
        changeChatTo(0)
    }}>
        <SplitIcon />
        {#if showNames}
            <span class="ml-1">{language.branch}</span>
        {/if}
    </IconButton>

    <IconButton size="lg" expanded={showNames} onclick={async () => {
        await sleep(1)
        const currentMessage = DBState.db.characters[selIdState.selId].chats[DBState.db.characters[selIdState.selId].chatPage].message[idx]
        DBState.db.characters[selIdState.selId].chats[DBState.db.characters[selIdState.selId].chatPage].message[idx].disabled = !currentMessage.disabled
    }}>
        <PowerOff />
        {#if showNames}
            <span class="ml-1">{language.disableMessage}</span>
        {/if}
    </IconButton>

    <IconButton size="lg" expanded={showNames} onclick={async () => {
        await sleep(1)
        const currentMessage = DBState.db.characters[selIdState.selId].chats[DBState.db.characters[selIdState.selId].chatPage].message[idx]
        DBState.db.characters[selIdState.selId].chats[DBState.db.characters[selIdState.selId].chatPage].message[idx].disabled = currentMessage.disabled === 'allBefore' ? false : 'allBefore'
    }}>
        <Scissors />
        {#if showNames}
            <span class="ml-1">{language.disableAbove}</span>
        {/if}
    </IconButton>
    {/if}
{/snippet}

{#snippet senderIcon(options:{rounded?:boolean,styleFix?:string} = {})}
    {#if !blankMessage && !$HideIconStore}
        {#if DBState.db.characters[selIdState.selId]?.chaId === "§playground"}
        <div class="shadow-lg border-textcolor2 border flex justify-center items-center text-textcolor2" style={options?.styleFix ?? `height:${DBState.db.iconsize * 3.5 / 100}rem;width:${DBState.db.iconsize * 3.5 / 100}rem;min-width:${DBState.db.iconsize * 3.5 / 100}rem`}
            class:rounded-md={options?.rounded} class:rounded-full={options?.rounded}>
                {#if name === 'assistant'}
                    <BotIcon />
                {:else}
                    <UserIcon />
                {/if}
            </div>
        {:else}
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
     style={isLastMemory ? `border-top:${DBState.db.memoryLimitThickness}px solid rgba(98, 114, 164, 0.7);` : ''}
     onclickcapture={handleButtonTriggerWithin}>
    <div class="text-textcolor grow max-w-full sm:px-4 py-4">
        {#if !blankMessage}
            {@const nodeOnlyWidthClass =
                DBState.db.nodeOnlyStandardChatWidth === 'full' ? 'max-w-full' :
                DBState.db.nodeOnlyStandardChatWidth === 'wide' ? 'max-w-6xl' :
                'max-w-3xl'}
            <div class="flex flex-col w-full min-w-0 {nodeOnlyWidthClass} mx-auto py-6 px-4 sm:px-8 bg-bgcolor sm:rounded-lg">
                <!-- Header: icon + name -->
                <div class="flex items-center gap-3 mb-4">
                    {@render senderIcon({rounded: DBState.db.roundIcons})}
                    {#if DBState.db.characters[selIdState.selId]?.chaId === "§playground" && DBState.db.characters[selIdState.selId]?.chats?.[DBState.db.characters[selIdState.selId]?.chatPage]?.message?.[idx]}
                        <span class="text-lg sm:text-xl text-textcolor flex items-center">
                            <span>{DBState.db.characters[selIdState.selId].chats[DBState.db.characters[selIdState.selId].chatPage].message[idx].role === 'char' ? 'Assistant' : 'User'}</span>
                            <button class="ml-2 text-textcolor2 risu-interactive-foreground" onclick={() => {
                                DBState.db.characters[selIdState.selId].chats[DBState.db.characters[selIdState.selId].chatPage].message[idx].role = DBState.db.characters[selIdState.selId].chats[DBState.db.characters[selIdState.selId].chatPage].message[idx].role === 'char' ? 'user' : 'char'
                                ReloadChatPointer.update((v) => {
                                    v[idx] = (v[idx] ?? 0) + 1
                                    return v
                                })
                            }}><ArrowLeftRightIcon size="18" /></button>
                        </span>
                    {:else if !$HideIconStore}
                        <span class="text-lg sm:text-xl text-textcolor">{name}</span>
                    {/if}
                </div>
                <!-- Body: message text -->
                <div class="mb-3 leading-relaxed">
                    {@render textBox()}
                </div>
                <!-- Footer: geninfo + buttons -->
                <div class="flex flex-wrap items-center justify-between pt-2 border-t border-darkborderc border-opacity-30 text-textcolor2 gap-2">
                    <div class="min-w-0">
                        {@render genInfo()}
                    </div>
                    <div class="w-full sm:w-auto ml-auto">
                        {@render iconButtons()}
                    </div>
                </div>
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
     style={isLastMemory ? `border-top:${DBState.db.memoryLimitThickness}px solid rgba(98, 114, 164, 0.7);` : ''}
     onclickcapture={handleButtonTriggerWithin}>
    <div class="text-textcolor mt-1 ml-4 mr-4 mb-1 p-2 bg-transparent grow border-t-gray-900 border-opacity/30 border-transparent flexium items-start max-w-full" >
        {#if DBState.db.theme === 'mobilechat' && !blankMessage}
            <div class={role === 'user' ? "flex items-start w-full justify-end" : "flex items-start"}>
                {#if role !== 'user'}
                    {@render senderIcon({rounded: true})}
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
                    {@render senderIcon({rounded: true})}
                {/if}
            </div>
        {:else if DBState.db.theme === 'cardboard' && !blankMessage}
            <div class="w-full flex flex-col px-0 sm:px-4 py-4 relative">
                <div class="bg-linear-to-b from-bgcolor to-darkbg rounded-lg shadow-lg border-darkborderc border p-4 flex flex-col">
                    <div class="flex gap-4 mt-2 flex-col sm:flex-row">
                        <div class="flex flex-col items-center">
                            <div class="sm:h-96 sm:w-72 sm:min-w-72 w-48 h-64">
                                {@render senderIcon({rounded: false, styleFix:'height:100%;width:100%;'})}
                            </div>
                            <h2 class="text-base font-bold text-textcolor2 text-center mt-2 max-w-full text-ellipsis">{name}</h2>

                        </div>
                        {#if editMode}
                            <textarea class="grow h-138 sm:h-96 overflow-y-auto bg-transparent text-textcolor p-2 mb-2 resize-none message-edit-area" bind:value={editDraft}></textarea>
                        {:else}
                            <div class="grow h-138 sm:h-96 overflow-y-auto p-2 mb-2 sm:mb-0">
                                {@render textBox()}
                            </div>
                        {/if}
                    </div>
                </div>
                <div class="absolute bottom-0 right-0 bg-darkbg p-2 rounded-md border border-darkborderc text-textcolor2">
                    {@render iconButtons({applyTextColors: false})}
                </div>
            </div>
        {:else if DBState.db.theme === 'customHTML' && !blankMessage && renderedGuiHtml}
            {@render renderGuiHtmlPart(renderedGuiHtml)}
        {:else if DBState.db.theme === 'standardRisu' && !blankMessage}
            {@render senderIcon({rounded: DBState.db.roundIcons})}
            <span class="flex flex-col ml-4 w-full max-w-full min-w-0">
                <div class="flexium items-center chat-width">
                    {#if DBState.db.characters[selIdState.selId]?.chaId === "§playground" && !blankMessage && DBState.db.characters[selIdState.selId]?.chats?.[DBState.db.characters[selIdState.selId]?.chatPage]?.message?.[idx]}
                        <span class="chat-width text-xl border-darkborderc flex items-center text-textcolor">
                            <span>{DBState.db.characters[selIdState.selId].chats[DBState.db.characters[selIdState.selId].chatPage].message[idx].role === 'char' ? 'Assistant' : 'User'}</span>
                            <button class="ml-2 text-textcolor2 risu-interactive-foreground" onclick={() => {
                                DBState.db.characters[selIdState.selId].chats[DBState.db.characters[selIdState.selId].chatPage].message[idx].role = DBState.db.characters[selIdState.selId].chats[DBState.db.characters[selIdState.selId].chatPage].message[idx].role === 'char' ? 'user' : 'char'
                                ReloadChatPointer.update((v) => {
                                    v[idx] = (v[idx] ?? 0) + 1
                                    return v
                                })
                            }}><ArrowLeftRightIcon size="18" /></button>
                        </span>
                    {:else if !blankMessage && !$HideIconStore}
                        <div class="chat-width text-xl unmargin text-textcolor flex items-center">
                            <span>{name}</span>
                        </div>
                    {/if}
                    {@render iconButtons()}
                </div>
                {@render genInfo()}
                {@render textBox()}
            </span>
        {:else}
            {@render senderIcon({rounded: DBState.db.roundIcons})}
            <span class="flex flex-col ml-4 w-full max-w-full min-w-0">
                <div class="flexium items-center chat-width">
                    {#if DBState.db.characters[selIdState.selId]?.chaId === "§playground" && !blankMessage && DBState.db.characters[selIdState.selId]?.chats?.[DBState.db.characters[selIdState.selId]?.chatPage]?.message?.[idx]}
                        <span class="chat-width text-xl border-darkborderc flex items-center text-textcolor">
                            <span>{DBState.db.characters[selIdState.selId].chats[DBState.db.characters[selIdState.selId].chatPage].message[idx].role === 'char' ? 'Assistant' : 'User'}</span>
                            <button class="ml-2 text-textcolor2 risu-interactive-foreground" onclick={() => {
                                DBState.db.characters[selIdState.selId].chats[DBState.db.characters[selIdState.selId].chatPage].message[idx].role = DBState.db.characters[selIdState.selId].chats[DBState.db.characters[selIdState.selId].chatPage].message[idx].role === 'char' ? 'user' : 'char'
                                ReloadChatPointer.update((v) => {
                                    v[idx] = (v[idx] ?? 0) + 1
                                    return v
                                })
                            }}><ArrowLeftRightIcon size="18" /></button>
                        </span>
                    {:else if !blankMessage && !$HideIconStore}
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
