<script lang="ts">
    // shadcn-svelte DropdownMenu Item — RisuAI tokens.
    // bits-ui auto-closes the menu on click, no manual close needed.
    //
    // variant="destructive" tints text + hover for delete/dangerous actions.
    // text-sm because dropdown items follow dense menu convention, not the
    // 16px form-control rule (see .agent/guide/ui.md).
    import { DropdownMenu } from 'bits-ui';
    import { cn } from 'src/lib/utils';

    interface Props extends DropdownMenu.ItemProps {
        variant?: 'default' | 'destructive';
    }

    let {
        ref = $bindable(null),
        class: className,
        variant = 'default',
        ...restProps
    }: Props = $props();
</script>

<DropdownMenu.Item
    bind:ref
    data-slot="dropdown-menu-item"
    data-variant={variant}
    class={cn(
        'relative flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm select-none transition-colors ' +
        'data-highlighted:bg-selected data-highlighted:text-textcolor ' +
        'data-disabled:pointer-events-none data-disabled:opacity-50 ' +
        'data-[variant=destructive]:text-draculared ' +
        'data-[variant=destructive]:data-highlighted:bg-draculared/15 ' +
        'data-[variant=destructive]:data-highlighted:text-draculared ' +
        '[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*=size-])]:size-4',
        className
    )}
    {...restProps}
/>
