<script lang="ts">
    // shadcn-svelte DropdownMenu Content — RisuAI tokens. Portals to body
    // and receives its z-index from the shared overlay stack.
    import { DropdownMenu } from 'bits-ui';
    import { cn } from 'src/lib/utils';
    import OverlayLayerRoot from '../overlay/OverlayLayerRoot.svelte';

    let {
        ref = $bindable(null),
        sideOffset = 4,
        align = 'start',
        class: className,
        style: styleProp,
        ...restProps
    }: DropdownMenu.ContentProps = $props();

</script>

<DropdownMenu.Portal>
    <OverlayLayerRoot interactive>
    <DropdownMenu.Content
        bind:ref
        data-slot="dropdown-menu-content"
        {sideOffset}
        {align}
        style={styleProp}
        class={cn(
            'risu-layer-overlay min-w-32 rounded-md border border-darkborderc bg-darkbg text-maintext p-1 shadow-md outline-none ' +
            'max-h-[var(--bits-dropdown-menu-content-available-height)] overflow-y-auto ' +
            'data-[state=open]:animate-in data-[state=closed]:animate-out ' +
            'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 ' +
            'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 ' +
            'data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 ' +
            'data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2',
            className
        )}
        {...restProps}
    />
    </OverlayLayerRoot>
</DropdownMenu.Portal>
