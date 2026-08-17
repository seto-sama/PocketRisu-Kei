<script lang="ts">
    import { cn } from "src/lib/utils";

    interface Props {
        tags: string[];
        limit?: number;
        className?: string;
    }

    let { tags, limit, className = '' }: Props = $props();

    const visibleTags = $derived(limit === undefined ? tags : tags.slice(0, limit));

    function formatTag(tag: string) {
        return `#${tag.trim().replace(/^#+/, '')}`
    }
</script>

<div class={cn('flex flex-wrap gap-x-2 gap-y-1', className)}>
    {#each visibleTags as tag}
        <span class="text-xs text-primary">{formatTag(tag)}</span>
    {/each}
    {#if limit !== undefined && tags.length > limit}
        <span class="text-xs text-primary">…</span>
    {/if}
</div>
