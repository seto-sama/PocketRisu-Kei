<script lang="ts" module>
    // Sh button — vega-derived spec, sizes shifted +1 step for mixed
    // desktop/mobile use (NodeOnly is also accessed via Tailscale on phones).
    // See .agent/guide/ui.md "Sh* sizing scale" for the rationale and the
    // coordination with ShInput / ShToggle / SelectInput.
    export type ShButtonVariant = 'default' | 'outline' | 'secondary' | 'ghost' | 'destructive' | 'attention' | 'warning' | 'success' | 'primary' | 'link';
    export type ShButtonSize = 'default' | 'xs' | 'sm' | 'lg' | 'icon' | 'icon-xs' | 'icon-sm' | 'icon-lg';
</script>

<script lang="ts">
    import type { Snippet } from 'svelte';
    import type { HTMLAnchorAttributes, HTMLButtonAttributes } from 'svelte/elements';
    import { cn } from 'src/lib/utils';

    type Props = (HTMLButtonAttributes & HTMLAnchorAttributes) & {
        variant?: ShButtonVariant;
        size?: ShButtonSize;
        href?: string;
        className?: string;
        children?: Snippet;
    };

    let {
        variant = 'default',
        size = 'default',
        href,
        className = '',
        disabled,
        type = 'button',
        children,
        ...rest
    }: Props = $props();

    // Layout + interaction base (identical for every variant/size).
    // text-base: 16px constant across all viewports — avoids the 768px jump
    // that the previous `text-base md:text-sm` rule introduced and keeps
    // type alignment with sidebar legacy buttons. xs/sm sizes override below
    // for dense areas. See .agent/guide/ui.md.
    const base =
        "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-base font-medium shrink-0 " +
        "transition-colors select-none " +
        "disabled:opacity-50 disabled:pointer-events-none " +
        "[&_svg]:shrink-0 [&_svg]:pointer-events-none";

    const variantClasses: Record<ShButtonVariant, string> = {
        default:     'bg-darkbutton text-textcolor border border-darkborderc risu-interactive-surface-solid',
        outline:     'bg-transparent text-textcolor border border-darkborderc risu-interactive-surface',
        secondary:   'bg-darkbg text-textcolor border border-darkborderc risu-interactive-surface-solid',
        ghost:       'bg-transparent text-textcolor border border-transparent risu-interactive-surface',
        destructive: 'bg-draculared/20 text-draculared border border-draculared/40 hover:bg-draculared/30',
        attention:   'bg-highlight/20 text-highlight border border-highlight/40 hover:bg-highlight/30',
        warning:     'bg-warning/20 text-warning border border-warning/40 hover:bg-warning/30',
        success:     'bg-success/20 text-success border border-success/40 hover:bg-success/30',
        // Primary: filled-solid (shadcn vega original pattern, NOT muted).
        // Pairs with ShSwitch checked-track which is also a full bg-primary fill,
        // so the visual weight matches when both appear in the same form. text
        // uses textcolor; primary hues per theme are picked dark enough that the
        // theme textcolor (mostly off-white) stays readable.
        primary:     'bg-primary text-textcolor border border-transparent risu-interactive-primary',
        link:        'bg-transparent text-textcolor2 border border-transparent underline-offset-4 hover:underline',
    };

    const sizeClasses: Record<ShButtonSize, string> = {
        default:   'h-10 px-2.5 [&_svg]:size-[18px]',
        xs:        'h-7 px-2 text-xs gap-1 [&_svg]:size-3',
        sm:        'h-8 px-2.5 text-sm gap-1 [&_svg]:size-4',
        lg:        'h-11 px-2.5 [&_svg]:size-5',
        icon:      'size-10 p-0 [&_svg]:size-[18px]',
        'icon-xs': 'size-7 p-0 [&_svg]:size-3',
        'icon-sm': 'size-8 p-0 [&_svg]:size-4',
        'icon-lg': 'size-11 p-0 [&_svg]:size-5',
    };

    const classes = $derived(cn(base, variantClasses[variant], sizeClasses[size], className));
</script>

{#if href}
    <a
        href={disabled ? undefined : href}
        aria-disabled={disabled}
        tabindex={disabled ? -1 : undefined}
        class={classes}
        data-slot="button"
        {...rest}
    >
        {@render children?.()}
    </a>
{:else}
    <button
        {type}
        {disabled}
        class={classes}
        data-slot="button"
        {...rest}
    >
        {@render children?.()}
    </button>
{/if}
