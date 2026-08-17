<script lang="ts">
    import { EyeIcon, EyeOffIcon } from "@lucide/svelte";

    interface Props {
        value: string;
        placeholder?: string;
        fullwidth?: boolean;
        className?: string;
        disabled?: boolean;
    }

    let {
        value = $bindable(),
        placeholder = '',
        fullwidth = false,
        className = '',
        disabled = false,
    }: Props = $props();

    // Single-user app — masking is convenience, not security. Default hidden,
    // click the eye to reveal as plaintext.
    let revealed = $state(false);
</script>

<div class="relative" class:w-full={fullwidth}>
    <input
        class={"risu-field-border peer rounded-md shadow-xs text-textcolor bg-transparent px-4 py-2 pr-10 w-full" + (className ? (' ' + className) : '')}
        class:text-textcolor2={disabled}
        autocomplete="new-password"
        {placeholder}
        type={revealed ? 'text' : 'password'}
        bind:value
        {disabled}
    />
    <button
        type="button"
        class="absolute right-2 top-1/2 -translate-y-1/2 text-textcolor2 risu-interactive-foreground transition-colors"
        title={revealed ? 'hide' : 'show'}
        onclick={() => { revealed = !revealed }}
        tabindex="-1"
    >
        {#if revealed}
            <EyeOffIcon size={16} />
        {:else}
            <EyeIcon size={16} />
        {/if}
    </button>
</div>
