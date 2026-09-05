<script lang="ts">
    import type { Snippet } from 'svelte';

    interface Props {
        label: string;
        /** Small gray help text rendered under the label. */
        description?: string;
        /** Dim + visually deprioritize the row when its parent toggle is off. */
        dimmed?: boolean;
        children?: Snippet;
    }

    let { label, description, dimmed = false, children }: Props = $props();
</script>

<div class="flex items-center justify-between gap-3 py-2 transition-opacity" class:opacity-40={dimmed}>
    <div class="flex flex-col min-w-0">
        <span class="text-sm text-maintext truncate">{label}</span>
        {#if description}<p class="text-xs text-subtext mt-0.5">{description}</p>{/if}
    </div>
    <div class="shrink-0">{@render children?.()}</div>
</div>
