<script lang="ts" module>
    export type ShSettingsSpacing = 'divided' | 'spaced' | 'none';
</script>

<script lang="ts">
    import type { Snippet } from 'svelte';
    import type { HTMLAttributes } from 'svelte/elements';
    import { cn } from 'src/lib/utils';

    type Props = HTMLAttributes<HTMLDivElement> & {
        variant?: 'list' | 'row';
        spacing?: ShSettingsSpacing;
        size?: 'default' | 'compact';
        align?: 'center' | 'start';
        layout?: 'flex' | 'grid';
        children?: Snippet;
        className?: string;
    };

    let {
        variant = 'list',
        spacing = 'divided',
        size = 'default',
        align = 'center',
        layout = 'flex',
        children,
        className = '',
        ...rest
    }: Props = $props();
</script>

{#if variant === 'row'}
    <div
        {...rest}
        data-settings-row
        class={cn(
            'w-full gap-2 px-1 transition-colors',
            layout === 'grid' ? 'grid' : 'flex justify-between',
            align === 'start' ? 'items-start' : 'items-center',
            size === 'compact' ? 'h-8 min-h-8' : 'min-h-10',
            className,
        )}
    >
        {@render children?.()}
    </div>
{:else}
    <!-- Non-row children intentionally break the automatic divider chain. -->
    <div
        {...rest}
        class={cn(
            'flex w-full flex-col',
            spacing === 'divided' && [
                '[&>[data-settings-row]+[data-settings-row]]:border-t',
                '[&>[data-settings-row]+[data-settings-row]]:border-darkborderc/20',
            ],
            spacing === 'spaced' && 'gap-2',
            className,
        )}
    >
        {@render children?.()}
    </div>
{/if}
