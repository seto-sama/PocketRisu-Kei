<script lang="ts">
    import { PinIcon, PinOffIcon, TriangleAlertIcon } from '@lucide/svelte'
    import PresetHeader from './GUI/PresetHeader.svelte'
    import ShButton from './GUI/ShButton.svelte'

    interface Props {
        label: string
        activeName: string
        state: 'selected' | 'empty' | 'warning'
        compact?: boolean
        disabled?: boolean
        onOpen: () => void
    }

    let {
        label,
        activeName,
        state,
        compact = false,
        disabled = false,
        onOpen,
    }: Props = $props()

    const className = $derived(
        state === 'selected'
            ? 'border-selected text-textcolor'
            : state === 'empty'
                ? 'text-textcolor2 opacity-75 risu-interactive-reveal'
                : '',
    )
</script>

{#if compact}
    <PresetHeader
        compact
        {label}
        {activeName}
        onManage={onOpen}
        {disabled}
        variant={state === 'warning' ? 'warning' : 'secondary'}
        {className}
    />
{:else}
    <ShButton
        variant={state === 'warning' ? 'warning' : 'default'}
        size="default"
        className={`w-full min-w-0 justify-start${disabled ? ' opacity-50 pointer-events-none' : ''} ${className}`}
        onclick={() => { if (!disabled) onOpen() }}
    >
        {#if state === 'selected'}
            <PinIcon class="shrink-0" />
        {:else if state === 'warning'}
            <TriangleAlertIcon size={16} class="shrink-0" />
        {:else}
            <PinOffIcon class="shrink-0" />
        {/if}
        <span class="truncate text-sm grow text-left">{activeName}</span>
    </ShButton>
{/if}
