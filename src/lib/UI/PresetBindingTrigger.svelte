<script lang="ts">
    import { PinIcon, PinOffIcon, TriangleAlertIcon } from '@lucide/svelte'
    import PresetHeader from './components/PresetHeader.svelte'
    import Button from './components/Button.svelte'

    interface Props {
        label: string
        activeName: string
        state: 'selected' | 'empty' | 'warning'
        compact?: boolean
        disabled?: boolean
        onOpen: () => void
        onEdit?: () => void
    }

    let {
        label,
        activeName,
        state,
        compact = false,
        disabled = false,
        onOpen,
        onEdit,
    }: Props = $props()

    function handleContextMenu(event: MouseEvent) {
        if (disabled || !onEdit) return
        event.preventDefault()
        event.stopPropagation()
        onEdit()
    }

    const className = $derived(
        state === 'selected'
            ? 'border-selected text-maintext'
            : state === 'empty'
                ? 'text-subtext opacity-75 risu-interactive-reveal'
                : '',
    )
</script>

{#if compact}
    <PresetHeader
        compact
        {label}
        {activeName}
        onManage={onOpen}
        onContextMenu={onEdit ? handleContextMenu : undefined}
        {disabled}
        variant={state === 'warning' ? 'warning' : 'secondary'}
        {className}
    />
{:else}
    <Button
        variant={state === 'warning' ? 'warning' : 'default'}
        size="default"
        className={`w-full min-w-0 justify-start${disabled ? ' opacity-50 pointer-events-none' : ''} ${className}`}
        onclick={() => { if (!disabled) onOpen() }}
        oncontextmenu={onEdit ? handleContextMenu : undefined}
    >
        {#if state === 'selected'}
            <PinIcon class="shrink-0" />
        {:else if state === 'warning'}
            <TriangleAlertIcon size={16} class="shrink-0" />
        {:else}
            <PinOffIcon class="shrink-0" />
        {/if}
        <span class="truncate text-sm grow text-left">{activeName}</span>
    </Button>
{/if}
