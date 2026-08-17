<script lang="ts">
    import { ColorSchemeTypeStore } from "src/ts/gui/colorscheme";
    import { ParseMarkdown } from "src/ts/parser/parser.svelte";
    import { parseMultilangString, toLangName } from "src/ts/util";
    import { DBState } from "src/ts/stores.svelte";
    import ShButton from "./ShButton.svelte";
    import { cn } from "src/lib/utils";

    interface Props {
        value: string;
        markdown?: boolean;
        showLanguageSelector?: boolean;
        className?: string;
        contentClass?: string;
    }

    let {
        value,
        markdown = false,
        showLanguageSelector = true,
        className = '',
        contentClass = '',
    }: Props = $props();
    let valueObject: {[code:string]:string} = $derived(parseMultilangString(value))

    let userLang = $derived(DBState.db.language)

    let defaultLang = $derived.by(() => {
        if(valueObject[userLang] !== undefined) return userLang
        if(valueObject["en"] !== undefined) return "en"
        return "xx"
    })

    let selectedLang = $state("")
    $effect.pre(() => {
        selectedLang = defaultLang
    });

    let sortedLangs = $derived.by(() => {
        const keys = Object.keys(valueObject)
        const prioritized = keys.find(k => k === userLang)
        if(!prioritized) return { priority: null, rest: keys }
        return {
            priority: prioritized,
            rest: keys.filter(k => k !== prioritized)
        }
    })
</script>

<div class={cn('flex flex-col', className)}>
    {#if showLanguageSelector}
        <div class="flex max-w-fit flex-wrap items-center gap-2 px-1 pb-1">
            {#if sortedLangs.priority}
                {#if sortedLangs.priority !== 'xx' || Object.keys(valueObject).length === 1}
                    <ShButton size="sm" variant={selectedLang === sortedLangs.priority ? 'primary' : 'outline'} className={selectedLang === sortedLangs.priority ? '' : 'text-textcolor2'} aria-pressed={selectedLang === sortedLangs.priority} onclick={(e) => {
                        e.stopPropagation()
                        selectedLang = sortedLangs.priority
                    }}>{toLangName(sortedLangs.priority)}</ShButton>
                {/if}
                {#if sortedLangs.rest.length > 0}
                    <div class="border-l border-l-selected h-6"></div>
                {/if}
            {/if}
            {#each sortedLangs.rest as lang}
                {#if lang !== 'xx' || Object.keys(valueObject).length === 1}
                    <ShButton size="sm" variant={selectedLang === lang ? 'primary' : 'outline'} className={selectedLang === lang ? '' : 'text-textcolor2'} aria-pressed={selectedLang === lang} onclick={(e) => {
                        e.stopPropagation()
                        selectedLang = lang
                    }}>{toLangName(lang)}</ShButton>
                {/if}
            {/each}
        </div>
    {/if}
    {#if markdown}
        <div class={cn('ml-2 max-w-full wrap-break-word text chat chattext prose', contentClass)} class:prose-invert={$ColorSchemeTypeStore === 'dark'}>
            {#await ParseMarkdown(valueObject[selectedLang]) then md} 
                {@html md}
            {/await}
        </div>
    {:else}
        <div class={cn('ml-2 max-w-full wrap-break-word text chat chattext prose', contentClass)} class:prose-invert={$ColorSchemeTypeStore === 'dark'}>
            {valueObject[selectedLang]}
        </div>
    {/if}
</div>
