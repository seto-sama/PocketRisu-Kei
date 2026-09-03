<script lang="ts">
    import type { Snippet } from "svelte";

    interface Props {
        itemCount: number;
        minColumnWidth?: number;
        gap?: number;
        className?: string;
        children: Snippet<[number]>;
    }

    let {
        itemCount,
        minColumnWidth = 104,
        gap = 8,
        className = '',
        children,
    }: Props = $props();

    let containerWidth = $state(0);

    function measureWidth(node: HTMLElement) {
        let animationFrame = 0;
        const updateWidth = () => {
            animationFrame = 0;
            containerWidth = node.clientWidth;
        };
        const scheduleUpdate = () => {
            if (animationFrame) return;
            animationFrame = requestAnimationFrame(updateWidth);
        };
        const resizeObserver = new ResizeObserver(scheduleUpdate);

        resizeObserver.observe(node);
        scheduleUpdate();

        return {
            destroy() {
                resizeObserver.disconnect();
                if (animationFrame) cancelAnimationFrame(animationFrame);
            },
        };
    }

    const columnCount = $derived(Math.min(
        Math.max(itemCount, 1),
        Math.max(1, Math.floor((containerWidth + gap) / (minColumnWidth + gap))),
    ));
    const columns = $derived.by(() => {
        const result = Array.from({ length: columnCount }, () => [] as number[]);
        for (let index = 0; index < itemCount; index++) {
            result[index % columnCount].push(index);
        }
        return result;
    });
</script>

<div
    class="flex w-full items-start {className}"
    style:gap={`${gap}px`}
    use:measureWidth
>
    {#if containerWidth > 0}
        {#each columns as column}
            <div class="flex min-w-0 flex-1 flex-col" style:gap={`${gap}px`}>
                {#each column as index (index)}
                    {@render children(index)}
                {/each}
            </div>
        {/each}
    {/if}
</div>
