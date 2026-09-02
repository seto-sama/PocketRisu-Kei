<script lang="ts">
    import type { Snippet } from 'svelte';

    interface Props {
        title?: string;
        description?: string;
        stacked?: boolean;
        className?: string;
        settingId?: string;
        control?: Snippet;
    }

    let {
        title,
        description,
        stacked = false,
        className = '',
        settingId,
        control,
    }: Props = $props();
</script>

<div
    class="py-3 border-t border-darkborderc {className}"
    class:flex={!stacked}
    class:items-center={!stacked}
    class:justify-between={!stacked}
    class:gap-3={!stacked}
    data-setting-id={settingId}
>
    <div class="flex flex-col min-w-0">
        <span class="text-sm text-textcolor">{title}</span>
        {#if description}
            <p class="text-xs text-textcolor2 mt-0.5">{description}</p>
        {/if}
    </div>
    {#if stacked}
        <div class="mt-2">{@render control?.()}</div>
    {:else}
        <div class="flex items-center shrink-0">{@render control?.()}</div>
    {/if}
</div>
