<script lang="ts">
    import type { HTMLInputAttributes } from 'svelte/elements';
    import { cn } from 'src/lib/utils';

    interface Props extends Omit<HTMLInputAttributes, 'class' | 'value' | 'size'> {
        value?: string;
        size?: 'compact' | 'default';
        className?: string;
    }

    let {
        value = $bindable(),
        size = 'compact',
        className = '',
        type = 'text',
        autocomplete = 'off',
        ...rest
    }: Props = $props();

    const classes = $derived(cn(
        'risu-field-border w-full min-w-0 bg-transparent py-1 text-textcolor shadow-xs',
        size === 'compact'
            ? 'h-6 min-h-6 rounded-sm px-2'
            : 'h-8 min-h-8 rounded-md px-2.5',
        className,
    ));
</script>

<input {type} {autocomplete} bind:value class={classes} {...rest} />
