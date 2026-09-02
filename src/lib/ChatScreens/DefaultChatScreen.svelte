<script lang="ts">

    import { CameraIcon, ChevronUpIcon, ChevronDownIcon, ChevronsUpIcon, ChevronsDownIcon, DatabaseIcon, GlobeIcon, ImagePlusIcon, LanguagesIcon, LaughIcon, MenuIcon, MicOffIcon, PackageIcon, RefreshCcwIcon, SendIcon, StepForwardIcon, XIcon, BrainIcon, ArrowDownIcon, ZapIcon, Maximize2Icon, Minimize2Icon, WandSparklesIcon } from "@lucide/svelte";
    import ShDropdownMenu from 'src/lib/UI/GUI/ShDropdownMenu.svelte';
    import ShDropdownMenuTrigger from 'src/lib/UI/GUI/ShDropdownMenuTrigger.svelte';
    import ShDropdownMenuContent from 'src/lib/UI/GUI/ShDropdownMenuContent.svelte';
    import ShDropdownMenuItem from 'src/lib/UI/GUI/ShDropdownMenuItem.svelte';
    import IconButtonGroup from 'src/lib/UI/GUI/IconButtonGroup.svelte';
    import { selectedCharID, createSimpleCharacter, hypaV3ModalOpen, ScrollToMessageStore, clearMessageScrollRequest, additionalChatMenu, additionalFloatingActionButtons, chatDeselected, chatPanelStore } from "../../ts/stores.svelte";
    import { onDestroy, tick, untrack } from 'svelte';
    import Chat from "./Chat.svelte";
    import { getAdditionalChatLoadPages, getInitialChatLoadPages } from 'src/ts/chatLoadPages';
    import { type Chat as ChatData, type Message, type character } from "../../ts/storage/database.svelte";
    import { ensureMessageId } from 'src/ts/storage/messageIdentity';
    import { DBState, invalidateChatMessageRender } from 'src/ts/stores.svelte';
    import { getCharImage } from "../../ts/characters";
    import { chatProcessStage, doingChat, recoverRevenantGenerationsForChat, sendChat } from "../../ts/process/index.svelte";
    import { ensureCurrentChatReady, flushDirtyChatToServer } from "../../ts/storage/chatStorage";
    import { createFrameScheduler, sleep } from "../../ts/util";
    import { language } from "../../lang";
    import { isExpTranslator, recoverAuxiliaryTranslationJobs, translate } from "../../ts/translator/translator";
    import { alertConfirm, alertError, alertWait, notifySuccess, notifyError } from "../../ts/alert";
    import { playNotificationSound } from '../../ts/notificationSound'
