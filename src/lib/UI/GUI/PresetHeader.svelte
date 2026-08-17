<script lang="ts">
    import { ChevronRightIcon } from "@lucide/svelte";
    import ShButton from "./ShButton.svelte";
    import type { ShButtonVariant } from "./ShButton.svelte";

    interface Props {
        label: string;
        activeName: string;
        onManage: () => void;
        compact?: boolean;
        disabled?: boolean;
        variant?: ShButtonVariant;
        className?: string;
    }

    let {
        label,
        activeName,
        onManage,
        compact = false,
        disabled = false,
        variant = 'secondary',
        className = '',
    }: Props = $props();

    function handleKeydown(e: KeyboardEvent) {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onManage();
        }
    }
</script>

{#if compact}
    <ShButton
        {variant}
        size="sm"
        className={`h-8 w-48 min-w-0 justify-start ${className}`}
        aria-label={`${label}: ${activeName}`}
        {disabled}
        onclick={onManage}
    >
        <span class="truncate text-sm grow text-left">{activeName}</span>
        <ChevronRightIcon class="shrink-0 text-textcolor2" />
    </ShButton>
{:else}
    <div
        role="button"
        tabindex="0"
        aria-label={`${label}: ${activeName}`}
        onclick={onManage}
        onkeydown={handleKeydown}
        class="w-full flex items-center gap-3 bg-darkbg border border-darkborderc rounded-md px-3 py-2.5 mb-4 cursor-pointer risu-interactive-surface transition-colors"
    >
        <div class="flex flex-col min-w-0 grow">
            <span class="text-xs text-textcolor2">{label}</span>
            <span class="text-sm text-textcolor truncate">{activeName}</span>
        </div>
        <ChevronRightIcon size={18} class="shrink-0 text-textcolor2" />
    </div>
{/if}
