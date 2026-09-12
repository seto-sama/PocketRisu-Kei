<script lang="ts" module>
    export type ListActionBarMode = 'inline' | 'footer';
</script>

<script lang="ts">
    import type { Snippet } from 'svelte';
    import type { HTMLAttributes } from 'svelte/elements';
    import { cn } from 'src/lib/utils';
    import IconButtonGroup from './IconButtonGroup.svelte';
    import type { IconButtonSize } from './IconButton.svelte';

    type Props = HTMLAttributes<HTMLDivElement> & {
        mode?: ListActionBarMode;
        size?: IconButtonSize;
        iconSize?: number;
        cellSize?: number;
        className?: string;
        children: Snippet;
    };

    let {
        mode = 'inline',
        size = 'default',
        iconSize,
        cellSize,
        class: classAttr = '',
        className = '',
        children,
        ...rest
    }: Props = $props();
</script>

<IconButtonGroup
    {size}
    {iconSize}
    {cellSize}
    className={cn(
        'mt-2 w-full',
        mode === 'inline' && 'border-t border-selected pt-2',
        mode === 'footer' && 'list-action-bar-footer sticky border-t border-selected py-2',
        classAttr,
        className,
    )}
    data-list-action-bar
    data-mode={mode}
    {...rest}
>
    {@render children()}
</IconButtonGroup>

<style>
    :global(.list-action-bar-footer) {
        bottom: calc(var(--list-action-bar-footer-offset, 0px) + env(safe-area-inset-bottom));
        z-index: var(--risu-z-sticky);
        background: var(--risu-surface-background, transparent);
    }
</style>
