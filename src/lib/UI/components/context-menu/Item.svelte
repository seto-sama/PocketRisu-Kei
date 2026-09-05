<script lang="ts">
    import { ContextMenu } from 'bits-ui';
    import { cn } from 'src/lib/utils';

    interface Props extends ContextMenu.ItemProps {
        variant?: 'default' | 'destructive';
    }

    let {
        ref = $bindable(null),
        class: className,
        variant = 'default',
        ...restProps
    }: Props = $props();
</script>

<ContextMenu.Item
    bind:ref
    data-slot="context-menu-item"
    data-variant={variant}
    class={cn(
        'relative flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors ' +
        'data-highlighted:bg-selected data-highlighted:text-maintext ' +
        'data-disabled:pointer-events-none data-disabled:opacity-50 ' +
        'data-[variant=destructive]:text-danger ' +
        'data-[variant=destructive]:data-highlighted:bg-danger/15 ' +
        'data-[variant=destructive]:data-highlighted:text-danger',
        className,
    )}
    {...restProps}
/>

