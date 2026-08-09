<script lang="ts" module>
    export type IconButtonSize = 'xs' | 'sm' | 'default' | 'lg' | 'xl';
    export type IconButtonTone = 'default' | 'destructive';
    export type IconButtonActiveColor = 'textcolor' | 'primary';
    export const iconButtonSizeValues: Record<IconButtonSize, {
        icon: number;
        cell: number;
        labelGap: number;
        labelPadding: number;
    }> = {
        xs: { icon: 12, cell: 16, labelGap: 3, labelPadding: 2 },
        sm: { icon: 16, cell: 64 / 3, labelGap: 4, labelPadding: 8 / 3 },
        default: { icon: 18, cell: 24, labelGap: 4.5, labelPadding: 3 },
        lg: { icon: 20, cell: 80 / 3, labelGap: 5, labelPadding: 10 / 3 },
        xl: { icon: 24, cell: 32, labelGap: 6, labelPadding: 4 },
    };
</script>

<script lang="ts">
    import type { Snippet } from 'svelte';
    import type { HTMLButtonAttributes } from 'svelte/elements';
    import { cn } from 'src/lib/utils';

    type Props = HTMLButtonAttributes & {
        size?: IconButtonSize;
        tone?: IconButtonTone;
        active?: boolean;
        activeColor?: IconButtonActiveColor;
        expanded?: boolean;
        className?: string;
        children: Snippet;
    };

    let {
        size,
        tone = 'default',
        active = false,
        activeColor = 'textcolor',
        expanded = false,
        class: classAttr = '',
        className = '',
        type = 'button',
        style,
        children,
        ...rest
    }: Props = $props();

    const classes = $derived(cn(
        'inline-flex shrink-0 items-center justify-center rounded-md border border-transparent text-textcolor2 transition-colors disabled:pointer-events-none disabled:opacity-30',
        tone === 'destructive' ? 'risu-interactive-danger' : 'risu-interactive-accent',
        active && (activeColor === 'primary' ? 'text-primary' : 'text-textcolor'),
        classAttr,
        className,
    ));
    const inlineStyle = $derived([
        size
            ? `--icon-size:${iconButtonSizeValues[size].icon}px;--icon-cell-size:${iconButtonSizeValues[size].cell}px;--icon-label-gap:${iconButtonSizeValues[size].labelGap}px;--icon-label-padding:${iconButtonSizeValues[size].labelPadding}px`
            : '',
        typeof style === 'string' ? style : '',
    ].filter(Boolean).join(';'));
</script>

<button
    {type}
    class={classes}
    style={inlineStyle || undefined}
    data-icon-button
    data-icon-size={size}
    data-expanded={expanded}
    {...rest}
>
    {@render children()}
</button>

<style>
    button {
        width: var(--icon-cell-size, 24px);
        height: var(--icon-cell-size, 24px);
    }

    button :global(svg) {
        width: var(--icon-size, 18px);
        height: var(--icon-size, 18px);
    }

    button[data-expanded="true"] {
        width: auto;
        gap: var(--icon-label-gap, 4.5px);
        padding-inline: var(--icon-label-padding, 3px);
    }
</style>
