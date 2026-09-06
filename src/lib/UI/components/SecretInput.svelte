<script lang="ts">
    import { EyeIcon, EyeOffIcon } from "@lucide/svelte";
    import Input from "./Input.svelte";
    import type { ComponentProps } from "svelte";
    import type { InputCommitMode } from "src/ts/inputCommit";

    interface Props {
        value: string;
        placeholder?: string;
        fullwidth?: boolean;
        className?: string;
        size?: ComponentProps<typeof Input>['size'];
        disabled?: boolean;
        commitMode?: InputCommitMode;
        debounceMs?: number;
        oncommit?: (value: string) => void;
    }

    let {
        value = $bindable(),
        placeholder = '',
        fullwidth = false,
        className = '',
        size = 'md',
        disabled = false,
        commitMode = 'blur',
        debounceMs = undefined,
        oncommit = () => {},
    }: Props = $props();

    // Single-user app — masking is convenience, not security. Default hidden,
    // click the eye to reveal as plaintext.
    let revealed = $state(false);
</script>

<div class="relative" class:w-full={fullwidth}>
    <Input
        {size}
        className={`pr-10 w-full ${className}`}
        autocomplete="off"
        {placeholder}
        hideText={!revealed}
        bind:value
        {disabled}
        {commitMode}
        {debounceMs}
        {oncommit}
        fullwidth
    />
    <button
        type="button"
        class="absolute right-2 top-1/2 -translate-y-1/2 text-subtext risu-interactive-foreground transition-colors"
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
