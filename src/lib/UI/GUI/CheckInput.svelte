<script lang="ts">

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
        children
    }: Props = $props();
</script>

<label 
    class={"flex items-center gap-2 cursor-pointer" + (className ? " " + className : "") + (grayText ? " text-textcolor2" : " text-textcolor")}
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
                ? `rounded border ${check ? 'border-borderc bg-borderc' : `border-darkborderc ${cardUncheckedFill ? 'bg-darkbg/50 mix-blend-multiply' : 'bg-transparent'}`}`
                : `rounded-md border-2 border-darkborderc ${check ? 'bg-darkborderc' : 'bg-darkbutton'}`)}
        aria-hidden="true"
        aria-describedby="{name} {check ? 'abled' : 'disabled'}"
        aria-labelledby="{name} {check ? 'abled' : 'disabled'}"
    >
        {#if check}
            {#if card}
                <svg class="w-3 h-3 text-white" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M2 6l3 3 5-5" />
                </svg>
            {:else}
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="white" class="w-3 h-3" aria-hidden="true">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/>
                </svg>
            {/if}
        {/if}
    </span>
    {#if !hiddenName && !reverse}
        <span>{name} {@render children?.()}</span>
    {/if}
</label>
