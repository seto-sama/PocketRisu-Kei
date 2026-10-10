<script lang="ts">
    import type { Snippet } from 'svelte'
    import * as ContextMenu from './context-menu'
    import { getVisualViewportBounds } from 'src/ts/gui/visualViewport'

    let { trigger, children, onOpen }: {
        trigger: Snippet
        children: Snippet
        onOpen?: () => void
    } = $props()

    let side = $state<'top' | 'bottom'>('bottom')
    let align = $state<'start' | 'end'>('start')

    function chooseDirection(event: MouseEvent) {
        const viewport = getVisualViewportBounds()
        side = event.clientY < viewport.top + viewport.height / 2 ? 'bottom' : 'top'
        align = event.clientX < viewport.left + viewport.width / 2 ? 'start' : 'end'
    }
</script>

<ContextMenu.Root onOpenChange={open => { if (open) onOpen?.() }}>
    <ContextMenu.Trigger class="inline-flex shrink-0" oncontextmenu={chooseDirection} onpointerdown={chooseDirection}>
        {@render trigger()}
    </ContextMenu.Trigger>
    <ContextMenu.Content {side} {align} collisionPadding={8} sticky="always" class="w-96 max-w-[calc(100vw-2rem)] p-3 [&_[data-setting-id]]:border-0 [&_[data-setting-id]]:py-0">
        {@render children()}
    </ContextMenu.Content>
</ContextMenu.Root>
