<script lang="ts">
    import type { Snippet } from 'svelte';

    interface Props {
        title: string;
        className?: string;
        titleClass?: string;
        children?: Snippet;
    }

    let {
        title,
        className = 'mt-8 first:mt-2',
        titleClass = 'text-base font-bold',
        children
    }: Props = $props();
</script>

<div class={className}>
    <h3 class={titleClass}>{title}</h3>
    <div class="mt-2">
        {@render children?.()}
    </div>
</div>
