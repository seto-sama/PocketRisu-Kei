<script lang="ts" module>
    export type ActionBarMode = 'inline' | 'footer';
</script>

<script lang="ts">
    import type { Snippet } from 'svelte';
    import type { HTMLAttributes } from 'svelte/elements';
    import { cn } from 'src/lib/utils';

    type Props = HTMLAttributes<HTMLDivElement> & {
        mode?: ActionBarMode;
        className?: string;
        children: Snippet;
    };

    let { mode = 'inline', class: classAttr = '', className = '', children, ...rest }: Props = $props();
</script>

<div
    class={cn(
        'mt-2 flex w-full items-center',
        mode === 'inline' && 'border-t border-selected pt-2',
        mode === 'footer' && 'action-bar-footer sticky border-t border-selected py-2',
        classAttr,
        className,
    )}
    data-action-bar
    data-mode={mode}
    {...rest}
>
    {@render children()}
</div>

<style>
    :global(.action-bar-footer) {
        bottom: calc(var(--list-action-bar-footer-offset, 0px) + env(safe-area-inset-bottom));
        z-index: var(--risu-z-sticky);
        background: var(--risu-surface-background, transparent);
    }
</style>
