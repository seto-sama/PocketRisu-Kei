<script lang="ts">
    // shadcn-svelte DropdownMenu Separator — RisuAI tokens.
    // Negative -mx-1 makes the line span the full content width despite
    // the parent's p-1 padding.
    import { DropdownMenu } from 'bits-ui';
    import { cn } from 'src/lib/utils';

    let {
        ref = $bindable(null),
        class: className,
        ...restProps
    }: DropdownMenu.SeparatorProps = $props();
</script>

<DropdownMenu.Separator
    bind:ref
    data-slot="dropdown-menu-separator"
    class={cn('-mx-1 my-1 h-px bg-darkborderc', className)}
    {...restProps}
/>
