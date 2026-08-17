<script lang="ts">
    import { SearchIcon } from '@lucide/svelte';
    import { language } from 'src/lang';
    import ShDialog from 'src/lib/UI/GUI/ShDialog.svelte';
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

<ShDialog bind:open size="default" tier="alert" closeOnEscape closable={false} ariaLabel={language.searchSettingsPlaceholder}>
    <div class="risu-field-border flex items-center gap-2 rounded-md px-3 py-2">
        <SearchIcon size={18} class="text-textcolor2 shrink-0" />
        <!-- svelte-ignore a11y_autofocus -->
        <input
            class="bg-transparent text-textcolor outline-hidden min-w-0 grow"
            placeholder={language.searchSettingsPlaceholder}
            bind:value={query}
            onkeydown={handleKeydown}
            autofocus
        />
    </div>
    <div class="flex flex-col overflow-y-auto h-[50vh] mt-2 pr-1">
        {#if !query.trim()}
            <span class="text-textcolor2 text-sm px-1 py-2">{language.searchSettingsHint}</span>
        {:else if results.length === 0}
            <span class="text-textcolor2 text-sm px-1 py-2">{language.searchSettingsNoResults}</span>
        {:else}
            {#each results as result (result.key)}
                <button class="flex flex-col items-start text-left px-2 py-2 rounded-md risu-interactive-surface-strong shrink-0" onclick={() => select(result)}>
                    <span class="text-sm text-textcolor">{result.label}</span>
                    {#if result.location}<span class="text-xs text-textcolor2">{result.location}</span>{/if}
                    {#if result.help}<span class="text-xs text-textcolor2 line-clamp-2">{result.help}</span>{/if}
                </button>
            {/each}
        {/if}
    </div>
</ShDialog>
