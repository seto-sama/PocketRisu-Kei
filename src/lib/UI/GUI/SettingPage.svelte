<script lang="ts">
    import type { Snippet } from "svelte";

    let {
        title,
        children,
    }: {
        title?: string;
        children?: Snippet;
    } = $props();
</script>

{#if title}
    <h2 class="mb-4 text-2xl font-bold mt-2">{title}</h2>
{/if}
<div class="flex flex-col">
    {@render children?.()}
</div>