import { isMobile } from 'src/ts/platform'
    import { processScript } from "src/ts/process/scripts";
    import CreatorQuote from "./CreatorQuote.svelte";
    import { stopTTS } from "src/ts/process/tts";
    import MainMenu from '../UI/MainMenu.svelte';
    import AssetInput from './AssetInput.svelte';
    import { CHAT_HISTORY_LOAD_THRESHOLD, createChatScrollController, isChatNearBottom, type ChatScrollController } from './chatScroll';
    import { aiLawApplies, chatFoldedState, chatFoldedStateMessageIndex, downloadFile, requestImmediateSave } from 'src/ts/globalApi.svelte';
    import { isRevenantGenerationLocallyObserved } from 'src/ts/process/revenant/transport';
    import { listRecoverableAuxiliaryGenerations } from 'src/ts/process/revenant/auxiliary';
    import type { RevenantRerollSnapshot } from 'src/ts/process/revenant';
    import {
        applyCancelledRerollSession,
        prepareChatReroll,
        shouldRetainRerollProjectionForCanonical,
        type ActiveRerollSession,
        type PreparedChatReroll,
    } from 'src/ts/process/revenant/chatGeneration';
    import { runTrigger } from 'src/ts/process/triggers';
    import { v4 } from 'uuid';
    import { processMultiCommand } from 'src/ts/process/command';
    import { runAutomaticRerolls, type AutomaticRerollResult } from 'src/ts/process/automaticReroll';
    import { postChatFile } from 'src/ts/process/files/multisend';
    import { getInlayAsset, getInlayAssetUrl, getInlayExplorerItemsBatch, getInlayMeta, type InlayExplorerItem } from 'src/ts/process/files/inlays';
    import { quickMenu } from 'src/ts/hotkey';
    import { loadChatDraft, scheduleSaveChatDraft, flushChatDraft, removeChatDraft } from 'src/ts/storage/chatDraft';
    import {
        activeRevenantWorkflows,
        cancelRevenantWorkflow,
        getActiveRevenantWorkflow,
        subscribeRevenantWorkflowSyncReady,
        subscribeRevenantWorkflowUpdates,
    } from 'src/ts/process/revenant/workflow';
    import {
        beginGenerationMessageProjection,
        updateRevenantAuxiliaryRecoveryStatus,
    } from 'src/ts/process/revenant/recovery';

    import Chats from './Chats.svelte';
    import PartialEditManager from './PartialEditManager.svelte';
    import ShButton from '../UI/GUI/ShButton.svelte';
    import PluginDefinedIcon from '../Others/PluginDefinedIcon.svelte';
    import Portal from '../UI/GUI/Portal.svelte';
    import OverlayPortal from '../UI/GUI/OverlayPortal.svelte';
    import ImageGenerationDialog from './ImageGenerationDialog.svelte';
    import TranslationDialog from './TranslationDialog.svelte';
    import { generateAIImageInlay } from 'src/ts/process/stableDiff';
    import { getCurrentImageGenerationPreset } from 'src/ts/imageGeneration/presets';
    import { canonicalizeInlayTokens, INLAY_VIEWER_ID_ATTRIBUTE } from 'src/ts/util/inlayTokens';
    import { isChatImagePreloadingEnabled, preloadInlayAssets } from 'src/ts/parser/parser.svelte';
    import AssetViewerActions from 'src/lib/UI/GUI/AssetViewerActions.svelte';
    import FullscreenImageViewer from 'src/lib/UI/GUI/FullscreenImageViewer.svelte';
    import InlayViewerMetadata from 'src/lib/UI/GUI/InlayViewerMetadata.svelte';
    import { copyInlayReference, downloadInlayAsset } from 'src/lib/UI/inlayViewerActions';
    import {
        collectChatInlayViewerEntries,
        isEmptyChatInlayMessage,
        removeChatInlayOccurrence,
        removeCurrentEmptyInlaySwipe,
        type ChatInlayViewerEntry,
    } from './chatInlayViewer';

    // Whether an Enter keydown should send (vs insert a newline), based on the
    // per-platform send-key mode. Mobile uses sendKeyMobile, desktop sendKeyPC.
    function shouldSendOnEnter(e: KeyboardEvent): boolean {
        const mode = isMobile ? DBState.db.sendKeyMobile : DBState.db.sendKeyPC;
        // Match the configured combo EXACTLY — every other modifier must be absent,
        // so e.g. Alt+Enter or Ctrl+Shift+Enter inserts a newline instead of sending.
        switch (mode) {
            case 'enter': return !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey;
            case 'ctrl-enter': return (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey;
            case 'shift-enter': return e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey;
            default: return false; // 'button'
        }
    }

    interface Props {
        openModuleList?: boolean;
        openChatList?: boolean;
        customStyle?: string;
        portalTarget?: HTMLElement | null;
    }

    let messageInput:string = $state('')
    let messageInputTranslate:string = $state('')
    let openMenu = $state(false)
    let imageGenerationOpen = $state(false)
    let translationOpen = $state(false)
    let imageRerollingTarget = $state.raw<{ roomId: string, messageId: string } | null>(null)
    let loadPages = $state(getInitialChatLoadPages(DBState.db))
    let doingChatInputTranslate = false
    let toggleStickers:boolean = $state(false)
    let fileInput:string[] = $state([])
    let showNewMessageButton = $state(false)
    let showScrollNav = $state(false)
    let scrollNavTimer: ReturnType<typeof setTimeout> | null = null
    let chatsInstance: any = $state()
    let chatScreenRoot: HTMLDivElement | null = $state(null)
    let composerHeight = $state(0)
    let fixedComposerLeft = $state(0)
    let fixedComposerWidth = $state(0)
    let chatScrollController: ChatScrollController | null = null
    let isScrollingToMessage = $state(false)
    let historyLoadToken: symbol | null = null
    let historyInlayPreload: {
        roomKey: string
        loadPages: number
        promise: Promise<void>
    } | null = null
    let initialInlayPreloadRoomKey = ''
    let { openModuleList = $bindable(false), openChatList = $bindable(false), customStyle = '', portalTarget }: Props = $props();
    let currentCharacter = $derived(DBState.db.characters[$selectedCharID])
    let currentChatSlot = $derived(currentCharacter?.chats[currentCharacter.chatPage])
    let currentChatReady = $derived(!!currentChatSlot && !currentChatSlot._placeholder)
    let currentChat = $derived(currentChatReady ? currentChatSlot.message : [])
    let currentChatFmIndex = $derived(currentChatReady ? (currentChatSlot.fmIndex ?? -1) : -1)
    let loadPagesRoomKey = $state('')
    let currentChatRoomKey = $derived(`${$selectedCharID}:${currentCharacter?.chatPage ?? -1}:${currentChatSlot?.id ?? ''}`)
    let currentRoomHasImageReroll = $derived(imageRerollingTarget?.roomId === currentChatSlot?.id)
    let inlayViewerOpen = $state(false)
    let inlayViewerEntries: ChatInlayViewerEntry[] = $state([])
    let inlayViewerItems: Record<string, InlayExplorerItem> = $state({})
    let inlayViewerIndex = $state(-1)
    let inlayViewerRoomKey = $state('')
    let inlayViewerRequest = 0
    let inlayViewerDeleting = false
    let currentInlayViewerEntry = $derived(inlayViewerEntries[inlayViewerIndex] ?? null)
    let inlayViewerId = $derived(currentInlayViewerEntry?.id ?? '')
    let currentInlayViewerItem = $derived(inlayViewerItems[inlayViewerId] ?? null)
    let inlayViewerSrc = $derived(inlayViewerId ? getInlayAssetUrl(inlayViewerId) : '')

    function getDisplayedFirstMessage(): string {
        if (!currentCharacter) return ''
        return currentChatFmIndex === -1
            ? currentCharacter.firstMessage
            : (currentCharacter.alternateGreetings[currentChatFmIndex] ?? '')
    }

    function collectCurrentRoomInlayEntries(): ChatInlayViewerEntry[] {
        return collectChatInlayViewerEntries(getDisplayedFirstMessage(), currentChat)
    }

    function refreshInlayViewerEntries(fallbackIndex: number): ChatInlayViewerEntry | null {
        const imageEntries = collectCurrentRoomInlayEntries().filter(entry =>
            (inlayViewerItems[entry.id]?.type ?? 'image') === 'image')
        if (imageEntries.length === 0) {
            closeInlayViewer()
            return null
        }
        inlayViewerEntries = imageEntries
        inlayViewerIndex = Math.min(Math.max(0, fallbackIndex), imageEntries.length - 1)
        return imageEntries[inlayViewerIndex] ?? null
    }

    async function loadInlayViewerEntries(
        target: ChatInlayViewerEntry | null,
        fallbackIndex = 0,
    ) {
        const request = ++inlayViewerRequest
        const roomKey = currentChatRoomKey
        const roomEntries = collectCurrentRoomInlayEntries()
        const roomIds = [...new Set(roomEntries.map(entry => entry.id))]
        try {
            const items = await getInlayExplorerItemsBatch(roomIds)
            if (request !== inlayViewerRequest || roomKey !== currentChatRoomKey) return
            const imageEntries = roomEntries.filter(entry => items[entry.id]?.type === 'image')
            if (imageEntries.length === 0) {
                closeInlayViewer()
                return
            }
            inlayViewerItems = items
            inlayViewerEntries = imageEntries
            const targetIndex = target
                ? imageEntries.findIndex(entry => entry.id === target.id
                    && entry.messageIndex === target.messageIndex
                    && entry.occurrence === target.occurrence)
                : -1
            inlayViewerIndex = targetIndex >= 0
                ? targetIndex
                : Math.min(Math.max(0, fallbackIndex), imageEntries.length - 1)
        } catch (error) {
            console.warn('[InlayViewer] Failed to resolve room assets', error)
            if (request === inlayViewerRequest && roomKey === currentChatRoomKey) {
                inlayViewerEntries = roomEntries
                inlayViewerIndex = Math.min(Math.max(0, fallbackIndex), roomEntries.length - 1)
            }
        }
    }

    function openInlayViewer(target: ChatInlayViewerEntry) {
        inlayViewerEntries = [target]
        inlayViewerIndex = 0
        inlayViewerRoomKey = currentChatRoomKey
        inlayViewerOpen = true
        void loadInlayViewerEntries(target)
    }

    function getInlayViewerTarget(event: Event): ChatInlayViewerEntry | null {
        const target = event.target
        if (!(target instanceof HTMLImageElement)) return null
        const container = target.closest<HTMLElement>(`[${INLAY_VIEWER_ID_ATTRIBUTE}]`)
        const chat = target.closest<HTMLElement>('[data-chat-index]')
        const id = container?.getAttribute(INLAY_VIEWER_ID_ATTRIBUTE)
        const messageIndex = Number(chat?.dataset.chatIndex)
        if (!container || !id || !Number.isInteger(messageIndex)) return null
        const matchingContainers = Array.from(
            chat?.querySelectorAll<HTMLElement>(`[${INLAY_VIEWER_ID_ATTRIBUTE}]`) ?? [],
        ).filter(element => element.getAttribute(INLAY_VIEWER_ID_ATTRIBUTE) === id)
        const occurrence = matchingContainers.indexOf(container)
        if (occurrence < 0) return null
        return { id, messageIndex, occurrence }
    }

    function handleInlayViewerClick(event: MouseEvent) {
        const target = getInlayViewerTarget(event)
        if (!target) return
        event.preventDefault()
        event.stopPropagation()
        openInlayViewer(target)
    }

    function handleInlayViewerKeydown(event: KeyboardEvent) {
        if (event.key !== 'Enter' && event.key !== ' ') return
        const target = getInlayViewerTarget(event)
        if (!target) return
        event.preventDefault()
        event.stopPropagation()
        openInlayViewer(target)
    }

    function closeInlayViewer() {
        inlayViewerRequest += 1
        inlayViewerOpen = false
        inlayViewerEntries = []
        inlayViewerItems = {}
        inlayViewerIndex = -1
        inlayViewerRoomKey = ''
    }

    function moveInlayViewer(direction: -1 | 1) {
        const nextIndex = inlayViewerIndex + direction
        if (nextIndex < 0 || nextIndex >= inlayViewerEntries.length) return
        inlayViewerIndex = nextIndex
    }

    async function copyCurrentInlayReference() {
        if (!inlayViewerId) return
        await copyInlayReference(inlayViewerId)
    }

    async function downloadCurrentInlay() {
        const item = currentInlayViewerItem
        if (!item) return
        await downloadInlayAsset(item.id)
    }

    async function deleteCurrentInlayReference() {
        const entry = currentInlayViewerEntry
        const item = currentInlayViewerItem
        if (!entry || entry.messageIndex < 0 || inlayViewerDeleting) return
        inlayViewerDeleting = true
        const deletedViewerIndex = inlayViewerIndex
        try {
            if (!(await alertConfirm(language.inlayGallery.inlayDeleteConfirm.replace('{name}', item?.name ?? entry.id)))) return
            const message = currentChatSlot?.message?.[entry.messageIndex]
            if (!message) return
            const next = removeChatInlayOccurrence(message.data, entry)
            if (!isEmptyChatInlayMessage(next)) {
                message.data = next
                if (message.swipes && message.swipeId !== undefined) {
                    message.swipes[message.swipeId] = next
                }
                invalidateChatMessageRender(entry.messageIndex)
            } else if (removeCurrentEmptyInlaySwipe(message)) {
                invalidateSwipeMessage(message, entry.messageIndex)
            } else if (currentChatSlot) {
                currentChatSlot.message = currentChatSlot.message.filter((_, index) => index !== entry.messageIndex)
                currentCharacter.reloadKeys += 1
            }
            void requestImmediateSave()
            const nextEntry = refreshInlayViewerEntries(deletedViewerIndex)
            if (nextEntry) {
                await loadInlayViewerEntries(nextEntry, inlayViewerIndex)
            }
        } finally {
            inlayViewerDeleting = false
        }
    }

    $effect(() => {
        if (inlayViewerOpen && inlayViewerRoomKey !== currentChatRoomKey) closeInlayViewer()
    })

    function trackComposerMetrics(node: HTMLElement) {
        const update = () => {
            composerHeight = node.getBoundingClientRect().height
        }
        const scheduler = createFrameScheduler(update)
        const resizeObserver = typeof ResizeObserver === 'undefined'
            ? null
            : new ResizeObserver(scheduler.schedule)
        resizeObserver?.observe(node)
        window.addEventListener('resize', scheduler.schedule)
        update()

        return {
            destroy() {
                resizeObserver?.disconnect()
                window.removeEventListener('resize', scheduler.schedule)
                scheduler.cancel()
            },
        }
    }

    function trackFixedComposerBounds(node: HTMLElement, enabled: boolean) {
        const update = () => {
            const bounds = node.getBoundingClientRect()
            if (bounds.left !== fixedComposerLeft) fixedComposerLeft = bounds.left
            if (bounds.width !== fixedComposerWidth) fixedComposerWidth = bounds.width
        }
        const scheduler = createFrameScheduler(update)
        const observedElements: Element[] = []
        for (let current: Element | null = node; current; current = current.parentElement) {
            observedElements.push(current)
        }
        let resizeObserver: ResizeObserver | null = null
        let tracking = false

        const start = () => {
            if (tracking) return
            tracking = true
            if (typeof ResizeObserver === 'undefined') {
                window.addEventListener('resize', scheduler.schedule)
            }
            else {
                const observedWidths = new WeakMap<Element, number>()
                resizeObserver = new ResizeObserver((entries) => {
                    let horizontalLayoutChanged = false
                    for (const entry of entries) {
                        const width = entry.borderBoxSize[0]?.inlineSize ?? entry.contentRect.width
                        if (observedWidths.get(entry.target) !== width) {
                            observedWidths.set(entry.target, width)
                            horizontalLayoutChanged = true
                        }
                    }
                    if (horizontalLayoutChanged) scheduler.schedule()
                })
                for (const element of observedElements) {
                    observedWidths.set(element, element.getBoundingClientRect().width)
                    resizeObserver.observe(element)
                }
            }
            update()
        }
        const stop = () => {
            if (!tracking) return
            tracking = false
            resizeObserver?.disconnect()
            resizeObserver = null
            window.removeEventListener('resize', scheduler.schedule)
            scheduler.cancel()
        }

        if (enabled) start()

        return {
            update(nextEnabled: boolean) {
                if (nextEnabled) start()
                else stop()
            },
            destroy() {
                stop()
            },
        }
    }

    async function insertGeneratedImage(
        reference: string,
        target: { characterId: string, chatId: string },
    ) {
        const character = DBState.db.characters.find(item => item?.chaId === target.characterId)
        if(character?.type !== 'character') return
        const chat = character.chats.find(item => item?.id === target.chatId)
        if(!chat || !Array.isArray(chat.message)) return
        chat.message = [...chat.message, {
            role: 'char',
            data: reference,
            kind: 'imageGeneration',
            saying: character.chaId,
            chatId: v4(),
            time: Date.now(),
        }]
        character.reloadKeys += 1
        await tick()
        if(currentChatSlot?.id === chat.id) scrollToBottom()
    }

    function getLastActiveMessage() {
        return currentChat.findLast(message => !message.isComment && !message.disabled)
    }

    async function rerollGeneratedImage(message: Message) {
        if(
            imageRerollingTarget
            || message.kind !== 'imageGeneration'
            || currentCharacter?.type !== 'character'
            || !currentChatSlot?.id
        ) return
        if(!getCurrentImageGenerationPreset(DBState.db).settings.sdProvider) {
            notifyError(language.imageProviderNotConfigured)
            return
        }

        const character = currentCharacter
        const chat = currentChatSlot
        const messageId = message.chatId ?? v4()
        message.chatId = messageId
        imageRerollingTarget = { roomId: chat.id, messageId }
        try {
            const inlayId = message.data.match(/\{\{(?:inlay|inlayed|inlayeddata)::(.+?)\}\}/)?.[1]
            const prompt = inlayId ? (await getInlayMeta(inlayId))?.imageGeneration : undefined
            if(!prompt) {
                notifyError(language.imageGenerationPromptNotFound)
                return
            }
            const reference = await generateAIImageInlay(
                prompt.prompt,
                character,
                prompt.negativePrompt,
                { characterId: character.chaId, chatId: chat.id },
            )
            if(!reference) return

            const target = chat.message.find(item => item.chatId === messageId)
            if(!target || target.kind !== 'imageGeneration') return
            target.swipes = [...(target.swipes ?? [target.data]), reference]
            target.swipeId = target.swipes.length - 1
            target.data = reference
            target.time = Date.now()
            character.reloadKeys += 1
            const targetIndex = chat.message.indexOf(target)
            if (targetIndex >= 0) invalidateChatMessageRender(targetIndex)
            await tick()
            const isLastActiveMessage = chat.message.findLast(
                item => !item.isComment && !item.disabled,
            )?.chatId === messageId
            if(currentChatSlot?.id === chat.id && isLastActiveMessage) scrollToBottom()
        }
        catch(error) {
            notifyError(`${error}`)
        }
        finally {
            if(imageRerollingTarget?.messageId === messageId) imageRerollingTarget = null
        }
    }

    $effect(() => {
        void currentChatRoomKey
        const container = chatScreenRoot
        if (!container) return
        const controller = createChatScrollController(container)
        chatScrollController = controller
        return () => {
            if (chatScrollController === controller) chatScrollController = null
            controller.destroy()
        }
    })

    // History depth belongs to a room. Carrying a large value (or Infinity
    // from screenshot/search navigation) into the next room mounts its entire
    // history in one frame and makes translated chats especially expensive.
    $effect.pre(() => {
        if (loadPagesRoomKey === currentChatRoomKey) return
        loadPagesRoomKey = currentChatRoomKey
        loadPages = getInitialChatLoadPages(DBState.db)
        historyLoadToken = null
        historyInlayPreload = null
        initialInlayPreloadRoomKey = ''
    })

    // Warm the entire initially mounted history window as soon as the room is
    // hydrated. Otherwise its off-screen inlays only begin loading when they
    // enter the viewport observer margin and can expand while scrolling.
    $effect.pre(() => {
        const roomKey = currentChatRoomKey
        if (!isChatImagePreloadingEnabled()
            || !currentChatReady
            || initialInlayPreloadRoomKey === roomKey) return

        const { start, end } = getLoadedHistoryRange(loadPages)
        initialInlayPreloadRoomKey = roomKey
        void preloadInlayAssets(getHistoryInlaySources(start, end))
    })

    let currentRevenantWorkflow = $derived($activeRevenantWorkflows.find(workflow =>
        workflow.characterId === currentCharacter?.chaId
        && workflow.roomId === currentChatSlot?.id))
    let workflowCancellationIds = $state.raw<string[]>([])
    let workflowCancelInFlight = $derived(
        !!currentRevenantWorkflow
        && workflowCancellationIds.includes(currentRevenantWorkflow.workflowId)
    )
    interface ForegroundGenerationContext {
        abortController: AbortController
        detachController: AbortController
        abortRequested: boolean
        workflowId?: string
        rerollSession?: ActiveRerollSession
        origin: {
            characterId: string
            roomId: string
        }
    }
    const failedGenerationAttempt = (): AutomaticRerollResult => ({
        generated: false,
        toolExecuted: false,
        detached: false,
    })

    let foregroundGenerationContexts = $state.raw<ForegroundGenerationContext[]>([])
    let currentRoomForegroundGeneration = $derived(
        foregroundGenerationContexts.find(context =>
            context.origin.characterId === currentCharacter?.chaId
            && context.origin.roomId === currentChatSlot?.id
        )
    )
    let currentRoomOwnsForegroundGeneration = $derived(!!currentRoomForegroundGeneration)
    let currentRoomHasMainGeneration = $derived(
        currentRoomOwnsForegroundGeneration || !!currentRevenantWorkflow
    )

    onDestroy(() => {
        // Room/character navigation can unmount ChatScreen before the target
        // selection is applied, so detach the foreground observer here too.
        for (const context of foregroundGenerationContexts) {
            context.detachController.abort()
        }
    })

    // Once the main provider work belongs to another room, detach only this
    // page's foreground observer. The durable Revenant job/workflow continues
    // and the ordinary room-entry recovery effect attaches when the user
    // returns. User cancellation keeps using the separate abortController.
    $effect(() => {
        const characterId = currentCharacter?.chaId
        const roomId = currentChatSlot?.id
        for (const context of foregroundGenerationContexts) {
            if (
                context.origin.characterId !== characterId
                || context.origin.roomId !== roomId
            ) {
                context.detachController.abort()
            }
        }
    })

    // Workflow ownership is shared across the user's devices. Keep the local
    // composer flag in sync when another device finishes or cancels the room.
    $effect(() => {
        const characterId = currentCharacter?.chaId
        const roomId = currentChatSlot?.id
        if (!characterId || !roomId) return
        const refresh = () => {
            void getActiveRevenantWorkflow(characterId, roomId)
                .catch(error => console.warn('[GenerationWorkflow] Active refresh failed:', error))
        }
        refresh()
        const unsubscribeUpdates = subscribeRevenantWorkflowUpdates(event => {
            if (event.characterId === characterId && event.roomId === roomId) refresh()
        })
        const unsubscribeSyncReady = subscribeRevenantWorkflowSyncReady(refresh)
        return () => {
            unsubscribeUpdates()
            unsubscribeSyncReady()
        }
    })

    // ─── Per-chat composer draft ────────────────────────────────────────────
    // The message input is kept per chat, stored outside the chat body, so it
    // survives unmounting the chat view (e.g. accidentally opening Settings while
    // composing a long message). Keyed by character + chat id.
    let draftChaId = $derived(currentCharacter?.chaId ?? '')
    let draftChatId = $derived(currentChatSlot?.id ?? '')
    let draftLoading = $state(false)

    function persistDraftNow() {
        flushChatDraft(draftChaId, draftChatId, { m: messageInput, t: messageInputTranslate })
    }

    // Load on chat enter (keyed by id, so no wait for hydration); flush the
    // latest text for the chat being left on switch / unmount.
    $effect(() => {
        const chaId = draftChaId
        const chatId = draftChatId
        if (!chaId || !chatId) return
        untrack(() => { messageInput = ''; messageInputTranslate = ''; draftLoading = true })
        let active = true
        ;(async () => {
            const draft = await loadChatDraft(chaId, chatId)
            if (!active) return
            untrack(() => {
                // Don't clobber text the user began typing during the load.
                if (draft && messageInput === '' && messageInputTranslate === '') {
                    messageInput = draft.m
                    messageInputTranslate = draft.t
                }
                draftLoading = false
            })
            // Resize the textarea to fit the cleared/loaded text (height is
            // updated imperatively, not reactively to messageInput).
            await tick()
            if (active) updateInputSizeAll()
        })()
        return () => {
            active = false
            flushChatDraft(chaId, chatId, {
                m: untrack(() => messageInput),
                t: untrack(() => messageInputTranslate),
            })
        }
    })

    // Debounced save while typing (each write is a network round-trip, so it is
    // coalesced). Suppressed during the initial load to avoid racing it.
    $effect(() => {
        const chaId = draftChaId
        const chatId = draftChatId
        const m = messageInput
        const t = messageInputTranslate
        if (!chaId || !chatId || draftLoading) return
        scheduleSaveChatDraft(chaId, chatId, { m, t })
    })

    // Best-effort persist on tab hide / unload (refresh, app switch): the
    // unmount cleanup above does not fire on a hard page teardown.
    $effect(() => {
        const onHide = () => { if (document.visibilityState === 'hidden') persistDraftNow() }
        const onPageHide = () => persistDraftNow()
        document.addEventListener('visibilitychange', onHide)
        window.addEventListener('pagehide', onPageHide)
        return () => {
            document.removeEventListener('visibilitychange', onHide)
            window.removeEventListener('pagehide', onPageHide)
        }
    })

    /** Await hydration of active chat. Returns full Chat or null on failure. */
    async function ensureActiveChatReady(
        selectedChar = $selectedCharID,
        roomId?: string,
    ): Promise<ChatData | null> {
        const char = DBState.db.characters[selectedChar]
        if (!char) return null
        const chatPage = roomId
            ? char.chats.findIndex(chat => chat?.id === roomId)
            : char.chatPage
        if (chatPage < 0) return null
        const chat = char.chats[chatPage]
        if (!chat) return null
        if (!chat._placeholder) return chat
        return await ensureCurrentChatReady(char.chats, chatPage, char.chaId)
    }

    // A generation belongs to the server once submitted. If its originating
    // mobile tab disappeared before client-side output scripts completed, open
    // the target chat and resume only that chat's pending generations.
    $effect(() => {
        const selectedChar = $selectedCharID
        const char = DBState.db.characters[selectedChar]
        const chatId = char?.chats?.[char.chatPage]?.id
        if (!char?.chaId || !chatId) return
        let recoveryInFlight = false
        let recoveryRequested = false
        const recover = () => {
            if (recoveryInFlight) {
                recoveryRequested = true
                return
            }
            recoveryInFlight = true
            recoveryRequested = false
            void ensureActiveChatReady(selectedChar, chatId).then(async chat => {
                if (!chat) return
                const detachedTranslationJobs = await listRecoverableAuxiliaryGenerations()
                    .then(jobs => jobs.filter(job =>
                        job.jobType === 'translate'
                        && job.characterId === char.chaId
                        && job.roomId === chat.id
                        && !isRevenantGenerationLocallyObserved(job.jobId)
                    ))
                    .catch(error => {
                        console.warn('[GenerationJob] Translation recovery list unavailable:', error)
                        return []
                    })
                detachedTranslationJobs.forEach(job =>
                    updateRevenantAuxiliaryRecoveryStatus(job, chat.id))
                const [recoveredTranslations, recoveredOther] = await Promise.all([
                    detachedTranslationJobs.length > 0
                        ? recoverAuxiliaryTranslationJobs(false, {
                            characterId: char.chaId,
                            roomId: chat.id,
                        }, job => updateRevenantAuxiliaryRecoveryStatus(job, chat.id))
                        : Promise.resolve(0),
                    recoverRevenantGenerationsForChat(char, chat, {
                        onDeferredRecovered: recovered => {
                            if (recovered > 0 && DBState.db.playMessage) {
                                playNotificationSound(DBState.db.messageSound, DBState.db.messageSoundVolume)
                            }
                        },
                    }),
                ])
                if (recoveredTranslations + recoveredOther === 0) return

                if (recoveredOther > 0 && DBState.db.playMessage) {
                    playNotificationSound(DBState.db.messageSound, DBState.db.messageSoundVolume)
                }
                else if (recoveredTranslations > 0 && DBState.db.playMessageOnTranslateEnd) {
                    playNotificationSound(DBState.db.translateSound, DBState.db.translateSoundVolume)
                }
            }).catch(error => {
                console.error('[GenerationJob] Failed to recover pending chat work:', error)
            }).finally(() => {
                recoveryInFlight = false
                if (recoveryRequested) recover()
            })
        }
        recover()
        const onOnline = () => recover()
        const unsubscribeWorkflowUpdates = subscribeRevenantWorkflowUpdates(event => {
            if (event.characterId === char.chaId && event.roomId === chatId) recover()
        })
        const unsubscribeSyncReady = subscribeRevenantWorkflowSyncReady(recover)
        window.addEventListener('online', onOnline)
        return () => {
            unsubscribeWorkflowUpdates()
            unsubscribeSyncReady()
            window.removeEventListener('online', onOnline)
        }
    })

    function scrollToBottom() {
        chatsInstance?.scrollToLatestMessage();
    }

    function getChatScrollController() {
        return chatScrollController
    }

    function bumpScrollNav() {
        showScrollNav = true
        if (scrollNavTimer) clearTimeout(scrollNavTimer)
        scrollNavTimer = setTimeout(() => { showScrollNav = false }, 1500)
    }

    // Top of currently loaded messages (no force-load of older pages).
    function scrollToLoadedTop() {
        chatScrollController?.scrollToEdge('top', 'smooth')
    }

    // Literal bottom of the scroll (end of the latest message).
    function scrollToLoadedBottom() {
        chatScrollController?.scrollToEdge('bottom', 'smooth')
    }

    function navigateMessage(direction: 'prev' | 'next') {
        chatScrollController?.navigateMessage(direction)
    }

    async function loadMoreHistory() {
        if (historyLoadToken || currentChat.length <= loadPages) return
        const loadToken = Symbol('history-load')
        historyLoadToken = loadToken
        try {
            const roomKey = currentChatRoomKey
            const previousLoadPages = loadPages
            await preloadNextHistoryPage()
            if (currentChatRoomKey !== roomKey || loadPages !== previousLoadPages) return

            const release = chatScrollController?.preserveViewportPosition({ followLayout: true })
            try {
                loadPages = Math.min(
                    currentChat.length,
                    loadPages + getAdditionalChatLoadPages(DBState.db),
                )
                // Chats mounts stable message wrappers in the first tick; the
                // second lets their child components publish initial layout.
                await tick()
                await tick()
            }
            finally {
                release?.()
            }
        }
        finally {
            if (historyLoadToken === loadToken) historyLoadToken = null
        }
    }

    function getLoadedHistoryRange(pageCount: number): { start: number, end: number } {
        const foldedIndex = chatFoldedStateMessageIndex.index
        if (foldedIndex === -1) {
            return {
                start: Math.max(0, currentChat.length - pageCount),
                end: currentChat.length,
            }
        }

        return {
            start: Math.max(0, foldedIndex - pageCount),
            end: Math.min(currentChat.length, foldedIndex + 1),
        }
    }

    function getHistoryInlaySources(start: number, end: number): string[] {
        const sources: string[] = []
        for (let index = start; index < end; index += 1) {
            const message = currentChat[index]
            const source = message?.recoveryDisplayData ?? message?.data
            if (typeof source === 'string') sources.push(source)
        }
        return sources
    }

    function preloadNextHistoryPage(): Promise<void> {
        if (!isChatImagePreloadingEnabled()) return Promise.resolve()
        const roomKey = currentChatRoomKey
        const previousLoadPages = loadPages
        if (historyInlayPreload?.roomKey === roomKey
            && historyInlayPreload.loadPages === previousLoadPages) {
            return historyInlayPreload.promise
        }

        const { start: currentStart } = getLoadedHistoryRange(previousLoadPages)
        const nextStart = Math.max(
            0,
            currentStart - getAdditionalChatLoadPages(DBState.db),
        )
        const promise = preloadInlayAssets(getHistoryInlaySources(nextStart, currentStart))
        historyInlayPreload = { roomKey, loadPages: previousLoadPages, promise }
        return promise
    }
    $effect(() => {
        if(ScrollToMessageStore.value !== -1){
            const requestedIndex = ScrollToMessageStore.value
            const exact = ScrollToMessageStore.exact
            const targetCharacterId = ScrollToMessageStore.targetCharacterId
            const targetChatId = ScrollToMessageStore.targetChatId
            const targetMessageId = ScrollToMessageStore.targetMessageId

            // A room switch can render the old screen for a tick and lazy
            // hydration can render an empty placeholder for longer. Keep the
            // request pending until the identified destination is ready.
            if (targetCharacterId && currentCharacter?.chaId !== targetCharacterId) return
            if (targetChatId && currentChatSlot?.id !== targetChatId) return
            if (!currentChatReady) return

            const index = targetMessageId
                ? currentChat.findIndex(message => message?.chatId === targetMessageId)
                : requestedIndex
            clearMessageScrollRequest()
            if (index < 0) return

            void (async () => {
                // Let the room-scoped history depth reset and message wrappers
                // mount before starting the scroll controller's own polling.
                await tick()
                await tick()
                if (targetCharacterId && currentCharacter?.chaId !== targetCharacterId) return
                if (targetChatId && currentChatSlot?.id !== targetChatId) return
                await scrollToMessage(index, exact)
            })()
        }
    })

    async function scrollToMessage(index: number, exact = false){
        // Forces the loading of past messages not rendered on the screen
        // Request-status toast navigation should only move the viewport. The
        // loading veil is reserved for bookmark/history navigation.
        if (!exact) isScrollingToMessage = true
        try {
            const totalMessages = currentChat.length
            const neededLoadPages = totalMessages - index + 5

            if(loadPages < neededLoadPages){
                loadPages = neededLoadPages
                await tick()
            }

            let element: Element | null = null;
            // Poll for element existence (max 5 seconds)
            for(let i = 0; i < 50; i++){
                element = chatScreenRoot?.querySelector(`[data-chat-index="${index}"]`) ?? null
                if(element && (!exact || chatScrollController)) break;
                await sleep(100)
            }

            if (exact) {
                if (chatScreenRoot && element && chatScrollController) {
                    chatScrollController.scrollToElement(element as HTMLElement, {
                        block: 'start',
                        behavior: 'instant',
                        followLayout: true,
                    })
                }
                return
            }

            const chatContainer = chatScreenRoot;
            const preIndex = Math.max(0, index - 3)
            const preElement = chatContainer?.querySelector(`[data-chat-index="${preIndex}"]`)
            // Scroll within the chat container only — raw scrollIntoView climbs to
            // documentElement and, if the root is inflated, shoves the whole page up.
            if(chatContainer && preElement && !exact){
                chatScrollController?.scrollToElement(preElement as HTMLElement, { block: 'start', behavior: 'instant' })
            } else if(chatContainer && element){
                chatScrollController?.scrollToElement(element as HTMLElement, { block: 'start', behavior: 'instant' })
            }
            await sleep(50)

            if(element){
                // Wait for images to load to prevent layout shift
                if(chatContainer) {
                    const images = Array.from(chatContainer.querySelectorAll('img'));
                    const promises = images.map(img => {
                        if (img.complete) return Promise.resolve();
                        return new Promise(resolve => {
                            img.onload = () => resolve(null);
                            img.onerror = () => resolve(null);
                        });
                    });
                    // Wait for all images or timeout after 4 seconds
                    await Promise.race([
                        Promise.all(promises),
                        sleep(4000)
                    ]);
                }

                if(chatContainer){
                    chatScrollController?.scrollToElement(element as HTMLElement, { block: 'start', behavior: 'instant', followLayout: true })
                    // Small delay and scroll again to ensure position is correct after any final layout adjustments
                    await sleep(50)
                    element = chatScreenRoot?.querySelector(`[data-chat-index="${index}"]`) ?? element
                    chatScrollController?.scrollToElement(element as HTMLElement, { block: 'start', behavior: 'instant', followLayout: true })
                }

            }
        } finally {
            if (!exact) isScrollingToMessage = false
        }
    }

    async function send(){
        return sendMain(false)
    }
    async function sendContinue(){
        return sendMain(true)
    }

    async function sendMain(continueResponse:boolean) {
        const selectedChar = $selectedCharID
        if(currentRoomHasMainGeneration){
            return
        }

        const generationCharacter = DBState.db.characters[selectedChar]
        const generationChat = generationCharacter?.chats[generationCharacter.chatPage]
        if(!generationCharacter?.chaId || !generationChat?.id) return
        const generationTarget = {
            characterId: generationCharacter.chaId,
            roomId: generationChat.id,
        }
        // Input and draft state follow the visible room. Snapshot and clear
        // them before any asynchronous preprocessing so a later room switch
        // cannot feed or erase the newly selected room's composer text.
        let submittedMessageInput = messageInput
        const submittedFiles = [...fileInput]
        messageInput = ''
        messageInputTranslate = ''
        fileInput = []
        removeChatDraft(generationTarget.characterId, generationTarget.roomId)
        const foregroundContext = beginForegroundGeneration(generationTarget)
        let foregroundHandedOff = false

        try {
            const activeChat = await ensureActiveChatReady(selectedChar, generationTarget.roomId)
            if(!activeChat) return

            let cha = activeChat.message

            if(submittedMessageInput.startsWith('/')){
                const commandProcessed = await processMultiCommand(submittedMessageInput)
                if(commandProcessed !== false){
                    return
                }
            }

            if(submittedFiles.length > 0){
                for(const file of submittedFiles){
                    submittedMessageInput += `{{inlayed::${file}}}`
                }
            }

            if(submittedMessageInput === ''){
                if(cha.length === 0 || cha[cha.length - 1].role !== 'user'){
                    if(DBState.db.useSayNothing){
                        cha.push(ensureMessageId({
                            role: 'user',
                            data: '*says nothing*',
                            name: null
                        }))
                    }
                }
            }
            else{
                const char = DBState.db.characters[selectedChar]
                if(char.type === 'character'){
                    let triggerResult = await runTrigger(char,'input', {chat: activeChat})
                    if(triggerResult){
                        cha = triggerResult.chat.message
                    }

                    cha.push(ensureMessageId({
                        role: 'user',
                        data: canonicalizeInlayTokens(await processScript(char,submittedMessageInput,'editinput')),
                        time: Date.now(),
                        name: null
                    }))
                }
                else{
                    cha.push(ensureMessageId({
                        role: 'user',
                        data: canonicalizeInlayTokens(submittedMessageInput),
                        time: Date.now(),
                        name: null
                    }))
                }
            }
            const targetChatIndex = DBState.db.characters[selectedChar].chats.findIndex(chat =>
                chat?.id === generationTarget.roomId)
            if(targetChatIndex === -1) return
            DBState.db.characters[selectedChar].chats[targetChatIndex].message = cha

            await sleep(10)
            updateInputSizeAll()
            foregroundHandedOff = true
            const initialResult = await sendChatMain(
                continueResponse,
                undefined,
                generationTarget,
                foregroundContext,
            )
            if (
                initialResult.generated
                && !initialResult.detached
                && !initialResult.toolExecuted
                && !continueResponse
                && !DBState.db.outputImageModal
            ) {
                await runAutomaticRerolls(
                    DBState.db.genTime,
                    () => reroll(undefined, true),
                )
            }
        } finally {
            if(!foregroundHandedOff){
                releaseForegroundGeneration(foregroundContext)
            }
        }
    }

    // Fullscreen compose mode: the same messageInput, just shown in a full-screen
    // editor. Enter inserts a newline (no send); sending is via the Send button.
    let composerFullscreen = $state(false)
    let fullscreenEle:HTMLTextAreaElement = $state()
    $effect(() => {
        if (composerFullscreen && fullscreenEle) {
            const el = fullscreenEle
            requestAnimationFrame(() => {
                el.focus()
                el.selectionStart = el.selectionEnd = el.value.length
            })
        }
    })
    async function exitFullscreen(){
        composerFullscreen = false
        persistDraftNow()   // checkpoint the draft on return from the expanded composer
        await tick()   // let the inline composer re-measure with the latest text
        updateInputSizeAll()
        updateInputTransateMessage(false)
    }
    function sendFullscreen(){
        composerFullscreen = false
        send()
    }

    // With an empty input (and no attachments) and the last message being the
    // user's, pressing send doesn't add a new message — it regenerates a reply
    // to that last message. Surface that as a reroll affordance.
    const willResend = $derived.by(() => {
        if (messageInput !== '' || fileInput.length > 0) return false
        const cha = DBState.db.characters[$selectedCharID]
        if (!cha) return false
        const msgs = cha.chats?.[cha.chatPage]?.message
        if (!msgs || msgs.length === 0) return false
        return msgs[msgs.length - 1].role === 'user'
    })

    function getLastCharMsg() {
        const msgs = DBState.db.characters[$selectedCharID]?.chats[DBState.db.characters[$selectedCharID].chatPage]?.message
        if (!msgs || msgs.length === 0) return null
        for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].role === 'char' && !msgs[i].isComment && !msgs[i].disabled) return msgs[i]
        }
        return null
    }

    function getSwipeTargetMsg(idx?: number) {
        const msgs = DBState.db.characters[$selectedCharID]?.chats[DBState.db.characters[$selectedCharID].chatPage]?.message
        if (idx === undefined) return getLastCharMsg()
        if (!msgs?.[idx]) return null
        const msg = msgs[idx]
        if (!DBState.db.showPreviousChatSwipeButtons && msg.kind !== 'imageGeneration') return null
        if (msg.role !== 'char' || msg.isComment) return null
        return msg
    }

    function invalidateSwipeMessage(message: Message, idx?: number) {
        DBState.db.characters[$selectedCharID].reloadKeys += 1
        invalidateChatMessageRender(idx ?? currentChat.indexOf(message))
    }

    async function reroll(idx?: number, automatic = false): Promise<AutomaticRerollResult> {
        if(currentRoomHasMainGeneration || currentRoomHasImageReroll) {
            return failedGenerationAttempt()
        }
        const activeMessage = idx === undefined ? getLastActiveMessage() : currentChat[idx]
        if(activeMessage?.kind === 'imageGeneration') {
            await rerollGeneratedImage(activeMessage)
            return failedGenerationAttempt()
        }
        // Historical rerolls are intentionally image-only. Text generation must
        // continue to target the latest active response.
        if(idx !== undefined) return failedGenerationAttempt()
        const selectedChar = $selectedCharID
        const rerollCharacter = DBState.db.characters[selectedChar]
        const rerollChat = rerollCharacter?.chats?.[rerollCharacter.chatPage]
        if (!rerollCharacter?.chaId || !rerollChat?.id) return failedGenerationAttempt()
        // Let the edit effect pin its canonical base, then settle that edit
        // before the reroll swaps the live body for a temporary placeholder.
        // Otherwise the pending autosave can persist the projection and make
        // input.commit reject the original body with a misleading 409.
        await tick()
        try {
            await flushDirtyChatToServer(
                rerollCharacter.chaId,
                rerollCharacter.chatPage,
                rerollChat,
            )
        } catch (error) {
            alertError(error)
            return failedGenerationAttempt()
        }
        const generationTarget = {
            characterId: rerollCharacter.chaId,
            roomId: rerollChat.id,
        }
        const prepared = prepareChatReroll(rerollCharacter.chaId, rerollChat)
        if (!prepared) return failedGenerationAttempt()
        const messageChatId = v4()
        openMenu = false
        const foregroundContext = beginForegroundGeneration(generationTarget)
        foregroundContext.rerollSession = prepared.session
        rerollChat.isStreaming = true
        rerollChat.message = prepared.generationMessages
        beginGenerationMessageProjection(rerollChat, {
            messageChatId,
            characterId: rerollCharacter.chaId,
            isContinuation: false,
            rerollSnapshot: prepared.rerollSnapshot,
        })
        rerollCharacter.reloadKeys += 1
        const attempt = await sendChatMain(
            false,
            prepared.rerollSnapshot,
            generationTarget,
            foregroundContext,
            prepared.durableInputCommit,
            messageChatId,
            automatic,
        )

        // A user-triggered cancel keeps the partial reroll as the active swipe.
        if (!attempt.generated) {
            if (
                foregroundContext.abortRequested
                && applyCancelledRerollSession(
                    rerollCharacter,
                    rerollChat,
                    foregroundContext.rerollSession,
                )
            ) {
                return { ...attempt, generated: false }
            }
            // Once a server workflow exists, its terminal materializer owns
            // cancellation. Keep the local placeholder instead of briefly
            // restoring the old branch before canonical sync arrives.
            if (shouldRetainRerollProjectionForCanonical(foregroundContext)) {
                return attempt
            }
            const failedCharacter = DBState.db.characters.find(character =>
                character?.chaId === generationTarget.characterId)
            const failedChat = failedCharacter?.chats?.find(chat =>
                chat?.id === generationTarget.roomId)
            if (failedChat) {
                failedChat.message = prepared.originalMessages
                failedChat.isStreaming = false
            }
            return attempt
        }
        return attempt
    }

    async function unReroll(idx?: number) {
        const lastMsg = getSwipeTargetMsg(idx)
        if (!lastMsg || !lastMsg.swipes || lastMsg.swipeId === undefined) return

        lastMsg.swipeId = lastMsg.swipeId <= 0 ? lastMsg.swipes.length - 1 : lastMsg.swipeId - 1
        lastMsg.data = lastMsg.swipes[lastMsg.swipeId]
        invalidateSwipeMessage(lastMsg, idx)
    }

    function nextSwipe(idx?: number) {
        const lastMsg = getSwipeTargetMsg(idx)
        if (!lastMsg || !lastMsg.swipes || lastMsg.swipeId === undefined) return

        lastMsg.swipeId = lastMsg.swipeId >= lastMsg.swipes.length - 1 ? 0 : lastMsg.swipeId + 1
        lastMsg.data = lastMsg.swipes[lastMsg.swipeId]
        invalidateSwipeMessage(lastMsg, idx)
    }

    function deleteSwipe(idx?: number) {
        const lastMsg = getSwipeTargetMsg(idx)
        if (!lastMsg || !lastMsg.swipes || lastMsg.swipes.length <= 1) return

        const swipeIdx = lastMsg.swipeId ?? 0
        lastMsg.swipes.splice(swipeIdx, 1)
        lastMsg.swipeMetadata?.splice(swipeIdx, 1)

        if (swipeIdx >= lastMsg.swipes.length) {
            lastMsg.swipeId = lastMsg.swipes.length - 1
        }
        lastMsg.data = lastMsg.swipes[lastMsg.swipeId]

        if (lastMsg.swipes.length === 1) {
            const remainingMetadata = lastMsg.swipeMetadata?.[0]
            if (remainingMetadata) {
                lastMsg.chatId = remainingMetadata.chatId ?? lastMsg.chatId
                lastMsg.time = remainingMetadata.time ?? lastMsg.time
                lastMsg.generationInfo = remainingMetadata.generationInfo ?? lastMsg.generationInfo
                lastMsg.promptInfo = remainingMetadata.promptInfo ?? lastMsg.promptInfo
            }
            delete lastMsg.swipes
            delete lastMsg.swipeId
            delete lastMsg.swipeMetadata
        }
        invalidateSwipeMessage(lastMsg, idx)
    }

    function beginForegroundGeneration(
        origin: ForegroundGenerationContext['origin'],
    ): ForegroundGenerationContext {
        const context = {
            abortController: new AbortController(),
            detachController: new AbortController(),
            abortRequested: false,
            origin,
        }
        foregroundGenerationContexts = [...foregroundGenerationContexts, context]
        return context
    }

    function releaseForegroundGeneration(context: ForegroundGenerationContext) {
        foregroundGenerationContexts = foregroundGenerationContexts.filter(
            activeContext => activeContext !== context
        )
    }

    async function sendChatMain(
        continued:boolean = false,
        rerollSnapshot?: RevenantRerollSnapshot,
        generationTarget?: ForegroundGenerationContext['origin'],
        preparedContext?: ForegroundGenerationContext,
        durableInputCommit?: PreparedChatReroll['durableInputCommit'],
        messageChatId?: string,
        automatic = false,
    ): Promise<AutomaticRerollResult> {

        const origin = generationTarget ?? (
            currentCharacter?.chaId && currentChatSlot?.id
                ? {
                    characterId: currentCharacter.chaId,
                    roomId: currentChatSlot.id,
                }
                : null
        )
        if(!origin) return failedGenerationAttempt()
        const foregroundContext = preparedContext ?? beginForegroundGeneration(origin)
        const detachController = foregroundContext.detachController
        let generated = false
        let detached = false
        let toolExecuted = false
        try {
            generated = await sendChat(-1, {
                signal:foregroundContext.abortController.signal,
                detachSignal: detachController.signal,
                onDetached: () => detached = true,
                onWorkflowStarted: workflowId => {
                    foregroundContext.workflowId = workflowId
                },
                onMainRequestResult: result => {
                    toolExecuted ||= result.toolExecuted
                },
                suppressTts: automatic,
                continue:continued,
                rerollSnapshot,
                durableInputCommit,
                messageChatId,
                generationTarget: origin,
            })
        } catch (error) {
            if(!detached){
                console.error(error)
                alertError(error)
            }
        }
        if(!detached) $doingChat = false
        releaseForegroundGeneration(foregroundContext)
        if(!detached && DBState.db.playMessage){
            playNotificationSound(DBState.db.messageSound, DBState.db.messageSoundVolume)
        }
        // A detached generation is still owned by its Revenant workflow. Treat
        // it as retained so reroll cleanup does not restore the old branch.
        return {
            generated: detached ? true : generated,
            toolExecuted,
            detached,
        }
    }

    async function abortChat(){
        const foregroundContext = currentRoomForegroundGeneration
        if(foregroundContext){
            foregroundContext.abortRequested = true
            foregroundContext.abortController.abort()
        }
        const workflow = currentRevenantWorkflow
        if(!workflow || workflowCancelInFlight) return
        workflowCancellationIds = [...workflowCancellationIds, workflow.workflowId]
        const workflowBelongsToCurrentChat =
            currentCharacter?.chaId === workflow.characterId
            && currentChatSlot?.id === workflow.roomId
        try{
            await cancelRevenantWorkflow(workflow.workflowId)
        }
        catch(error){
            console.error('[GenerationWorkflow] Failed to cancel workflow:', error)
            alertError(error)
            if (workflowBelongsToCurrentChat) {
                void recoverRevenantGenerationsForChat(currentCharacter, currentChatSlot)
            }
        }
        finally{
            workflowCancellationIds = workflowCancellationIds.filter(
                workflowId => workflowId !== workflow.workflowId
            )
        }
    }

    let { userIconPortrait, currentUsername, userIcon } = $derived.by(() => {
        const bindedPersona = DBState?.db?.characters?.[$selectedCharID]?.chats?.[DBState?.db?.characters?.[$selectedCharID]?.chatPage]?.bindedPersona

        if(bindedPersona){
            const persona = DBState.db.personas.find((p) => p.id === bindedPersona)
            if(persona){
                return {
                    currentUsername: persona.name,
                    userIconPortrait: persona.largePortrait,
                    userIcon: persona.icon
                }
            }
        }

        const selectedPersonaIndex = DBState.db.selectedPersona
        return {
            currentUsername: DBState.db.username,
            userIconPortrait: DBState.db.personas[selectedPersonaIndex].largePortrait,
            userIcon: DBState.db.personas[selectedPersonaIndex].icon
        }
    })

    let inputHeight = $state("44px")
    let multiline = $state(false)
    let inputOverflow = $state(false)
    let inputEle:HTMLTextAreaElement = $state()
    let inputTranslateHeight = $state("44px")
    let inputTranslateEle:HTMLTextAreaElement = $state()

    // Standard theme: composer width follows the configured chat width (matches message cards).
    // Other themes: no width limit (original full-width behavior).
    let isStandardTheme = $derived(DBState.db.theme === '')
    let composerWidthClass = $derived(
        !isStandardTheme ? '' :
        DBState.db.nodeOnlyStandardChatWidth === 'full' ? 'max-w-full' :
        DBState.db.nodeOnlyStandardChatWidth === 'wide' ? 'max-w-6xl' :
        'max-w-3xl'
    )
    // Effective persona name for the input placeholder (chat-bound persona overrides the selected one).
    let activePersonaName = $derived.by(() => {
        const chat = DBState.db.characters[$selectedCharID]?.chats?.[DBState.db.characters[$selectedCharID]?.chatPage]
        const bound = chat?.bindedPersona ? DBState.db.personas.find(p => p.id === chat.bindedPersona) : null
        return (bound ?? DBState.db.personas[DBState.db.selectedPersona])?.name || 'User'
    })

    function updateInputSizeAll() {
        updateInputSize()
        updateInputTranslateSize()
    }

    async function appendTranslationToMessageInput(translation: string) {
        const addition = messageInput
            ? `${messageInput.endsWith('\n') ? '' : '\n'}${translation}`
            : translation

        // Insert as one native edit transaction so Ctrl+Z removes the appended
        // translation before continuing through the user's earlier typing.
        inputEle.focus({ preventScroll: true })
        const end = inputEle.value.length
        inputEle.setSelectionRange(end, end)
        document.execCommand('insertText', false, addition)
        await tick()
        updateInputSizeAll()
    }

    function updateInputTranslateSize() {
        if(inputTranslateEle) {
            inputTranslateEle.style.height = "0";
            inputTranslateHeight = (inputTranslateEle.scrollHeight) + "px";
            inputTranslateEle.style.height = inputTranslateHeight
        }
    }
    // Measure the textarea's content height at a given css width (empty = current
    // flex width), restoring the override afterwards.
    function measureHeightAt(cssWidth:string):number {
        const prev = inputEle.style.width
        inputEle.style.height = "0"
        if(cssWidth) inputEle.style.width = cssWidth
        const h = inputEle.scrollHeight
        inputEle.style.width = prev
        return h
    }

    // Width the textarea would have on a single inline row (pill content minus the
    // icon buttons and gaps). Computed from layout-independent sizes — the pill is
    // always full width and the icons are fixed-size — so it does NOT depend on the
    // current `multiline` state. That's what stops the 1↔2 line flip-flop.
    function inlineColWidth():number {
        const pill = inputEle.parentElement
        if(!pill) return 0
        const cs = getComputedStyle(pill)
        const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0)
        const gap = parseFloat(cs.columnGap || cs.gap || '0') || 0
        let used = 0, others = 0
        for(const c of Array.from(pill.children) as HTMLElement[]){
            if(c === inputEle) continue
            used += c.offsetWidth
            others++
        }
        return pill.clientWidth - padX - used - gap * others
    }

    function updateInputSize() {
        if(inputEle){
            const col = inlineColWidth()
            const ref = col > 0 ? col + "px" : ""
            // Gemini-style hysteresis: once the text grows past one line it stays
            // multiline until the input is fully cleared. Reflow is therefore a
            // one-way latch (cleared only on empty), so the layout toggle can never
            // feed back into the width measurement and flip-flop 1↔2 lines.
            if(messageInput === ''){
                multiline = false
            } else if(!multiline && measureHeightAt(ref) > 50){
                multiline = true
            }
            // Height for the width that will actually be shown.
            const sh = measureHeightAt(multiline ? "100%" : ref)
            // Cap the composer at ~60% of the viewport; beyond that it scrolls.
            const maxH = Math.round((window.visualViewport?.height ?? window.innerHeight) * 0.6)
            inputHeight = Math.min(sh, maxH) + "px"
            inputEle.style.height = inputHeight
            inputOverflow = sh > maxH
        }
    }

    $effect.pre(() => {
        updateInputSizeAll()
    });

    async function updateInputTransateMessage(reverse: boolean) {
        if(!DBState.db.useAutoTranslateInput){
            return
        }
        if(isExpTranslator()){
            if(!reverse){
                messageInputTranslate = ''
                return
            }
            if(messageInputTranslate === '') {
                messageInput = ''
                return
            }
            const lastMessageInputTranslate = messageInputTranslate
            await sleep(1500)
            if(lastMessageInputTranslate === messageInputTranslate){
                translate(reverse ? messageInputTranslate : messageInput, reverse).then((translatedMessage) => {
                    if(translatedMessage){
                        if(reverse)
                            messageInput = translatedMessage
                        else
                            messageInputTranslate = translatedMessage
                    }
                })
            }
            return

        }
        if(reverse && messageInputTranslate === '') {
            messageInput = ''
            return
        }
        if(!reverse && messageInput === '') {
            messageInputTranslate = ''
            return
        }
        translate(reverse ? messageInputTranslate : messageInput, reverse).then((translatedMessage) => {
            if(translatedMessage){
                if(reverse)
                    messageInput = translatedMessage
                else
                    messageInputTranslate = translatedMessage
            }
        })
    }

    async function screenShot(){
        try {
            loadPages = Infinity
            const html2canvas = await import('html-to-image');
            const chats = document.querySelectorAll('.default-chat-screen .risu-chat')
            alertWait("Taking screenShot...")
            let canvases:HTMLCanvasElement[] = []

            for(const chat of chats){
                const cnv = await html2canvas.toCanvas(chat as HTMLElement)
                alertWait("Taking screenShot... "+canvases.length+"/"+chats.length)
                canvases.push(cnv)
            }

            alertWait("Merging images...")

            let mergedCanvas = document.createElement('canvas');
            mergedCanvas.width = 0;
            mergedCanvas.height = 0;
            let mergedCtx = mergedCanvas.getContext('2d');

            let totalHeight = 0;
            let maxWidth = 0;
            for(let i = 0; i < canvases.length; i++) {
                let canvas = canvases[i];
                totalHeight += canvas.height;
                maxWidth = Math.max(maxWidth, canvas.width);

                mergedCanvas.width = maxWidth;
                mergedCanvas.height = totalHeight;
            }

            mergedCtx.fillStyle = 'var(--risu-theme-bgcolor)'
            mergedCtx.fillRect(0, 0, maxWidth, totalHeight);
            let indh = 0
            for(let i = 0; i < canvases.length; i++) {
                let canvas = canvases[i];
                indh += canvas.height
                mergedCtx.drawImage(canvas, 0, indh - canvas.height);
                canvases[i].remove();
            }

            if(mergedCanvas){
                await downloadFile(`chat-${v4()}.png`, Buffer.from(mergedCanvas.toDataURL('png').split(',').at(-1), 'base64'))
                mergedCanvas.remove();
            }
            notifySuccess(language.screenshotSaved)
            loadPages = getInitialChatLoadPages(DBState.db)
        } catch (error) {
            console.error(error)
            notifyError("Error while taking screenshot")
        }
    }

    
