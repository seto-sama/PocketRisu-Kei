<script lang="ts">
    import type { character, Message } from 'src/ts/storage/database.svelte';
    import type { ComponentProps } from 'svelte';
    import Chat from './Chat.svelte';
    import { getCharImage } from 'src/ts/characters';
    import { createSimpleCharacter, DBState, selectedCharID, ReloadChatPointer } from 'src/ts/stores.svelte';
    import { chatFoldedStateMessageIndex } from 'src/ts/globalApi.svelte';
    import { get } from 'svelte/store';
    import { scrollWithinContainer } from './scrollWithin';
    
    const getCurrentChatRoomId = () => {
        const charId = get(selectedCharID);
        if (charId < 0) return null;
        const char = DBState.db.characters[charId];
        if (!char) return null;
        return char.chats?.[char.chatPage]?.id ?? null;
    };

    let {
        messages,
        currentCharacter,
        onReroll,
        onNextSwipe = () => {},
        unReroll,
        onDeleteSwipe = () => {},
        currentUsername,
        userIcon,
        loadPages,
        userIconPortrait,
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
        loadPages: number
        userIconPortrait?: boolean
        hasNewUnreadMessage?: boolean
    } = $props();

    let chatBody: HTMLDivElement;
    type ChatProps = ComponentProps<typeof Chat>

    type ChatRenderEntry = {
        key: string
        message: string
        props: Omit<ChatProps, 'message'>
    }

    //Non-cryptographic hash function to generate a unique hash for each message
    function hashCode(str:string):number {
        let hash = 0;
        for (let i = 0, len = str.length; i < len; i++) {
            let chr = str.charCodeAt(i);
            hash = (hash << 5) - hash + chr;
            hash |= 0; // Convert to 32bit integer
        }
        if(hash == 0){
            hash = 1; // Ensure hash is not zero
        }
        return hash;
    }

    const getChatRenderEntries = (): ChatRenderEntry[] => {
        const entries: ChatRenderEntry[] = []
        const charImage = getCharImage(currentCharacter.image, 'css')
        const userImage = getCharImage(userIcon, 'css')
        const simpleChar = createSimpleCharacter(currentCharacter);
        const chatRoomId = currentCharacter.chats?.[currentCharacter.chatPage]?.id ?? ''
        let loadStart = messages.length - 1
        let loadEnd = messages.length - loadPages

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
            loadStart = chatFoldedStateMessageIndex.index
            loadEnd = Math.max(0, chatFoldedStateMessageIndex.index - loadPages)
        }

        const showPreviousChatSwipeButtons = DBState.db.showPreviousChatSwipeButtons;

        for(let i=loadStart ; i >= loadEnd; i--){
            if(i < 0) break; // Prevent out of bounds
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
                        && currentCharacter.chats?.[currentCharacter.chatPage]?.isStreaming
                        && i === messages.length - 1
                    )
                )
            const swipes = message.swipes;
            const swipeId = message.swipeId ?? 0;
            entries.push({
                key: `${chatRoomId}:${message.chatId ?? `index:${i}:${hashCode(displayMessage)}`}`,
                message: displayMessage,
                props: {
                    isLastMemory: false,
                    idx: i,
                    totalLength: messages.length,
                    img: message.role === 'user' ? userImage : charImage,
                    onReroll: onReroll,
                    onNextSwipe: showSwipeControls ? () => onNextSwipe(isRerollTarget ? undefined : i) : () => {},
                    unReroll: showSwipeControls ? () => unReroll(isRerollTarget ? undefined : i) : () => {},
                    onDeleteSwipe: showSwipeControls ? () => onDeleteSwipe(isRerollTarget ? undefined : i) : () => {},
                    rerollIcon: showSwipeControls ? 'force' : false,
                    swipeNavigationOnly: showHistoricalSwipes,
                    isStreamingDisplay: isStreamingMessage,
                    character: simpleChar,
                    largePortrait: message.role === 'user' ? (userIconPortrait ?? false) : ((currentCharacter as character).largePortrait ?? false),
                    messageGenerationInfo: message.generationInfo ? { ...message.generationInfo } : undefined,
                    role: message.role,
                    name: message.role === 'user' ? currentUsername : currentCharacter.name,
                    isComment: message.isComment ?? false,
                    disabled: message.disabled ?? false,
                    ...(showSwipeControls ? {
                        currentPage: (swipeId ?? 0) + 1,
                        totalPages: swipes?.length ?? 1,
                    } : {}),
                },
            })
        }

        return entries
    };

    let chatRenderEntries = $derived.by(getChatRenderEntries)

    function checkIfAtBottom() {
        if (!chatBody || !chatBody.parentElement) return true;
        const sc = chatBody.parentElement;
        const lastEl = chatBody.firstElementChild;
        if (!lastEl) return true;
        const rect = lastEl.getBoundingClientRect();
        const scRect = sc.getBoundingClientRect();
        return rect.top <= scRect.bottom + 100;
    }

    function scrollLatestIntoChatScreen() {
        if(!chatBody) return;
        const element = chatBody.firstElementChild as HTMLElement | null;
        const chatScreen = chatBody.parentElement;
        if(!element || !chatScreen) return;
        scrollWithinContainer(element, chatScreen, { block: 'start', behavior: 'instant' });
    }

    export const scrollToLatestMessage = () => {
        if(!chatBody) return;
        hasNewUnreadMessage = false;
        scrollLatestIntoChatScreen();
    }

    let previousLength = 0;
    let previousChatRoomId: string | null = null;

    $effect(() => {
        void $ReloadChatPointer; // Make $effect track ReloadChatPointer changes
        void chatRenderEntries;
        const wasAtBottom = checkIfAtBottom();

        const currentChatRoomId = getCurrentChatRoomId();
        const isSameChat = currentChatRoomId === previousChatRoomId;

        // Only auto-scroll if it's the same chat and new messages were added
        if(isSameChat && messages.length > previousLength){
            const lastMsg = messages[messages.length - 1];
            if(lastMsg && lastMsg.role === 'char' && DBState.db.autoScrollToNewMessage){
                if(wasAtBottom || DBState.db.alwaysScrollToNewMessage){
                    setTimeout(() => {
                        scrollLatestIntoChatScreen();
                    }, 700);
                } else {
                    hasNewUnreadMessage = true;
                }
            }
        }
        previousLength = messages.length;
        previousChatRoomId = currentChatRoomId;
    })

</script>

<div class="flex flex-col-reverse" bind:this={chatBody}>
    {#each chatRenderEntries as entry (entry.key)}
        <div class="chat-message-container">
            <Chat message={entry.message} {...entry.props} />
        </div>
    {/each}
</div>
