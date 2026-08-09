<script lang="ts">
    import { ParseMarkdown, risuChatParser } from "src/ts/parser/parser.svelte";
    import { type character } from "src/ts/storage/database.svelte";
    import { DBState } from 'src/ts/stores.svelte';
    import { ChatRoomReloadPointer, moduleBackgroundEmbedding, ReloadGUIPointer, selIdState } from "src/ts/stores.svelte";

    let backgroundHTML = $derived(DBState.db?.characters?.[selIdState.selId]?.backgroundHTML)
    let currentChar:character = $derived(DBState.db?.characters?.[selIdState.selId])

    function splitBackgroundAudio(html: string) {
        const audioPlayers: string[] = []
        const content = html.replace(
            /<div(?=[^>]*\bdata-risu-audio-player="1")[^>]*><\/div>/gi,
            (player) => {
                audioPlayers.push(player)
                return ''
            },
        )
        return { content, audioPlayers }
    }

</script>


{#if backgroundHTML || $moduleBackgroundEmbedding}
    {#if selIdState.selId > -1}
        {#key `${$ReloadGUIPointer}|${$ChatRoomReloadPointer}`}
            {#await ParseMarkdown(risuChatParser((backgroundHTML || '') + '\n' + ($moduleBackgroundEmbedding || ''), {chara:currentChar}), currentChar, 'back') then md}
                {@const background = splitBackgroundAudio(md)}
                <div class="absolute top-0 left-0 w-full h-full">
                    {@html background.content}
                </div>
                {#if background.audioPlayers.length > 0}
                    <div class="pointer-events-auto fixed left-1/2 top-4 z-20 flex w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 flex-col items-center gap-2">
                        {#each background.audioPlayers as player}
                            {@html player}
                        {/each}
                    </div>
                {/if}
            {/await}
        {/key}
    {/if}
{/if}
