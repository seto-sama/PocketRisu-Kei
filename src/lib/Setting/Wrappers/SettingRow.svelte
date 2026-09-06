<script lang="ts">
    import type { Snippet } from 'svelte';
    import { cn } from 'src/lib/utils';

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
    class={cn('py-3 border-t border-darkborderc', className)}
    class:flex={!stacked}
    class:items-center={!stacked}
    class:justify-between={!stacked}
    class:gap-3={!stacked}
    data-setting-id={settingId}
>
    <div class="flex flex-col min-w-0">
        <span class="text-sm text-maintext">{title}</span>
        {#if description}
            <p class="text-xs text-subtext mt-0.5">{description}</p>
        {/if}
    </div>
    {#if stacked}
        <div class="mt-2">{@render control?.()}</div>
    {:else}
        <div class="flex items-center shrink-0">{@render control?.()}</div>
    {/if}
</div>
