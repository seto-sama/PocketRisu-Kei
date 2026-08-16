<script lang="ts">
    import type { character, Message } from 'src/ts/storage/database.svelte';
    import { mount, onDestroy, unmount, untrack, type ComponentProps } from 'svelte';
    import Chat from './Chat.svelte';
    import { getCharImage } from 'src/ts/characters';
    import { createSimpleCharacter, DBState, ReloadChatPointer } from 'src/ts/stores.svelte';
    import { chatFoldedStateMessageIndex } from 'src/ts/globalApi.svelte';
    import { didNewResponseComplete, getCompletedResponseAction, isChatNearBottom, type ChatResponseSnapshot, type ChatScrollController } from './chatScroll';
    import { createRevenantChatTranslationRecoveryContext, type RevenantChatTranslationRecoveryScope } from 'src/ts/process/revenant/recovery';

    let {
        messages,
        currentCharacter,
        onReroll,
        onNextSwipe = () => {},
        unReroll,
        onDeleteSwipe = () => {},
        currentUsername,
        userIcon,
        chatRoomId,
        roomIsStreaming = false,
        roomIsResponding = roomIsStreaming,
        loadPages,
        userIconPortrait,
        getScrollController = () => null,
        hasNewUnreadMessage = $bindable(false)
    }:{
        messages: Message[]
        currentCharacter: character
        onReroll: () => void
        onNextSwipe?: (idx?: number) => void
        unReroll: (idx?: number) => void
        onDeleteSwipe?: (idx?: number) => void
        currentUsername: string
        userIcon: string
        chatRoomId: string
        roomIsStreaming?: boolean
        roomIsResponding?: boolean
        loadPages: number
        userIconPortrait?: boolean
        getScrollController?: () => ChatScrollController | null
        hasNewUnreadMessage?: boolean
    } = $props();

    let chatBody: HTMLDivElement;
    type ChatMountProps = ComponentProps<typeof Chat>
    type ChatMountEntry = {
        inst: object
        element: HTMLDivElement
        props: ChatMountProps
        characterSource: ChatMountProps['character']
        callbackSources: {
            onNextSwipe: typeof onNextSwipe
            unReroll: typeof unReroll
            onDeleteSwipe: typeof onDeleteSwipe
            rerollTarget: boolean
            showSwipeControls: boolean
        }
    }

    const mountInstances = new Map<string, ChatMountEntry>()
    const fallbackMessageKeys = new WeakMap<Message, string>()
    const noop = () => {}
    let nextFallbackMessageKey = 0
    const translationRecoveryContext = createRevenantChatTranslationRecoveryContext()

    function getMessageKey(chatRoomId: string, message: Message): string {
        if (message.chatId) return `${chatRoomId}:${message.chatId}`
        let fallbackKey = fallbackMessageKeys.get(message)
        if (!fallbackKey) {
            fallbackKey = `legacy:${nextFallbackMessageKey++}`
            fallbackMessageKeys.set(message, fallbackKey)
        }
        return `${chatRoomId}:${fallbackKey}`
    }

    const updateChatBody = () => {
        if (!chatBody) return

        const currentKeys = new Set<string>()
        const charImage = stableCharacterImage
        const userImage = stableUserImage
        const simpleChar = stableSimpleCharacter
        const roomKey = `${currentCharacter.chaId ?? ''}:${chatRoomId}`
        const translationRecoveryScope: RevenantChatTranslationRecoveryScope | null =
            currentCharacter.chaId && chatRoomId
                ? { characterId: currentCharacter.chaId, roomId: chatRoomId }
                : null
        let loadStart = Math.max(0, messages.length - loadPages)
        let loadEnd = messages.length - 1

        // Find the last real (non-comment, non-disabled) char message index
        // Only show reroll if it's the actual last non-disabled message
        let lastRealCharIdx = -1;
        let lastNonDisabledIdx = -1;
        for (let i = messages.length - 1; i >= 0; i--) {
            if (!messages[i].isComment && !messages[i].disabled) {
                lastNonDisabledIdx = i;
                break;
            }
        }
        if (lastNonDisabledIdx >= 0 && messages[lastNonDisabledIdx].role === 'char') {
            lastRealCharIdx = lastNonDisabledIdx;
        }

        if(chatFoldedStateMessageIndex.index !== -1){
            loadStart = Math.max(0, chatFoldedStateMessageIndex.index - loadPages)
            loadEnd = chatFoldedStateMessageIndex.index
        }

        const showPreviousChatSwipeButtons = DBState.db.showPreviousChatSwipeButtons;
        let previousElement: HTMLDivElement | null = null

        for(let i=loadStart ; i <= loadEnd; i++){
            if(i >= messages.length) break;
            const message = messages[i];
            const displayMessage = message.recoveryDisplayData ?? message.data;
            const messageLargePortrait = message.role === 'user' ? (userIconPortrait ?? false) : ((currentCharacter as character).largePortrait ?? false);
            const isRerollTarget = i === lastRealCharIdx;
            const showHistoricalSwipes = showPreviousChatSwipeButtons && message.role === 'char' && !message.isComment && !message.disabled && !isRerollTarget && (message.swipes?.length ?? 0) > 1;
            const showSwipeControls = isRerollTarget || showHistoricalSwipes;
            const isStreamingMessage = message.role === 'char'
                && (
                    message.isRecovering === true
                    || (
                        DBState.db.useStreaming
                        && roomIsStreaming
                        && i === messages.length - 1
                    )
                )
            const swipes = message.swipes;
            const swipeId = message.swipeId ?? 0;
            const key = getMessageKey(roomKey, message)
            const totalLengthPointer = i > messages.length - 6 ? messages.length : 0
            const messageImage = message.role === 'user' ? userImage : charImage
            const displayName = message.role === 'user' ? currentUsername : currentCharacter.name
            const isComment = message.isComment ?? false
            const disabled = message.disabled ?? false
            const rerollIcon = showSwipeControls ? 'force' : false
            const currentPage = showSwipeControls ? swipeId + 1 : 1
            const totalPages = showSwipeControls ? (swipes?.length ?? 1) : 1
            const generationModel = message.generationInfo?.model
            currentKeys.add(key)
            const callbackSources: ChatMountEntry['callbackSources'] = {
                onNextSwipe,
                unReroll,
                onDeleteSwipe,
                rerollTarget: isRerollTarget,
                showSwipeControls,
            }
            let entry = mountInstances.get(key)
            if (!entry) {
                const element = document.createElement('div')
                element.classList.add('chat-message-container')
                const props = $state<ChatMountProps>({
                    message: displayMessage,
                    isLastMemory: false,
                    idx: i,
                    // Chat only uses this value to refresh the five newest bodies.
                    totalLength: totalLengthPointer,
                    img: messageImage,
                    onReroll,
                    onNextSwipe: showSwipeControls ? () => onNextSwipe(isRerollTarget ? undefined : i) : noop,
                    unReroll: showSwipeControls ? () => unReroll(isRerollTarget ? undefined : i) : noop,
                    onDeleteSwipe: showSwipeControls ? () => onDeleteSwipe(isRerollTarget ? undefined : i) : noop,
                    rerollIcon: showSwipeControls ? 'force' : false,
                    swipeNavigationOnly: showHistoricalSwipes,
                    isStreamingDisplay: isStreamingMessage,
                    character: simpleChar,
                    largePortrait: messageLargePortrait,
                    messageGenerationInfo: message.generationInfo ? { ...message.generationInfo } : undefined,
                    role: message.role,
                    name: displayName,
                    isComment,
                    disabled,
                    currentPage,
                    totalPages,
                    renderCacheKey: key,
                    translationRecoveryContext,
                    translationRecoveryScope,
                    translationRecoveryTarget: {
                        kind: 'chat-message',
                        messageChatId: message.chatId ?? null,
                        messageIndex: i,
                        swipeId,
                    },
                    getScrollController,
                })
                const inst = mount(Chat, { target: element, props })
                entry = { inst, element, props, characterSource: simpleChar, callbackSources }
                mountInstances.set(key, entry)
            }
            else {
                untrack(() => {
                    const props = entry.props

                    if (props.message !== displayMessage) props.message = displayMessage
                    if (props.idx !== i) props.idx = i
                    if (props.totalLength !== totalLengthPointer) props.totalLength = totalLengthPointer
                    if (props.img !== messageImage) props.img = messageImage
                    if (props.onReroll !== onReroll) props.onReroll = onReroll
                    if (props.rerollIcon !== rerollIcon) props.rerollIcon = rerollIcon
                    if (props.swipeNavigationOnly !== showHistoricalSwipes) props.swipeNavigationOnly = showHistoricalSwipes
                    if (props.isStreamingDisplay !== isStreamingMessage) props.isStreamingDisplay = isStreamingMessage
                    if (entry.characterSource !== simpleChar) {
                        props.character = simpleChar
                        entry.characterSource = simpleChar
                    }
                    if (props.largePortrait !== messageLargePortrait) props.largePortrait = messageLargePortrait
                    if (Boolean(props.messageGenerationInfo) !== Boolean(message.generationInfo)
                        || props.messageGenerationInfo?.model !== generationModel) {
                        props.messageGenerationInfo = message.generationInfo ? { ...message.generationInfo } : undefined
                    }
                    if (props.role !== message.role) props.role = message.role
                    if (props.name !== displayName) props.name = displayName
                    if (props.isComment !== isComment) props.isComment = isComment
                    if (props.disabled !== disabled) props.disabled = disabled
                    if (props.currentPage !== currentPage) props.currentPage = currentPage
                    if (props.totalPages !== totalPages) props.totalPages = totalPages
                    if (props.getScrollController !== getScrollController) props.getScrollController = getScrollController
                    const recoveryTarget = props.translationRecoveryTarget
                    if (
                        recoveryTarget?.messageChatId !== (message.chatId ?? null)
                        || recoveryTarget?.messageIndex !== i
                        || recoveryTarget?.swipeId !== swipeId
                    ) {
                        props.translationRecoveryTarget = {
                            kind: 'chat-message',
                            messageChatId: message.chatId ?? null,
                            messageIndex: i,
                            swipeId,
                        }
                    }

                    if (entry.callbackSources.onNextSwipe !== onNextSwipe
                        || entry.callbackSources.unReroll !== unReroll
                        || entry.callbackSources.onDeleteSwipe !== onDeleteSwipe
                        || entry.callbackSources.rerollTarget !== isRerollTarget
                        || entry.callbackSources.showSwipeControls !== showSwipeControls) {
                        props.onNextSwipe = showSwipeControls ? () => onNextSwipe(isRerollTarget ? undefined : i) : noop
                        props.unReroll = showSwipeControls ? () => unReroll(isRerollTarget ? undefined : i) : noop
                        props.onDeleteSwipe = showSwipeControls ? () => onDeleteSwipe(isRerollTarget ? undefined : i) : noop
                        entry.callbackSources = callbackSources
                    }
                })
            }

            if (previousElement) {
                if (entry.element.previousElementSibling !== previousElement) {
                    previousElement.after(entry.element)
                }
            }
            else if (chatBody.firstElementChild !== entry.element) {
                chatBody.prepend(entry.element)
            }
            previousElement = entry.element
        }

        for (const [key, entry] of mountInstances) {
            if (currentKeys.has(key)) continue
            unmount(entry.inst)
            entry.element.remove()
            mountInstances.delete(key)
        }
    };

    // Loading more history should only mount the newly visible messages. Keep
    // shared props and unchanged entries referentially stable so ChatBody's
    // async markdown/translation derivation is not restarted for every item.
    let stableCharacterImage = $derived(getCharImage(currentCharacter.image, 'css'))
    let stableUserImage = $derived(getCharImage(userIcon, 'css'))
    let stableSimpleCharacter = $derived.by(() => createSimpleCharacter(currentCharacter))

    onDestroy(() => {
        for (const entry of mountInstances.values()) unmount(entry.inst)
        mountInstances.clear()
    })

    function scrollLatestIntoChatScreen() {
        if(!chatBody) return;
        const element = chatBody.lastElementChild as HTMLElement | null;
        const chatScreen = chatBody.parentElement;
        if(!element || !chatScreen) return;
        getScrollController()?.scrollToElement(element, { block: 'start', behavior: 'instant' });
    }

    export const scrollToLatestMessage = () => {
        if(!chatBody) return;
        hasNewUnreadMessage = false;
        scrollLatestIntoChatScreen();
    }

    let previousResponseSnapshot: ChatResponseSnapshot | null = null;

    $effect(() => {
        void $ReloadChatPointer; // Make $effect track ReloadChatPointer changes
        updateChatBody()

        const roomKey = `${currentCharacter.chaId ?? ''}:${chatRoomId}`
        const lastMsg = messages[messages.length - 1]
        const snapshot: ChatResponseSnapshot = {
            roomKey,
            messageKey: lastMsg ? getMessageKey(roomKey, lastMsg) : null,
            messageCount: messages.length,
            isCharacterResponse: lastMsg?.role === 'char',
            hasContent: (lastMsg?.recoveryDisplayData ?? lastMsg?.data ?? '').length > 0,
            isResponding: roomIsResponding || lastMsg?.isRecovering === true,
        }
        const newMessageButtonEnabled = DBState.db.newMessageButtonStyle !== 'off'

        // Disabling the independent notification button also clears any stale
        // unread affordance that was already visible.
        if (!newMessageButtonEnabled) hasNewUnreadMessage = false

        // A completed response is the notification boundary. While streaming,
        // the scroll controller already follows content if the reader stayed
        // at the bottom; readers browsing history must not be pulled into a
        // partial response on its first token.
        const responseCompleted = didNewResponseComplete(previousResponseSnapshot, snapshot)
        if (responseCompleted) {
            const completedResponseAction = getCompletedResponseAction({
                autoScroll: DBState.db.autoScrollToNewMessage === true,
                buttonEnabled: newMessageButtonEnabled,
                nearBottom: !chatBody?.parentElement
                    || isChatNearBottom(
                        chatBody.parentElement.scrollTop,
                        chatBody.parentElement.scrollHeight,
                        chatBody.parentElement.clientHeight,
                    ),
            })
            if (completedResponseAction === 'scroll') {
                hasNewUnreadMessage = false
                scrollLatestIntoChatScreen()
            }
            else if (completedResponseAction === 'notify') {
                hasNewUnreadMessage = true
            }
        }
        previousResponseSnapshot = snapshot
    })

</script>

<div class="flex flex-col" bind:this={chatBody}></div>
