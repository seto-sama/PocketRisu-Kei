<script lang="ts">
    import type { character, Message } from 'src/ts/storage/database.svelte'
    import Chats from './Chats.svelte'

    let {
        messages,
        currentCharacter,
        roomIsStreaming = false,
        roomIsResponding = roomIsStreaming,
        imageRerollingMessageId = null,
        onReroll = () => {},
    }: {
        messages: Message[]
        currentCharacter: character
        roomIsStreaming?: boolean
        roomIsResponding?: boolean
        imageRerollingMessageId?: string | null
        onReroll?: (idx?: number) => void
    } = $props()

    let hasNewUnreadMessage = $state(false)
</script>

<div class="chat-test-scroll-host">
    <Chats
        {messages}
        {currentCharacter}
        chatRoomId="chat-1"
        {onReroll}
        unReroll={() => {}}
        currentUsername="User"
        userIcon="user.png"
        loadPages={30}
        {roomIsStreaming}
        {roomIsResponding}
        {imageRerollingMessageId}
        bind:hasNewUnreadMessage
    />
</div>
<output data-new-message-state>{hasNewUnreadMessage ? 'unread' : 'read'}</output>
