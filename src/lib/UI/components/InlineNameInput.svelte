<script lang="ts">
    import type { HTMLInputAttributes } from 'svelte/elements';
    import { cn } from 'src/lib/utils';

    interface Props extends Omit<HTMLInputAttributes, 'class' | 'value' | 'size'> {
        value?: string;
        size?: 'compact' | 'default';
        leadingInset?: 'none' | 'border' | 'row';
        className?: string;
    }

    let {
        value = $bindable(),
        size = 'compact',
        leadingInset = 'none',
        className = '',
        type = 'text',
        autocomplete = 'off',
        ...rest
    }: Props = $props();

    const classes = $derived(cn(
        'risu-field-border w-full min-w-0 bg-transparent px-0 py-1 text-maintext shadow-xs',
        size === 'compact'
            ? 'h-6 min-h-6 rounded-sm'
            : 'h-8 min-h-8 rounded-md',
        leadingInset === 'border' && 'inline-name-inset-border',
        leadingInset === 'row' && 'inline-name-inset-row',
        className,
    ));
</script>

<input {type} {autocomplete} bind:value class={classes} {...rest} />

<style>
    .inline-name-inset-border {
        width: calc(100% + 1px);
        margin-left: -1px;
    }

    .inline-name-inset-row {
        width: calc(100% + 0.5rem);
        margin-left: -0.5rem;
        padding-left: calc(0.5rem - 1px);
    }
</style>
