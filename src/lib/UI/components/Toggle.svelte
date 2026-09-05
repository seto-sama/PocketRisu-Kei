<script lang="ts" module>
    // Toggle — vega-derived spec, sizes match Button (+1 step from
    // upstream vega for mobile/touch).
    export type ToggleVariant = 'default' | 'outline';
    export type ToggleSize = 'default' | 'sm' | 'lg' | 'xs';
</script>

<script lang="ts">
    import type { Snippet } from 'svelte';
    import { Toggle } from 'bits-ui';
    import { cn } from 'src/lib/utils';

    interface Props {
        pressed?: boolean;
        onPressedChange?: (pressed: boolean) => void;
        variant?: ToggleVariant;
        size?: ToggleSize;
        disabled?: boolean;
        className?: string;
        children?: Snippet;
    }

    let {
        pressed = $bindable(false),
        onPressedChange,
        variant = 'outline',
        size = 'default',
        disabled = false,
        className = '',
        children,
    }: Props = $props();

    // text-base: 16px constant, mirroring Button. xs/sm sizes override below.
    const base =
        'inline-flex items-center justify-center gap-1.5 rounded-md text-base font-medium shrink-0 ' +
        'whitespace-nowrap border border-transparent transition-colors cursor-pointer select-none ' +
        'disabled:opacity-50 disabled:pointer-events-none ' +
        '[&_svg]:pointer-events-none [&_svg]:shrink-0';

    const variantClasses: Record<ToggleVariant, string> = {
        default:
            'bg-darkbg text-subtext risu-interactive-surface risu-interactive-foreground ' +
            'data-[state=on]:bg-selected data-[state=on]:text-maintext',
        outline:
            'border border-darkborderc bg-transparent text-subtext ' +
            'risu-interactive-surface risu-interactive-foreground ' +
            'data-[state=on]:bg-selected data-[state=on]:text-maintext data-[state=on]:border-lightborderc',
    };

    const sizeClasses: Record<ToggleSize, string> = {
        default: 'h-10 min-w-10 px-2.5',
        sm: 'h-8 min-w-8 px-2.5 text-sm',
        xs: 'h-7 min-w-7 px-2 text-xs [&_svg]:size-3',
        lg: 'h-11 min-w-11 px-2.5',
    };

    const classes = $derived(cn(base, variantClasses[variant], sizeClasses[size], className));
</script>

<Toggle.Root bind:pressed {onPressedChange} {disabled} class={classes}>
    {@render children?.()}
</Toggle.Root>
