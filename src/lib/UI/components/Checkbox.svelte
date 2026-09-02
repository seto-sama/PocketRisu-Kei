<script lang="ts">
    import { Checkbox } from 'bits-ui';
    import { CheckIcon } from '@lucide/svelte';
    import { cn } from 'src/lib/utils';

    interface Props {
        check?: boolean;
        onChange?: (checked: boolean) => void;
        margin?: boolean;
        name?: string;
        hiddenName?: boolean;
        reverse?: boolean;
        className?: string;
        grayText?: boolean;
        card?: boolean;
        cardUncheckedFill?: boolean;
        checkedColor?: 'default' | 'primary';
        disabled?: boolean;
        children?: import('svelte').Snippet;
    }

    let {
        check = $bindable(false),
        onChange,
        margin = true,
        name = '',
        hiddenName = false,
        reverse = false,
        className = '',
        grayText = false,
        card = false,
        cardUncheckedFill = true,
        checkedColor = 'default',
        disabled = false,
        children,
    }: Props = $props();

    const controlClass = $derived(cn(
        'box-border flex size-5 min-h-5 min-w-5 shrink-0 items-center justify-center border transition-colors duration-150',
        card ? 'rounded' : 'rounded-md',
        check
            ? checkedColor === 'primary' || !card
                ? 'border-primary bg-primary'
                : 'border-lightborderc bg-lightborderc'
            : cn('border-darkborderc', card && cardUncheckedFill ? 'bg-darkbg/50 mix-blend-multiply' : 'bg-transparent'),
    ));
</script>

<Checkbox.Root
    bind:checked={check}
    {disabled}
    aria-label={name || undefined}
    onCheckedChange={onChange}
    class={cn(
        'border-0 bg-transparent p-0 leading-none items-center gap-2 text-left select-none',
        hiddenName ? 'flex size-5 min-h-5 min-w-5 shrink-0' : 'inline-flex',
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
        grayText ? 'text-subtext' : 'text-maintext',
        margin && 'mr-2',
        className,
    )}
>
    {#if reverse && !hiddenName}
        <span>{name} {@render children?.()}</span>
    {/if}
    <span class={controlClass} aria-hidden="true">
        <CheckIcon class={cn('size-3 shrink-0 text-themewhite', !check && 'invisible')} strokeWidth={5} />
    </span>
    {#if !reverse && !hiddenName}
        <span>{name} {@render children?.()}</span>
    {/if}
</Checkbox.Root>
