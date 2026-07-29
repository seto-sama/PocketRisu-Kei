<script lang="ts">
    import { Tooltip } from 'bits-ui'
    import type { Snippet } from 'svelte'
    import { cn } from 'src/lib/utils'

    interface Props {
        trigger: Snippet<[Record<string, unknown>]>
        children?: Snippet
        className?: string
        delayDuration?: number
        sideOffset?: number
        collisionPadding?: number
        disabled?: boolean
    }

    let {
        trigger,
        children,
        className = '',
        delayDuration = 300,
        sideOffset = 4,
        collisionPadding = 8,
        disabled = false,
    }: Props = $props()

    const contentClass = $derived(cn(
        'max-w-96 max-h-80 overflow-y-auto break-keep bg-darkbg border border-darkborderc rounded-md px-3 py-2 text-xs text-textcolor shadow-lg z-50 leading-relaxed',
        className,
    ))
</script>

<Tooltip.Provider {delayDuration}>
    <Tooltip.Root {disabled}>
        <Tooltip.Trigger>
            {#snippet child({ props })}
                {@render trigger(props)}
            {/snippet}
        </Tooltip.Trigger>
        <Tooltip.Portal>
            <Tooltip.Content class={contentClass} {sideOffset} {collisionPadding}>
                {@render children?.()}
            </Tooltip.Content>
        </Tooltip.Portal>
    </Tooltip.Root>
</Tooltip.Provider>
