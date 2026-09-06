<script lang="ts">
    import { cn } from 'src/lib/utils';
    import Tooltip from './Tooltip.svelte';

    interface Tab {
        label: string;
        value: number;
        description?: string;
    }

    let {
        tabs,
        selected = $bindable(0),
        className = '',
    }: {
        tabs: Tab[];
        selected?: number;
        className?: string;
    } = $props();
</script>

{#snippet tabButton(tab: Tab, props: Record<string, unknown> = {})}
        <button
            {...props}
            role="tab"
            aria-selected={selected === tab.value}
            class="relative px-4 py-2 text-sm whitespace-nowrap shrink-0 transition-colors
                {selected === tab.value
                    ? 'text-maintext'
                    : 'text-subtext risu-interactive-foreground'}"
            onclick={() => selected = tab.value}
        >
            {tab.label}
            {#if selected === tab.value}
                <span class="absolute bottom-0 left-0 right-0 h-0.5 bg-primary"></span>
            {/if}
        </button>
{/snippet}

<div class={cn("setting-tabs flex w-full border-b border-darkborderc mb-4 overflow-x-auto", className)} role="tablist">
    {#each tabs as tab}
        {#if tab.description}
            <Tooltip>
                {#snippet trigger(props)}
                    {@render tabButton(tab, props)}
                {/snippet}
                <span class="whitespace-pre-line">{tab.description}</span>
            </Tooltip>
        {:else}
            {@render tabButton(tab)}
        {/if}
    {/each}
</div>

<style>
    .setting-tabs {
        scrollbar-width: none;
        -ms-overflow-style: none;
    }
    .setting-tabs::-webkit-scrollbar {
        display: none;
    }
</style>
