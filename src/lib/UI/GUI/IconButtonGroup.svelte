<script lang="ts">
    import type { Snippet } from 'svelte';
    import type { HTMLAttributes } from 'svelte/elements';
    import { iconButtonSizeValues, type IconButtonSize } from './IconButton.svelte';
    import { cn } from 'src/lib/utils';

    type Props = HTMLAttributes<HTMLDivElement> & {
        size?: IconButtonSize;
        direction?: 'horizontal' | 'vertical';
        className?: string;
        children: Snippet;
    };

    let {
        size = 'default',
        direction = 'horizontal',
        class: classAttr = '',
        className = '',
        style,
        children,
        ...rest
    }: Props = $props();

    const inlineStyle = $derived([
        `--icon-size:${iconButtonSizeValues[size].icon}px;--icon-cell-size:${iconButtonSizeValues[size].cell}px;--icon-label-gap:${iconButtonSizeValues[size].labelGap}px;--icon-label-padding:${iconButtonSizeValues[size].labelPadding}px`,
        typeof style === 'string' ? style : '',
    ].filter(Boolean).join(';'));
</script>

<div
    class={cn('flex items-center', direction === 'vertical' && 'flex-col', classAttr, className)}
    style={inlineStyle}
    data-icon-button-group
    data-icon-size={size}
    {...rest}
>
    {@render children()}
</div>

<style>
    div :global(svg) {
        width: var(--icon-size, 18px);
        height: var(--icon-size, 18px);
    }
</style>
