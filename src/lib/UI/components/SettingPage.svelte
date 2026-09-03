<script lang="ts">
    import type { Snippet } from "svelte";

    let {
        title,
        control,
        children,
    }: {
        title?: string;
        control?: Snippet;
        children?: Snippet;
    } = $props();
</script>

{#if title}
    <div class="mb-4 mt-2 flex items-center justify-between gap-2">
        <h2 class="min-w-0 text-2xl font-bold">{title}</h2>
        {#if control}
            <div class="flex shrink-0 items-center">{@render control()}</div>
        {/if}
    </div>
{/if}
<div class="flex flex-col">
    {@render children?.()}
</div>
