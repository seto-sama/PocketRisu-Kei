<script lang="ts">
    import { Tooltip } from 'bits-ui'
    import type { Snippet } from 'svelte'
    import { cn } from 'src/lib/utils'
    import { provideOverlayLayer } from 'src/ts/gui/overlayLayer.svelte'
    import OverlayLayerRoot from './overlay/OverlayLayerRoot.svelte'

    interface Props {
        trigger: Snippet<[Record<string, unknown>]>
        children?: Snippet
        className?: string
        delayDuration?: number
        sideOffset?: number
        collisionPadding?: number
        side?: 'top' | 'right' | 'bottom' | 'left'
        disabled?: boolean
        variant?: 'solid' | 'glass'
    }

    let {
        trigger,
        children,
        className = '',
        delayDuration = 300,
        sideOffset = 4,
        collisionPadding = 8,
        side,
        disabled = false,
        variant = 'solid',
    }: Props = $props()

    let open = $state(false)

    provideOverlayLayer(() => open)

    const hasArrow = $derived(side !== undefined)

    const contentClass = $derived(
        cn(
            'tooltip-bubble risu-layer-overlay',
            hasArrow && 'tooltip-arrow',
            variant === 'solid' && 'tooltip-solid',
            variant === 'glass' && 'tooltip-glass',
        ),
    )

    const panelClass = $derived(
        cn(
            'max-w-96 max-h-80 overflow-y-auto break-keep px-3 py-2 text-xs text-maintext leading-relaxed',
            className,
        ),
    )
</script>

<Tooltip.Provider {delayDuration}>
    <Tooltip.Root bind:open {disabled}>
        <Tooltip.Trigger>
            {#snippet child({ props })}
                {@render trigger(props)}
            {/snippet}
        </Tooltip.Trigger>

        <Tooltip.Portal>
            <OverlayLayerRoot>
                <Tooltip.Content
                    class={contentClass}
                    {sideOffset}
                    {collisionPadding}
                    {side}
                >
                    <div class={panelClass}>
                        {@render children?.()}
                    </div>
                </Tooltip.Content>
            </OverlayLayerRoot>
        </Tooltip.Portal>
    </Tooltip.Root>
</Tooltip.Provider>

<style>
    :global(.tooltip-bubble) {
        --tooltip-arrow-depth: 7px;
        --tooltip-arrow-half-width: 6px;

        overflow: visible;
        border-radius: 0.375rem;
    }

    :global(.tooltip-bubble.tooltip-solid) {
        background: var(--risu-theme-darkbg);
        border: 1px solid var(--risu-theme-darkborderc);
        box-shadow:
            0 10px 15px -3px rgb(0 0 0 / 0.1),
            0 4px 6px -4px rgb(0 0 0 / 0.1);
    }

    :global(.tooltip-bubble.tooltip-glass) {
        background: color-mix(
            in srgb,
            var(--risu-theme-darkbg) 75%,
            transparent
        );
        -webkit-backdrop-filter: blur(4px);
        backdrop-filter: blur(4px);
    }

    :global(.tooltip-bubble.tooltip-arrow[data-side='right']) {
        padding-left: var(--tooltip-arrow-depth);
        clip-path: polygon(
            var(--tooltip-arrow-depth) 0,
            100% 0,
            100% 100%,
            var(--tooltip-arrow-depth) 100%,
            var(--tooltip-arrow-depth) calc(50% + var(--tooltip-arrow-half-width)),
            0 50%,
            var(--tooltip-arrow-depth) calc(50% - var(--tooltip-arrow-half-width))
        );
    }

    :global(.tooltip-bubble.tooltip-arrow[data-side='left']) {
        padding-right: var(--tooltip-arrow-depth);
        clip-path: polygon(
            0 0,
            calc(100% - var(--tooltip-arrow-depth)) 0,
            calc(100% - var(--tooltip-arrow-depth)) calc(50% - var(--tooltip-arrow-half-width)),
            100% 50%,
            calc(100% - var(--tooltip-arrow-depth)) calc(50% + var(--tooltip-arrow-half-width)),
            calc(100% - var(--tooltip-arrow-depth)) 100%,
            0 100%
        );
    }

    :global(.tooltip-bubble.tooltip-arrow[data-side='bottom']) {
        padding-top: var(--tooltip-arrow-depth);
        clip-path: polygon(
            0 var(--tooltip-arrow-depth),
            calc(50% - var(--tooltip-arrow-half-width)) var(--tooltip-arrow-depth),
            50% 0,
            calc(50% + var(--tooltip-arrow-half-width)) var(--tooltip-arrow-depth),
            100% var(--tooltip-arrow-depth),
            100% 100%,
            0 100%
        );
    }

    :global(.tooltip-bubble.tooltip-arrow[data-side='top']) {
        padding-bottom: var(--tooltip-arrow-depth);
        clip-path: polygon(
            0 0,
            100% 0,
            100% calc(100% - var(--tooltip-arrow-depth)),
            calc(50% + var(--tooltip-arrow-half-width)) calc(100% - var(--tooltip-arrow-depth)),
            50% 100%,
            calc(50% - var(--tooltip-arrow-half-width)) calc(100% - var(--tooltip-arrow-depth)),
            0 calc(100% - var(--tooltip-arrow-depth))
        );
    }
</style>