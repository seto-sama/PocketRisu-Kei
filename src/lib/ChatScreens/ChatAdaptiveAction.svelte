<script lang="ts">
    import type { Snippet } from "svelte";
    import IconButton, { type IconButtonTone } from "../UI/components/IconButton.svelte";
    import { Item as DropdownMenuItem } from "../UI/components/dropdown-menu";

    interface Props {
        menu?: boolean;
        tone?: IconButtonTone;
        className?: string;
        disabled?: boolean;
        onclick?: () => void | Promise<void>;
        children: Snippet;
    }

    let {
        menu = false,
        tone = 'default',
        className = '',
        disabled = false,
        onclick,
        children,
    }: Props = $props();
</script>

{#if menu}
    <DropdownMenuItem
        variant={tone === 'destructive' ? 'destructive' : 'default'}
        class={className}
        {disabled}
        onSelect={() => onclick?.()}
    >
        {@render children()}
    </DropdownMenuItem>
{:else}
    <IconButton size="lg" {tone} {className} {disabled} {onclick}>
        {@render children()}
    </IconButton>
{/if}
