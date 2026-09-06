<script lang="ts" module>
    export type DocumentationListItem = {
        name:string
        description:string
        aliases?:string[]
    }
</script>

<script lang="ts">
    import EmptyState from "src/lib/UI/components/EmptyState.svelte";
    import Input from './components/Input.svelte'
    import { parseMarkdownSafe } from 'src/ts/parser/parser.svelte'

    interface Props {
        items:DocumentationListItem[]
        searchPlaceholder:string
        aliasesLabel:string
        emptyMessage:string
    }

    let { items, searchPlaceholder, aliasesLabel, emptyMessage }:Props = $props()
    let searchTerm = $state('')

    const filteredItems = $derived.by(() => {
        const query = searchTerm.trim().toLocaleLowerCase()
        if(!query) return items
        return items.filter(item => item.name.toLocaleLowerCase().includes(query)
            || item.description.toLocaleLowerCase().includes(query)
            || item.aliases?.some(alias => alias.toLocaleLowerCase().includes(query)))
    })
</script>

<div class="flex h-full min-h-0 flex-col gap-3">
    <Input
        placeholder={searchPlaceholder}
        className="w-full shrink-0"
        fullwidth
        bind:value={searchTerm}
    />

    <div class="min-h-0 flex-1 overflow-y-auto pr-1">
        {#if filteredItems.length === 0}
            {#if searchTerm.trim()}
                <EmptyState layout="section" />
            {:else}
                <EmptyState title={emptyMessage} description="" layout="section" />
            {/if}
        {:else}
            <div class="grid gap-3">
                {#each filteredItems as item (item.name)}
                    <article class="rounded-md border border-darkborderc bg-lightbg p-3 md:p-4">
                        <h3 class="mb-2 text-base font-semibold text-maintext">{item.name}</h3>
                        <div class="text-sm leading-relaxed text-subtext">
                            {@html parseMarkdownSafe(item.description, { forbidTags: ['mark'] })}
                        </div>

                        {#if item.aliases?.length}
                            <div class="mt-3 flex flex-wrap items-center gap-1.5">
                                <span class="mr-1 text-xs text-subtext">{aliasesLabel}</span>
                                {#each item.aliases as alias}
                                    <code class="rounded-full bg-darkbg px-2 py-1 text-xs text-subtext">{alias}</code>
                                {/each}
                            </div>
                        {/if}
                    </article>
                {/each}
            </div>
        {/if}
    </div>
</div>
