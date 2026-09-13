<script lang="ts">
    import EmptyState from "src/lib/UI/components/EmptyState.svelte";
    import { SearchIcon } from '@lucide/svelte';
    import { language } from 'src/lang';
    import Dialog from '../UI/components/Dialog.svelte';
    import { DBState } from 'src/ts/stores.svelte';
    import { navigateToSearchResult, searchSettings, type SettingSearchResult } from 'src/ts/setting/searchIndex';
    import type { SettingContext } from 'src/ts/setting/types';

    interface Props { open?: boolean }
    let { open = $bindable(false) }: Props = $props();
    let query = $state('');
    let ctx: SettingContext = $derived({ db: DBState.db });
    let results = $derived(searchSettings(query, ctx));

    $effect(() => {
        if (open) query = '';
    });

    function select(result: SettingSearchResult) {
        open = false;
        navigateToSearchResult(result);
    }

    function handleKeydown(event: KeyboardEvent) {
        if (event.key === 'Enter' && results.length > 0) {
            event.preventDefault();
            select(results[0]);
        }
    }
</script>

<Dialog bind:open size="default" closable={false} ariaLabel={language.searchSettingsPlaceholder}>
    <div class="risu-field-border flex items-center gap-2 rounded-md px-2.5 py-2">
        <SearchIcon size={18} class="text-subtext shrink-0" />
        <!-- svelte-ignore a11y_autofocus -->
        <input
            class="bg-transparent text-maintext outline-hidden min-w-0 grow"
            placeholder={language.searchSettingsPlaceholder}
            bind:value={query}
            onkeydown={handleKeydown}
            autofocus
        />
    </div>
    <div class="mt-2 flex flex-col pr-1">
        {#if !query.trim()}
            <span class="text-subtext text-sm px-1 py-2">{language.searchSettingsHint}</span>
        {:else if results.length === 0}
            <EmptyState layout="section" density="compact" />
        {:else}
            {#each results as result (result.key)}
                <button class="flex flex-col items-start text-left px-2 py-2 rounded-md risu-interactive-surface-strong shrink-0" onclick={() => select(result)}>
                    <span class="text-sm text-maintext">{result.label}</span>
                    {#if result.location}<span class="text-xs text-subtext">{result.location}</span>{/if}
                    {#if result.help}<span class="text-xs text-subtext line-clamp-2">{result.help}</span>{/if}
                </button>
            {/each}
        {/if}
    </div>
</Dialog>
