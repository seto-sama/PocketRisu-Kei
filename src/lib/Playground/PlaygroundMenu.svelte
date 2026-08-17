<script lang="ts">
    import { ArrowLeft } from "@lucide/svelte";
    import { language } from "src/lang";
    import { PlaygroundStore, SizeStore } from "src/ts/stores.svelte";
    import PlaygroundEmbedding from "./PlaygroundEmbedding.svelte";
    import PlaygroundTokenizer from "./PlaygroundTokenizer.svelte";
    import PlaygroundJinja from "./PlaygroundJinja.svelte";
    import PlaygroundParser from "./PlaygroundParser.svelte";
    import ToolConversion from "./ToolConversion.svelte";

    import PlaygroundTranslation from "./PlaygroundTranslation.svelte";
    import PlaygroundMcp from "./PlaygroundMCP.svelte";
    import PlaygroundDocs from "./PlaygroundDocs.svelte";

</script>

<div class="h-full w-full flex flex-col overflow-y-auto items-center">
    {#if $PlaygroundStore === 1}
        <h2 class="text-4xl text-textcolor my-6 font-black relative">{language.playground.playground}</h2>
        <div class="grid grid-cols-1 gap-4 md:grid-cols-2 w-full max-w-4xl p-2">
            <button class="bg-darkbg rounded-md p-6 flex flex-col transition-shadow hover:ring-1" onclick={() => {
                PlaygroundStore.set(13)
            }}>
                <h1 class="text-2xl font-bold text-start">CBS Doc</h1>
            </button>
            <button class="bg-darkbg rounded-md p-6 flex flex-col transition-shadow hover:ring-1" onclick={() => {
                PlaygroundStore.set(3)
            }}>
                <h1 class="text-2xl font-bold text-start">{language.embedding}</h1>
            </button>
            <button class="bg-darkbg rounded-md p-6 flex flex-col transition-shadow hover:ring-1" onclick={() => {
                PlaygroundStore.set(4)
            }}>
                <h1 class="text-2xl font-bold text-start">{language.tokenizer}</h1>
            </button>
            <button class="bg-darkbg rounded-md p-6 flex flex-col transition-shadow hover:ring-1" onclick={() => {
                PlaygroundStore.set(6)
            }}>
                <h1 class="text-2xl font-bold text-start">Jinja</h1>
            </button>
            <button class="bg-darkbg rounded-md p-6 flex flex-col transition-shadow hover:ring-1" onclick={() => {
                PlaygroundStore.set(8)
            }}>
                <h1 class="text-2xl font-bold text-start">Parser</h1>
            </button>
            <button class="bg-darkbg rounded-md p-6 flex flex-col transition-shadow hover:ring-1" onclick={() => {
                PlaygroundStore.set(11)
            }}>
                <h1 class="text-2xl font-bold text-start">{language.translator}</h1>
            </button>
            <button class="bg-darkbg rounded-md p-6 flex flex-col transition-shadow hover:ring-1" onclick={() => {
                PlaygroundStore.set(12)
            }}>
                <h1 class="text-2xl font-bold text-start">MCP</h1>
            </button>
            <button class="bg-darkbg rounded-md p-6 flex flex-col transition-shadow hover:ring-1" onclick={() => {
                PlaygroundStore.set(101)
            }}>
                <h1 class="text-2xl font-bold text-start">{language.promptConvertion}</h1>
            </button>
        </div>
    {:else}
        {#if $SizeStore.w < 1024}
            <div class="mt-14"></div>
        {/if}
        <div class="w-full max-w-4xl flex flex-col p-2">
            <div class="flex items-center mt-4">
                <button class="mr-2 text-textcolor2 risu-interactive-accent" onclick={() => ($PlaygroundStore = 1)}>
                <ArrowLeft/>
                </button>
            </div>

            {#if $PlaygroundStore === 3}
                <PlaygroundEmbedding/>
            {/if}
            {#if $PlaygroundStore === 4}
                <PlaygroundTokenizer/>
            {/if}
            {#if $PlaygroundStore === 6}
                <PlaygroundJinja/>
            {/if}
            {#if $PlaygroundStore === 8}
                <PlaygroundParser/>
            {/if}  
            {#if $PlaygroundStore === 11}
                <PlaygroundTranslation/>
            {/if}
            {#if $PlaygroundStore === 12}
                <PlaygroundMcp/>
            {/if}
            {#if $PlaygroundStore === 13}
                <PlaygroundDocs/>
            {/if}
            {#if $PlaygroundStore === 101}
                <ToolConversion/>
            {/if}  
        </div>
    {/if}
</div>
