<script lang="ts">
    import { ContextMenu } from 'bits-ui';
    import { cn } from 'src/lib/utils';
    import OverlayLayerRoot from '../overlay/OverlayLayerRoot.svelte';

    let {
        ref = $bindable(null),
        sideOffset = 4,
        class: className,
        style: styleProp,
        ...restProps
    }: ContextMenu.ContentProps = $props();
</script>

<ContextMenu.Portal>
    <OverlayLayerRoot interactive>
        <ContextMenu.Content
            bind:ref
            data-slot="context-menu-content"
            {sideOffset}
            style={styleProp}
            class={cn(
                'risu-layer-overlay min-w-32 rounded-md border border-darkborderc bg-darkbg p-1 text-maintext shadow-md outline-none ' +
                'max-h-[var(--bits-context-menu-content-available-height)] overflow-y-auto ' +
                'data-[state=open]:animate-in data-[state=closed]:animate-out ' +
                'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 ' +
                'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
                className,
            )}
            {...restProps}
        />
    </OverlayLayerRoot>
</ContextMenu.Portal>

