<script lang="ts">
    import { CheckIcon } from '@lucide/svelte';

    interface Props {
        check?: boolean;
        onChange?: (check:boolean) => any,
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
        check = $bindable(),
        onChange = (check:boolean) => {},
        margin = true,
        name = '',
        hiddenName = false,
        reverse = false,
        className = "",
        grayText = false,
        card = false,
        cardUncheckedFill = true,
        checkedColor = 'default',
        disabled = false,
        children
    }: Props = $props();
</script>

<label 
    class={"flex items-center gap-2 " + (disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer") + (className ? " " + className : "") + (grayText ? " text-textcolor2" : " text-textcolor")}
    class:mr-2={margin}
    aria-describedby="{name} {check ? 'abled' : 'disabled'}"
    aria-labelledby="{name} {check ? 'abled' : 'disabled'}"
>
    {#if reverse}
        <span>{name} {@render children?.()}</span>
    {/if}
    <input 
        class="hidden" 
        type="checkbox" 
        alt={name}
        {disabled}
        bind:checked={check}
        onchange={() => {
            onChange(check)
        }}
        aria-describedby="{name} {check ? 'abled' : 'disabled'}"
        aria-labelledby="{name} {check ? 'abled' : 'disabled'}"
    />
    <span 
        class={"w-5 h-5 min-w-5 min-h-5 flex justify-center items-center transition-colors duration-200 "
            + (card
                ? `rounded border ${check ? (checkedColor === 'primary' ? 'border-primary bg-primary' : 'border-borderc bg-borderc') : `border-darkborderc ${cardUncheckedFill ? 'bg-darkbg/50 mix-blend-multiply' : 'bg-transparent'}`}`
                : `rounded-md border ${check ? 'border-primary bg-primary' : 'border-darkborderc bg-transparent'}`)}
        aria-hidden="true"
        aria-describedby="{name} {check ? 'abled' : 'disabled'}"
        aria-labelledby="{name} {check ? 'abled' : 'disabled'}"
    >
        {#if check}
            <CheckIcon class="w-3 h-3 text-white" strokeWidth={5} aria-hidden="true" />
        {/if}
    </span>
    {#if !hiddenName && !reverse}
        <span>{name} {@render children?.()}</span>
    {/if}
</label>
