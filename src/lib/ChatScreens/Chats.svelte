<script lang="ts">
    import type { character, Message } from 'src/ts/storage/database.svelte';
    import type { ComponentProps } from 'svelte';
    import Chat from './Chat.svelte';
    import { getCharImage } from 'src/ts/characters';
    import { createSimpleCharacter, DBState, ReloadChatPointer } from 'src/ts/stores.svelte';
    import { chatFoldedStateMessageIndex } from 'src/ts/globalApi.svelte';
    import { didNewResponseComplete, getCompletedResponseAction, isChatNearBottom, type ChatResponseSnapshot, type ChatScrollController } from './chatScroll';
    import { createRevenantChatTranslationRecoveryContext, type RevenantChatTranslationRecoveryScope } from 'src/ts/process/revenant/recovery';
    import {
        findGenerationTargetMessageIndex,
        isGenerationOwnedMessage,
    } from 'src/ts/process/revenant/chatGeneration';

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
        imageRerollingMessageId = null,
        loadPages,
        userIconPortrait,
        getScrollController = () => null,
        hasNewUnreadMessage = $bindable(false)
    }:{
        messages: Message[]
        currentCharacter: character
        onReroll: (idx?: number) => void
        onNextSwipe?: (idx?: number) => void
        unReroll: (idx?: number) => void
        onDeleteSwipe?: (idx?: number) => void
        currentUsername: string
        userIcon: string
        chatRoomId: string
        roomIsStreaming?: boolean
        roomIsResponding?: boolean
        imageRerollingMessageId?: string | null
        loadPages: number
        userIconPortrait?: boolean
        getScrollController?: () => ChatScrollController | null
        hasNewUnreadMessage?: boolean
    } = $props();

    let chatBody: HTMLDivElement;
    type ChatRenderEntry = {
        key: string
        props: ComponentProps<typeof Chat>
        inputs: Readonly<Record<string, unknown>>
    }

    const renderEntryCache = new Map<string, ChatRenderEntry>()
    const fallbackMessageKeys = new WeakMap<Message, string>()
    const noop = () => {}
    let nextFallbackMessageKey = 0
    const translationRecoveryContext = createRevenantChatTranslationRecoveryContext()

    function hasSameInputs(
        previous: Readonly<Record<string, unknown>>,
        next: Readonly<Record<string, unknown>>,
    ) {
        for (const key in next) {
            if (!Object.is(previous[key], next[key])) return false
        }
        return true
    }

    function getMessageKey(chatRoomId: string, message: Message): string {
        if (message.chatId) return `${chatRoomId}:${message.chatId}`
        let fallbackKey = fallbackMessageKeys.get(message)
        if (!fallbackKey) {
            fallbackKey = `fallback:${nextFallbackMessageKey++}`
            fallbackMessageKeys.set(message, fallbackKey)
        }
        return `${chatRoomId}:${fallbackKey}`
    }

    const getChatRenderEntries = (): ChatRenderEntry[] => {
        const entries: ChatRenderEntry[] = []
        const visibleKeys = new Set<string>()
        const charImage = stableCharacterImage
        const userImage = stableUserImage
        const simpleChar = stableSimpleCharacter
        const roomKey = `${currentCharacter.chaId ?? ''}:${chatRoomId}`
        const translationRecoveryScope = stableTranslationRecoveryScope
        let loadStart = Math.max(0, messages.length - loadPages)
        let loadEnd = messages.length - 1

        // Find the last real (non-comment, non-disabled) char message index
        // Only show reroll if it's the actual last non-disabled message
        const lastRealCharIdx = findGenerationTargetMessageIndex(messages)

        if(chatFoldedStateMessageIndex.index !== -1){
            loadStart = Math.max(0, chatFoldedStateMessageIndex.index - loadPages)
            loadEnd = chatFoldedStateMessageIndex.index
        }

        const showPreviousChatSwipeButtons = DBState.db.showPreviousChatSwipeButtons;
        // This is the explicit invalidation boundary for changes originating
        // outside the deeply reactive database proxy.
        void $ReloadChatPointer

        for(let i=loadStart ; i <= loadEnd; i++){
            if(i >= messages.length) break;
            const message = messages[i];
            const isImageGeneration = message.kind === 'imageGeneration';
            const displayMessage = message.recoveryDisplayData ?? message.data;
            const messageLargePortrait = message.role === 'user' ? (userIconPortrait ?? false) : ((currentCharacter as character).largePortrait ?? false);
            const isRerollTarget = i === lastRealCharIdx;
            const generationOwned = isGenerationOwnedMessage({
                message,
                messageIndex: i,
                generationTargetIndex: lastRealCharIdx,
                roomIsResponding,
            }) || (
                imageRerollingMessageId !== null
                && imageRerollingMessageId !== undefined
                && message.chatId === imageRerollingMessageId
            );
            const showHistoricalSwipes = showPreviousChatSwipeButtons && message.role === 'char' && !message.isComment && !isRerollTarget && (message.swipes?.length ?? 0) > 1;
            const showHistoricalImageReroll = isImageGeneration && !message.isComment && !isRerollTarget;
            const showSwipeControls = isRerollTarget || showHistoricalSwipes || showHistoricalImageReroll;
            const swipeNavigationOnly = showHistoricalSwipes && !isImageGeneration;
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
            const adjacentSwipeMessages = swipes && swipes.length > 1
                ? [
                    swipes[(swipeId - 1 + swipes.length) % swipes.length],
                    swipes[(swipeId + 1) % swipes.length],
                ].filter((swipe): swipe is string => typeof swipe === 'string' && swipe !== displayMessage)
                : []
            const key = getMessageKey(roomKey, message)
            visibleKeys.add(key)
            const totalLengthPointer = i > messages.length - 6 ? messages.length : 0
            const messageImage = message.role === 'user' ? userImage : charImage
            const displayName = message.role === 'user' ? currentUsername : currentCharacter.name
            const isComment = message.isComment ?? false
            const disabled = message.disabled ?? false
            const rerollIcon = showSwipeControls ? 'force' : false
            const currentPage = showSwipeControls ? swipeId + 1 : 1
            const totalPages = showSwipeControls ? (swipes?.length ?? 1) : 1
            const inputs = {
                displayMessage,
                messageIndex: i,
                totalLengthPointer,
                messageImage,
                onReroll,
                onNextSwipe,
                unReroll,
                onDeleteSwipe,
                rerollIcon,
                showHistoricalSwipes,
                showHistoricalImageReroll,
                swipeNavigationOnly,
                isStreamingMessage,
                generationOwned,
                isImageGeneration,
                simpleChar,
                messageLargePortrait,
                generationModel: message.generationInfo?.model,
                messageRole: message.role,
                isLastMessage: i === messages.length - 1,
                displayName,
                isComment,
                disabled,
                currentPage,
                totalPages,
                translationRecoveryScope,
                messageChatId: message.chatId ?? null,
                swipeId,
                previousSwipeMessage: adjacentSwipeMessages[0] ?? '',
                nextSwipeMessage: adjacentSwipeMessages[1] ?? '',
                getScrollController,
            }
            const cachedEntry = renderEntryCache.get(key)
            if (cachedEntry && hasSameInputs(cachedEntry.inputs, inputs)) {
                entries.push(cachedEntry)
                continue
            }
            const entry: ChatRenderEntry = {
                key,
                inputs,
                props: {
                    message: displayMessage,
                    idx: i,
                    // Chat only uses this value to refresh the five newest bodies.
                    totalLength: totalLengthPointer,
                    img: messageImage,
                    onReroll: () => onReroll(isImageGeneration ? i : undefined),
                    onNextSwipe: showSwipeControls ? () => onNextSwipe(isRerollTarget ? undefined : i) : noop,
                    unReroll: showSwipeControls ? () => unReroll(isRerollTarget ? undefined : i) : noop,
                    onDeleteSwipe: showSwipeControls ? () => onDeleteSwipe(isRerollTarget ? undefined : i) : noop,
                    rerollIcon: showSwipeControls ? 'force' : false,
                    swipeNavigationOnly,
                    isStreamingDisplay: isStreamingMessage,
                    generationOwned,
                    isImageGeneration,
                    hideSender: isImageGeneration,
                    character: simpleChar,
                    largePortrait: messageLargePortrait,
                    messageGenerationInfo: message.generationInfo ? { ...message.generationInfo } : undefined,
                    role: message.role,
                    isLastMessage: i === messages.length - 1,
                    name: displayName,
                    isComment,
                    disabled,
                    currentPage,
                    totalPages,
                    adjacentSwipeMessages,
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
                },
            }
            renderEntryCache.set(key, entry)
            entries.push(entry)
        }

        for (const key of renderEntryCache.keys()) {
            if (!visibleKeys.has(key)) renderEntryCache.delete(key)
        }

        return entries
    };

    // Loading more history should only mount the newly visible messages. Keep
    // shared props and unchanged entries referentially stable so ChatBody's
    // async markdown/translation derivation is not restarted for every item.
    let stableCharacterImage = $derived(getCharImage(currentCharacter.image, 'css'))
    let stableUserImage = $derived(getCharImage(userIcon, 'css'))
    let stableSimpleCharacter = $derived.by(() => createSimpleCharacter(currentCharacter))
    let stableTranslationRecoveryScope = $derived.by((): RevenantChatTranslationRecoveryScope | null =>
        currentCharacter.chaId && chatRoomId
            ? { characterId: currentCharacter.chaId, roomId: chatRoomId }
            : null
    )
    let chatRenderEntries = $derived.by(getChatRenderEntries)

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
        void chatRenderEntries

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
                alwaysScroll: DBState.db.alwaysScrollToNewMessage === true,
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

<div class="flex flex-col" bind:this={chatBody}>
    {#each chatRenderEntries as entry (entry.key)}
        <div class="chat-message-container">
            <Chat {...entry.props} />
        </div>
    {/each}
</div>