</script>



<div
    class="w-full h-full relative"
    class:nodeonly-standard-chat-surface={DBState.db.theme === '' && $selectedCharID >= 0}
    style={customStyle}
    style:--chat-fixed-composer-height={DBState.db.fixedChatTextarea ? `${composerHeight}px` : '0px'}
    use:trackFixedComposerBounds={DBState.db.fixedChatTextarea}
>
    {#if currentCharacter?.type === 'character'}
        <ImageGenerationDialog
            bind:open={imageGenerationOpen}
            character={currentCharacter as character}
            onGenerated={insertGeneratedImage}
        />
    {/if}
    <TranslationDialog
        bind:open={translationOpen}
        onConfirm={appendTranslationToMessageInput}
    />
    
    {#if DBState.db.nodeOnlyScrollButtonType !== 'off' && currentChat.length > 0}
        <Portal>
        <div
            class="chat-side-navigation risu-layer-sticky fixed right-3 flex flex-col rounded-lg bg-bgcolor/70 backdrop-blur-sm border border-darkborderc border-opacity-30 shadow-lg overflow-hidden transition-opacity duration-300"
            class:opacity-0={!showScrollNav}
            class:pointer-events-none={!showScrollNav}
        >
            {#if DBState.db.nodeOnlyScrollButtonType === 'four'}
                <button
                    class="w-9 h-9 text-textcolor2 risu-interactive-foreground hover:bg-darkbg/50 flex items-center justify-center transition-colors"
                    onclick={() => { bumpScrollNav(); scrollToLoadedTop() }}
                >
                    <ChevronsUpIcon size={18} />
                </button>
                <div class="border-t border-darkborderc border-opacity-30"></div>
            {/if}
            <button
                class="w-9 h-9 text-textcolor2 risu-interactive-foreground hover:bg-darkbg/50 flex items-center justify-center transition-colors"
                onclick={() => { bumpScrollNav(); navigateMessage('prev') }}
            >
                <ChevronUpIcon size={18} />
            </button>
            <div class="border-t border-darkborderc border-opacity-30"></div>
            <button
                class="w-9 h-9 text-textcolor2 risu-interactive-foreground hover:bg-darkbg/50 flex items-center justify-center transition-colors"
                onclick={() => { bumpScrollNav(); navigateMessage('next') }}
            >
                <ChevronDownIcon size={18} />
            </button>
            {#if DBState.db.nodeOnlyScrollButtonType === 'four'}
                <div class="border-t border-darkborderc border-opacity-30"></div>
                <button
                    class="w-9 h-9 text-textcolor2 risu-interactive-foreground hover:bg-darkbg/50 flex items-center justify-center transition-colors"
                    onclick={() => { bumpScrollNav(); scrollToLoadedBottom() }}
                >
                    <ChevronsDownIcon size={18} />
                </button>
            {/if}
        </div>
        </Portal>
    {/if}

    {#if showNewMessageButton && DBState.db.newMessageButtonStyle !== 'off'}
        {#if (DBState.db.newMessageButtonStyle === 'bottom-center' || !DBState.db.newMessageButtonStyle)}
            <button class="risu-layer-chrome absolute bottom-16 left-1/2 -translate-x-1/2 bg-primary text-white px-4 py-2 rounded-full shadow-lg flex items-center gap-2 risu-interactive-primary transition-colors" onclick={scrollToBottom}>
                <ArrowDownIcon size={16} />
                <span>{language.newMessage}</span>
            </button>
        {/if}

        {#if DBState.db.newMessageButtonStyle === 'bottom-right'}
            <button class="risu-layer-chrome absolute bottom-20 right-4 bg-primary text-white px-4 py-2 rounded-full shadow-lg flex items-center gap-2 risu-interactive-primary transition-colors" onclick={scrollToBottom}>
                <ArrowDownIcon size={16} />
                <span>{language.newMessage}</span>
            </button>
        {/if}

        {#if DBState.db.newMessageButtonStyle === 'bottom-left'}
            <button class="risu-layer-chrome absolute bottom-20 left-4 bg-primary text-white px-4 py-2 rounded-full shadow-lg flex items-center gap-2 risu-interactive-primary transition-colors" onclick={scrollToBottom}>
                <ArrowDownIcon size={16} />
                <span>{language.newMessage}</span>
            </button>
        {/if}

        {#if DBState.db.newMessageButtonStyle === 'floating-circle'}
            <button class="risu-layer-chrome absolute bottom-36 right-4 bg-primary text-white w-12 h-12 rounded-full shadow-lg flex items-center justify-center risu-interactive-primary transition-colors" onclick={scrollToBottom} title="4. 원형 (우하단)">
                <ArrowDownIcon size={20} />
            </button>
        {/if}

        {#if DBState.db.newMessageButtonStyle === 'right-center'}
            <button class="risu-layer-chrome absolute top-1/2 right-2 -translate-y-1/2 bg-primary text-white px-2 py-3 rounded-l-lg shadow-lg flex flex-col items-center gap-1 risu-interactive-primary transition-colors" onclick={scrollToBottom}>
                <ArrowDownIcon size={12} />
                <span class="text-xs writing-mode-vertical">{language.newMessage}</span>
            </button>
        {/if}

        {#if DBState.db.newMessageButtonStyle === 'top-bar'}
            <button class="risu-layer-chrome absolute top-2 left-1/2 -translate-x-1/2 bg-primary text-white px-6 py-1.5 rounded-full shadow-lg flex items-center gap-2 risu-interactive-primary transition-colors text-sm" onclick={scrollToBottom}>
                <ArrowDownIcon size={12} />
                <span>{language.newMessage}</span>
            </button>
        {/if}
    {/if}
    {#if isScrollingToMessage}
        <div class="risu-layer-chrome absolute inset-0 flex items-center justify-center bg-black/50 text-white text-xl font-bold backdrop-blur-sm">
            Loading...
        </div>
    {/if}
    {#if $selectedCharID < 0}
        <MainMenu />
    {:else if $chatDeselected}
        <div class="h-full w-full flex items-center justify-center text-textcolor2">
            <span>{language.selectChatToView}</span>
        </div>
    {:else}
        {#snippet composerCluster()}
            <div
                    class="{DBState.db.fixedChatTextarea ? 'chat-composer-fixed-layer fixed risu-layer-composer pt-2 pb-2 bottom-0 bg-transparent' : 'mt-2 mb-2'} w-full"
                    class:chat-composer-sticky-backdrop={DBState.db.fixedChatTextarea && DBState.db.stickyChatToolbar && DBState.db.theme === ''}
                    style:left={DBState.db.fixedChatTextarea ? `${fixedComposerLeft}px` : undefined}
                    style:width={DBState.db.fixedChatTextarea ? `${fixedComposerWidth}px` : undefined}
                    use:trackComposerMetrics
            >
              <div class="mx-auto w-full {composerWidthClass} px-2">
                <!-- "plugin-compat-items-stretch" is a compat hook (not a Tailwind class):
                     plugins that locate the composer via div[class*="items-stretch"] (e.g. gemini-cache-keeper)
                     relied on the pre-redesign container class. Keep it so they can still find/anchor their UI,
                     and it scopes the timer re-flow rules in <style> below. -->
                <IconButtonGroup size="lg" className="risu-field-border flex-wrap gap-1 rounded-3xl bg-bgcolor px-2 py-1.5 plugin-compat-items-stretch">
                    <ShDropdownMenu bind:open={openMenu}>
                        <ShDropdownMenuTrigger>
                            {#snippet child({ props })}
                                <button {...props}
                                        aria-label="menu"
                                        class="shrink-0 flex justify-center items-center w-9 h-9 rounded-full text-textcolor risu-interactive-primary-soft transition-colors">
                                    <MenuIcon />
                                </button>
                            {/snippet}
                        </ShDropdownMenuTrigger>
                        <ShDropdownMenuContent side="top" align="start" class="min-w-48">
                            <IconButtonGroup size="sm" direction="vertical" className="w-full items-stretch">
                                {#if DBState.db.ttsEnabled && (DBState.db.characters[$selectedCharID].ttsMode === 'webspeech' || DBState.db.characters[$selectedCharID].ttsMode === 'elevenlab')}
                                    <ShDropdownMenuItem onSelect={() => stopTTS()}>
                                        <MicOffIcon /><span>{language.ttsStop}</span>
                                    </ShDropdownMenuItem>
                                {/if}
                                {#if DBState.db.showMenuChatList}
                                    <ShDropdownMenuItem onSelect={() => { openChatList = true }}>
                                        <DatabaseIcon /><span>{language.chatList}</span>
                                    </ShDropdownMenuItem>
                                {/if}
                                {#each additionalChatMenu as menu}
                                    <ShDropdownMenuItem onSelect={() => { menu.callback() }}>
                                        <PluginDefinedIcon ico={menu} /><span>{menu.name}</span>
                                    </ShDropdownMenuItem>
                                {/each}
                                {#if DBState.db.hypaV3}
                                    <ShDropdownMenuItem onSelect={() => { $hypaV3ModalOpen = true }}>
                                        <BrainIcon /><span>{language.hypaMemoryV3Modal}</span>
                                    </ShDropdownMenuItem>
                                {/if}
                                <ShDropdownMenuItem onSelect={async () => {
                                    const results = await postChatFile(messageInput)
                                    if(!results) return
                                    for(const res of results){
                                        if(res?.type === 'asset'){
                                            fileInput.push(res.data)
                                        }
                                        if(res?.type === 'text'){
                                            messageInput += `{{file::${res.name}::${res.data}}}`
                                        }
                                    }
                                    updateInputSizeAll()
                                }}>
                                    <ImagePlusIcon /><span>{language.postFile}</span>
                                </ShDropdownMenuItem>
                                {#if currentCharacter?.type === 'character'}
                                    <ShDropdownMenuItem onSelect={() => { imageGenerationOpen = true }}>
                                        <WandSparklesIcon /><span>{language.imageGeneration}</span>
                                    </ShDropdownMenuItem>
                                {/if}
                                <ShDropdownMenuItem onSelect={() => { translationOpen = true }}>
                                    <LanguagesIcon /><span>{language.translate}</span>
                                </ShDropdownMenuItem>
                                <ShDropdownMenuItem onSelect={() => {
                                    DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage].modules ??= []
                                    openModuleList = true
                                }}>
                                    <PackageIcon /><span>{language.modules}</span>
                                </ShDropdownMenuItem>
                                {#if DBState.db.sideMenuRerollButton}
                                    <ShDropdownMenuItem onSelect={() => { reroll() }}>
                                        <RefreshCcwIcon /><span>{language.reroll}</span>
                                    </ShDropdownMenuItem>
                                {/if}
                            </IconButtonGroup>
                        </ShDropdownMenuContent>
                    </ShDropdownMenu>

                {#if DBState.db.useChatSticker}
                    <button type="button" onclick={()=>{toggleStickers = !toggleStickers}}
                         class={"shrink-0 flex justify-center items-center w-9 h-9 rounded-full border-0 bg-transparent p-0 appearance-none font-inherit risu-interactive-primary-soft transition-colors cursor-pointer "+(toggleStickers ? 'text-green-500':'text-textcolor')}>
                        <LaughIcon />
                    </button>
                {/if}

                <textarea class="text-input-area outline-hidden text-textcolor px-2 py-1.5 min-w-0 bg-transparent input-text text-base resize-none overflow-x-hidden max-w-full"
                          class:flex-1={!multiline}
                          class:basis-full={multiline}
                          class:order-first={multiline}
                          class:overflow-y-auto={inputOverflow}
                          class:overflow-y-hidden={!inputOverflow}
                          placeholder={willResend ? language.resendLastMessage : language.enterMessageToPersona(activePersonaName)}
                          bind:value={messageInput}
                          bind:this={inputEle}
                          onkeydown={(e) => {
                        if(e.key.toLocaleLowerCase() === "enter" && !e.isComposing){
                            if(shouldSendOnEnter(e)){
                                send()
                                e.preventDefault()
                            }
                        }
                        if(e.key.toLocaleLowerCase() === "m" && (e.ctrlKey)){
                            reroll()
                            e.preventDefault()
                        }
                    }}
                          onpaste={(e) => {
                        const items = e.clipboardData?.items
                        if(!items){
                            return
                        }
                        let canceled = false

                        for(const item of items){
                            if(item.kind === 'file' && item.type.startsWith('image')){
                                if(!canceled){
                                    e.preventDefault()
                                    canceled = true
                                }
                                const file = item.getAsFile()
                                if(file){
                                    const reader = new FileReader()
                                    reader.onload = async (e) => {
                                        const buf = e.target?.result as ArrayBuffer
                                        const uint8 = new Uint8Array(buf)
                                        const results = await postChatFile({
                                            name: file.name,
                                            data: uint8
                                        })
                                        if(!results) return
                                        for(const res of results){
                                            if(res?.type === 'asset'){
                                                fileInput.push(res.data)
                                            }
                                            if(res?.type === 'text'){
                                                messageInput += `{{file::${res.name}::${res.data}}}`
                                            }
                                        }
                                        updateInputSizeAll()
                                    }
                                    reader.readAsArrayBuffer(file)
                                }
                            }
                        }
                    }}
                          oninput={()=>{updateInputSizeAll();updateInputTransateMessage(false)}}
                          onblur={persistDraftNow}
                          style:height={inputHeight}
                ></textarea>

                <button
                        onclick={() => composerFullscreen = true}
                        aria-label={language.chatInputExpandTitle}
                        class="composer-expand-btn order-1 shrink-0 flex justify-center items-center w-9 h-9 rounded-full text-textcolor risu-interactive-primary-soft transition-colors"
                        class:ml-auto={multiline}
                >
                    <Maximize2Icon />
                </button>

                {#if currentRoomHasMainGeneration || doingChatInputTranslate}
                    <button
                            aria-labelledby="cancel"
                            disabled={workflowCancelInFlight}
                            class="order-2 shrink-0 flex justify-center items-center w-9 h-9 rounded-full text-textcolor risu-interactive-primary-soft transition-colors disabled:opacity-50" onclick={abortChat}
                    >
                        <div class="loadmove chat-process-stage-{$chatProcessStage}"></div>
                    </button>
                {:else}
                    <button
                            onclick={send}
                            aria-label={willResend ? language.reroll : language.send}
                            class="order-2 shrink-0 flex justify-center items-center w-9 h-9 rounded-full bg-primary text-white hover:bg-primary/80 transition-colors button-icon-send"
                    >
                        {#if willResend}
                            <RefreshCcwIcon />
                        {:else}
                            <SendIcon />
                        {/if}
                    </button>
                {/if}
                </IconButtonGroup>
              </div>
            </div>
            {#if DBState.db.useAutoTranslateInput}
                <div class="flex items-center mt-2 mb-2">
                    <label for='messageInputTranslate' class="text-textcolor ml-4">
                        <LanguagesIcon size={20} />
                    </label>
                    <textarea id = 'messageInputTranslate' class="risu-field-border text-textcolor rounded-md p-2 min-w-0 bg-transparent input-text text-xl grow ml-4 mr-2 resize-none outline-hidden overflow-y-hidden overflow-x-hidden max-w-full"
                              bind:value={messageInputTranslate}
                              bind:this={inputTranslateEle}
                              onkeydown={(e) => {
                            if(e.key.toLocaleLowerCase() === "enter" && !e.isComposing){
                                if(shouldSendOnEnter(e)){
                                    send()
                                    e.preventDefault()
                                }
                            }
                            if(e.key.toLocaleLowerCase() === "m" && (e.ctrlKey)){
                                reroll()
                                e.preventDefault()
                            }
                        }}
                              oninput={()=>{updateInputSizeAll();updateInputTransateMessage(true)}}
                              placeholder={language.enterMessageForTranslateToEnglish}
                              style:height={inputTranslateHeight}
                    ></textarea>
                </div>
            {/if}

            {#if fileInput.length > 0}
                <div class="flex items-center ml-4 flex-wrap p-2 m-2 border-darkborderc border rounded-md">
                    {#each fileInput as file, i}
                        {#await getInlayAsset(file) then inlayAsset}
                            <div class="relative">
                                {#if inlayAsset.type === 'image'}
                                    <img src={inlayAsset.data} alt="Inlay" class="max-w-48 max-h-48 border border-darkborderc">
                                {:else if inlayAsset.type === 'video'}
                                    <video controls class="max-w-48 max-h-48 border border-darkborderc">
                                        <source src={inlayAsset.data} type="video/mp4" />
                                        <track kind="captions" />
                                        Your browser does not support the video tag.
                                    </video>
                                {:else if inlayAsset.type === 'audio'}
                                    <audio controls class="max-w-48 max-h-24 border border-darkborderc">
                                        <source src={inlayAsset.data} type="audio/mpeg" />
                                        Your browser does not support the audio tag.
                                    </audio>
                                {:else}
                                    <div class="max-w-24 max-h-24">{file}</div>
                                {/if}
                                <button class="absolute -right-1 -top-1 p-1 bg-darkbg text-textcolor rounded-md transition-colors risu-interactive-danger" onclick={() => {
                                    fileInput.splice(i, 1)
                                    updateInputSizeAll()
                                }}>
                                    <XIcon size={18} />
                                </button>
                            </div>
                        {/await}
                    {/each}
                </div>

            {/if}

            {#if toggleStickers}
                <div class="ml-4 flex flex-wrap">
                    <AssetInput currentCharacter={currentCharacter} onSelect={(additionalAsset)=>{
                        let fileType = 'img'
                        if(additionalAsset.length > 2 && additionalAsset[2]) {
                            const fileExtension = additionalAsset[2]
                            if(fileExtension === 'mp4' || fileExtension === 'webm')
                                fileType = 'video'
                            else if(fileExtension === 'mp3' || fileExtension === 'wav')
                                fileType = 'audio'
                        }
                        messageInput += `<span class='notranslate' translate='no'>{{${fileType}::${additionalAsset[0]}}}</span> *${additionalAsset[0]} added*`
                        updateInputSizeAll()
                    }}/>
                </div>
            {/if}

        {/snippet}

        <div class="h-full w-full flex flex-col overflow-y-auto overscroll-y-contain relative default-chat-screen" data-chat-scroll-root
            bind:this={chatScreenRoot}
            onclickcapture={handleInlayViewerClick}
            onkeydowncapture={handleInlayViewerKeydown}
            class:nodeonly-standard={DBState.db.theme === ''}
            class:no-chat-width-wide={DBState.db.theme === '' && DBState.db.nodeOnlyStandardChatWidth === 'wide'}
            class:no-chat-width-full={DBState.db.theme === '' && DBState.db.nodeOnlyStandardChatWidth === 'full'}
            onscroll={(e) => {
            if (DBState.db.nodeOnlyScrollButtonType !== 'off') {
                bumpScrollNav()
            }
            const chatTarget = e.currentTarget as HTMLElement;
            const hasMoreHistory = currentChat.length > loadPages
            if(hasMoreHistory && chatTarget.scrollTop < chatTarget.clientHeight){
                void preloadNextHistoryPage()
            }
            if(hasMoreHistory && chatTarget.scrollTop < CHAT_HISTORY_LOAD_THRESHOLD){
                void loadMoreHistory()
            }
            if(isChatNearBottom(
                chatTarget.scrollTop,
                chatTarget.scrollHeight,
                chatTarget.clientHeight,
            )){
                showNewMessageButton = false;
            }
        }}>
            <div class="chat-scroll-phase" data-chat-scroll-phase aria-hidden="true"></div>

            {#if !currentChatReady}
                <div class="w-full flex justify-center text-textcolor2 italic mb-12">
                    {language.loadingChatData}
                </div>
            {:else}

            {#if chatFoldedStateMessageIndex.index !== -1}
                <button class="w-full flex justify-center max-w-full p-4">
                    <ShButton className="max-w-xl w-full" onclick={() => {
                        loadPages += chatFoldedStateMessageIndex.index + 1
                        chatFoldedState.data = null
                    }}>
                        {language.loadMore}
                    </ShButton>
                </button>
            {/if}
            
            {#if chatScreenRoot && (DBState.db.enableBlockPartialEdit || DBState.db.enableDragPartialEdit)}
                <PartialEditManager
                    screenRoot={chatScreenRoot}
                    messages={currentChat}
                    characterIndex={$selectedCharID}
                    chatPage={currentCharacter.chatPage}
                    chatId={currentChatSlot?.id ?? null}
                    blockEditEnabled={DBState.db.enableBlockPartialEdit}
                    dragEditEnabled={DBState.db.enableDragPartialEdit}
                    getScrollController={getChatScrollController}
                />
            {/if}

            {#if currentChat.length <= loadPages}
                {#if (aiLawApplies() && DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage].message.length === 0)}
                    <div class="generated-by-ai-disclaimer ml-auto mr-auto mt-4 text-textcolor2 italic max-w-2/3 wrap-break-word text-center">
                        {language.generatedByAIDisclaimer}
                    </div>
                {/if}
                {#if !DBState.db.characters[$selectedCharID].removedQuotes && DBState.db.characters[$selectedCharID].creatorNotes.length >= 2}
                    <CreatorQuote quote={DBState.db.characters[$selectedCharID].creatorNotes} onRemove={() => {
                        const cha = DBState.db.characters[$selectedCharID]
                        cha.removedQuotes = true
                        DBState.db.characters[$selectedCharID] = cha
                    }} />
                {/if}
                <Chat
                    character={createSimpleCharacter(DBState.db.characters[$selectedCharID])}
                    name={DBState.db.characters[$selectedCharID].name}
                    message={currentChatFmIndex === -1 ? DBState.db.characters[$selectedCharID].firstMessage :
                        DBState.db.characters[$selectedCharID].alternateGreetings[currentChatFmIndex]}
                    role='char'
                    img={getCharImage(DBState.db.characters[$selectedCharID].image, 'css')}
                    idx={-1}
                    altGreeting={DBState.db.characters[$selectedCharID].alternateGreetings.length > 0 && (DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage].message.length === 0 || DBState.db.showPreviousChatSwipeButtons)}
                    disabled={DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage].firstMessageDisabled === true}
                    largePortrait={DBState.db.characters[$selectedCharID].largePortrait}
                    firstMessage={true}
                    onReroll={() => {
                        const cha = DBState.db.characters[$selectedCharID]
                        const chat = DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage]
                        if (chat._placeholder) return
                        const cur = Number.isFinite(chat.fmIndex as number) ? (chat.fmIndex as number) : -1
                        chat.fmIndex = (cur >= cha.alternateGreetings.length - 1) ? -1 : cur + 1
                        DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage] = chat
                    }}
                    unReroll={() => {
                        const cha = DBState.db.characters[$selectedCharID]
                        const chat = DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage]
                        if (chat._placeholder) return
                        const cur = Number.isFinite(chat.fmIndex as number) ? (chat.fmIndex as number) : -1
                        chat.fmIndex = (cur === -1) ? cha.alternateGreetings.length - 1 : cur - 1
                        DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage] = chat
                    }}
                    currentPage={(Number.isFinite(DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage].fmIndex as number) ? (DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage].fmIndex as number) : -1) + 2}
                    totalPages={DBState.db.characters[$selectedCharID].alternateGreetings.length + 1}
                    renderCacheKey={`${currentChatRoomKey}:first-message`}
                    translationRecoveryScope={currentCharacter.chaId && currentChatSlot?.id
                        ? { characterId: currentCharacter.chaId, roomId: currentChatSlot.id }
                        : null}
                    translationRecoveryTarget={null}

                />
            {/if}

            <Chats
                bind:this={chatsInstance}
                getScrollController={getChatScrollController}
                messages={currentChat}
                loadPages={loadPages}
                onReroll={reroll}
                onNextSwipe={nextSwipe}
                onDeleteSwipe={deleteSwipe}
                unReroll={unReroll}
                currentCharacter={currentCharacter}
                currentUsername={currentUsername}
                userIcon={userIcon}
                chatRoomId={currentChatSlot?.id ?? ''}
                roomIsStreaming={currentChatSlot?.isStreaming ?? false}
                roomIsResponding={currentRoomHasMainGeneration}
                imageRerollingMessageId={imageRerollingTarget?.roomId === currentChatSlot?.id
                    ? imageRerollingTarget.messageId
                    : null}
                userIconPortrait={userIconPortrait}
                bind:hasNewUnreadMessage={showNewMessageButton}
            />

            {/if}

            {#if chatPanelStore.length > 0}
                <div class="mx-4 my-2 flex flex-col gap-2">
                    {#each chatPanelStore as panel (panel.id)}
                        <section class={`rounded-md border border-darkborderc bg-darkbg/80 p-3 text-textcolor ${panel.className ?? ''}`} data-plugin-chat-panel={panel.id}>
                            {@html panel.html}
                        </section>
                    {/each}
                </div>
            {/if}

            {#if DBState.db.fixedChatTextarea}
                <div
                    class="w-full shrink-0"
                    style:height={`${composerHeight}px`}
                    aria-hidden="true"
                ></div>
            {:else}
                {@render composerCluster()}
            {/if}

            <div class="chat-scroll-anchor" data-chat-scroll-anchor aria-hidden="true"></div>

        </div>

        {#if DBState.db.fixedChatTextarea}
            <Portal target={portalTarget ?? undefined}>
                {@render composerCluster()}
            </Portal>
        {/if}

    {/if}
</div>

{#if additionalFloatingActionButtons.length > 0}
    <Portal>
    <div class="risu-layer-chrome fixed top-4 right-4 flex flex-col gap-3">
        {#each additionalFloatingActionButtons as button}
            <button class="bg-primary text-white px-4 py-2 rounded-full shadow-lg flex items-center gap-2 risu-interactive-primary transition-colors" onclick={() => {
                button.callback()
            }}>
                <PluginDefinedIcon ico={button} />
            </button>
        {/each}
    </div>
    </Portal>
{/if}

{#if composerFullscreen}
    <OverlayPortal>
    <div class="risu-layer-overlay fixed inset-0 h-dvh bg-bgcolor flex flex-col p-4">
        <div class="mx-auto w-full max-w-3xl flex flex-col flex-1 min-h-0">
            <div class="flex items-center justify-between mb-2">
                <span class="text-textcolor text-sm">{language.chatInputExpandTitle}</span>
                <button onclick={exitFullscreen} aria-label="minimize"
                        class="shrink-0 flex justify-center items-center w-9 h-9 rounded-full text-textcolor risu-interactive-primary-soft transition-colors">
                    <Minimize2Icon size={18} />
                </button>
            </div>
            <textarea
                    bind:value={messageInput}
                    bind:this={fullscreenEle}
                    onblur={persistDraftNow}
                    placeholder={language.enterMessageToPersona(activePersonaName)}
                    class="risu-field-border flex-1 min-h-0 w-full resize-none rounded-md bg-transparent p-3 text-textcolor text-base outline-hidden overflow-y-auto"
            ></textarea>
            <div class="flex justify-end mt-3">
                <button onclick={sendFullscreen} aria-label="send"
                        class="flex items-center gap-1 px-4 h-10 rounded-full bg-primary text-white hover:bg-primary/80 transition-colors">
                    <SendIcon size={18} />
                    <span>{language.send}</span>
                </button>
            </div>
        </div>
    </div>
    </OverlayPortal>
{/if}

<FullscreenImageViewer
    open={inlayViewerOpen}
    src={inlayViewerSrc}
    alt={inlayViewerId}
    title={currentInlayViewerItem?.name ?? inlayViewerId}
    subtitle={inlayViewerId}
    position={inlayViewerIndex}
    total={inlayViewerEntries.length}
    canGoPrev={inlayViewerIndex > 0}
    canGoNext={inlayViewerIndex >= 0 && inlayViewerIndex < inlayViewerEntries.length - 1}
    metadataLabel={language.inlayGallery.inlayInfo}
    closeLabel={language.goback}
    onClose={closeInlayViewer}
    onPrev={() => moveInlayViewer(-1)}
    onNext={() => moveInlayViewer(1)}
    onDelete={(currentInlayViewerEntry?.messageIndex ?? -1) >= 0 ? deleteCurrentInlayReference : undefined}
    onDownload={downloadCurrentInlay}
>
    {#snippet actions()}
        {#if currentInlayViewerItem}
            <AssetViewerActions
                onCopy={copyCurrentInlayReference}
                onDownload={downloadCurrentInlay}
                onDelete={(currentInlayViewerEntry?.messageIndex ?? -1) >= 0 ? deleteCurrentInlayReference : undefined}
            />
        {/if}
    {/snippet}

    {#snippet metadataOverlay()}
        {#if currentInlayViewerItem}
            <InlayViewerMetadata
                item={currentInlayViewerItem}
                characterName={currentCharacter?.name ?? null}
                chatName={currentChatSlot?.name ?? null}
            />
        {/if}
    {/snippet}
</FullscreenImageViewer>

<style>
    .chat-composer-sticky-backdrop {
        background: var(--no-chat-background, var(--risu-theme-darkbg));
    }

    .chat-side-navigation {
        bottom: calc(10rem + env(safe-area-inset-bottom, 0px));
    }

    :global(.default-chat-screen > :not([data-chat-scroll-anchor])) {
        overflow-anchor: none;
    }

    :global(.default-chat-screen > [data-chat-scroll-phase]) {
        width: 100%;
        height: 0;
        min-height: 0;
        margin-top: auto;
        flex: 0 0 auto;
        overflow-anchor: none;
        pointer-events: none;
    }

    :global(.default-chat-screen > [data-chat-scroll-anchor]) {
        width: 100%;
        height: 1px;
        min-height: 1px;
        flex: 0 0 1px;
        overflow-anchor: auto;
        pointer-events: none;
    }

    /* While a finger or pointer owns the scroll position, browser viewport
       resizing must not make the native bottom anchor pull against it. */
    :global(.default-chat-screen[data-chat-direct-manipulation] > [data-chat-scroll-anchor]),
    :global(.default-chat-screen[data-chat-history-read] > [data-chat-scroll-anchor]) {
        overflow-anchor: none;
    }

    .chat-process-stage-1{
        border-top-color: var(--risu-theme-primary);
        border-left-color: var(--risu-theme-primary);
    }

    .chat-process-stage-2{
        border-top-color: var(--risu-theme-draculared);
        border-left-color: var(--risu-theme-draculared);
    }

    .chat-process-stage-3{
        border-top-color: var(--risu-theme-success);
        border-left-color: var(--risu-theme-success);
    }

    .chat-process-stage-4{
        border-top-color: var(--risu-theme-scoped);
        border-left-color: var(--risu-theme-scoped);
    }


    @keyframes spin {

        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
    }

    /* gemini-cache-keeper compat: the plugin injects #gck-cache-timer into the composer
       (found via the .plugin-compat-items-stretch hook) and absolutely positions it over
       the send button — which now overlaps the expand button and floats at the composer's
       vertical center. Re-flow it as an in-line flex item: order:0 (default, appended last)
       places it just left of the expand button (order-1) and send button (order-2). */
    :global(.plugin-compat-items-stretch #gck-cache-timer) {
        position: relative !important;  /* stay a positioned ancestor so the popup still anchors to it */
        inset: auto !important;         /* clear the plugin's top/right offsets */
        transform: none !important;     /* clear translateY(-50%) */
        margin-left: auto;              /* right-align the trailing cluster when the composer wraps (multiline) */
    }
    /* when the timer is present it owns the auto margin, so drop the expand button's own
       ml-auto to avoid a double gap splitting the timer away from the buttons */
    :global(.plugin-compat-items-stretch:has(#gck-cache-timer) .composer-expand-btn) {
        margin-left: 0;
    }
</style>
