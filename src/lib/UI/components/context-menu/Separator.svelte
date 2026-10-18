<script lang="ts">
    import { ContextMenu } from 'bits-ui'
    import { cn } from 'src/lib/utils'

    let { ref = $bindable(null), class: className, ...restProps }: ContextMenu.SeparatorProps = $props()
</script>

<ContextMenu.Separator
    bind:ref
    data-slot="context-menu-separator"
    class={cn('-mx-1 my-1 h-px bg-darkborderc', className)}
    {...restProps}
/>
