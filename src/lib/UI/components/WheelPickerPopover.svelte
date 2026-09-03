<script lang="ts">
    import OverlayPortal from './overlay/OverlayPortal.svelte'

    type OptionValue = string | number

    interface Props {
        trigger?: HTMLElement
        interactionRoot?: HTMLElement
        options: Array<{ value: OptionValue; label: string }>
        selectedValue: OptionValue
        visibleItems?: number
        itemHeight?: number
        inlinePadding?: number
        ref?: HTMLDivElement
        onSelect: (value: OptionValue) => void
        onClose: () => void
    }

    let {
        trigger,
        interactionRoot,
        options,
        selectedValue,
        visibleItems = 5,
        itemHeight = 28,
        inlinePadding = 0,
        ref = $bindable(),
        onSelect,
        onClose,
    }: Props = $props()

    let popupStyle = $state('')
    let positionFrame: number | null = null
    let alignmentFrame: number | null = null
    const edgeSpace = $derived((visibleItems - 1) * itemHeight / 2)

    function positionPopup() {
        if (!trigger || !ref) return
        const rect = trigger.getBoundingClientRect()
        const width = rect.width + inlinePadding * 2
        const height = visibleItems * itemHeight + 2
        popupStyle = `top:${rect.top + rect.height / 2 - height / 2}px;left:${rect.left + rect.width / 2 - width / 2}px;width:${width}px;height:${height}px;--wheel-picker-row-height:${itemHeight}px;`
    }

    function schedulePosition() {
        if (positionFrame !== null) return
        positionFrame = requestAnimationFrame(() => {
            positionFrame = null
            positionPopup()
        })
    }

    function handleOutside(event: PointerEvent) {
        const target = event.target as Node
        if (!(interactionRoot ?? trigger)?.contains(target) && !ref?.contains(target)) onClose()
    }

    $effect(() => {
        if (!trigger || !ref) return
        positionPopup()
        const index = options.findIndex(option => option.value === selectedValue)
        if (index >= 0) alignmentFrame = requestAnimationFrame(() => {
            alignmentFrame = null
            if (ref) ref.scrollTop = index * itemHeight
        })
        document.addEventListener('pointerdown', handleOutside, true)
        window.addEventListener('resize', schedulePosition)
        window.addEventListener('scroll', schedulePosition, true)
        window.visualViewport?.addEventListener('resize', schedulePosition)
        window.visualViewport?.addEventListener('scroll', schedulePosition)
        return () => {
            document.removeEventListener('pointerdown', handleOutside, true)
            window.removeEventListener('resize', schedulePosition)
            window.removeEventListener('scroll', schedulePosition, true)
            window.visualViewport?.removeEventListener('resize', schedulePosition)
            window.visualViewport?.removeEventListener('scroll', schedulePosition)
            if (positionFrame !== null) cancelAnimationFrame(positionFrame)
            if (alignmentFrame !== null) cancelAnimationFrame(alignmentFrame)
            positionFrame = null
            alignmentFrame = null
        }
    })
</script>

<OverlayPortal onEscape={onClose}>
    <div
        bind:this={ref}
        role="listbox"
        data-risu-dialog-interactive
        class="risu-layer-overlay wheel-picker fixed overflow-y-auto rounded-md border border-darkborderc bg-darkbg text-sm tabular-nums shadow-md"
        style={popupStyle}
    >
        <span class="wheel-edge" style:height={`${edgeSpace}px`} aria-hidden="true"></span>
        {#each options as option}
            {@const selected = option.value === selectedValue}
            <button
                type="button"
                role="option"
                aria-selected={selected}
                data-selected={selected}
                class="risu-selectable-row wheel-picker-option flex w-full cursor-pointer select-none items-center justify-center rounded-sm text-sm text-maintext"
                onclick={() => onSelect(option.value)}
            >
                {option.label}
            </button>
        {/each}
        <span class="wheel-edge" style:height={`${edgeSpace}px`} aria-hidden="true"></span>
    </div>
</OverlayPortal>

<style>
    .wheel-picker {
        scroll-snap-type: y mandatory;
        scrollbar-width: none;
        overscroll-behavior: contain;
    }

    .wheel-picker::-webkit-scrollbar {
        display: none;
    }

    .wheel-edge {
        display: block;
        pointer-events: none;
    }

    .wheel-picker .wheel-picker-option {
        scroll-snap-align: center;
    }

    .wheel-picker-option {
        height: var(--wheel-picker-row-height, 1.75rem);
    }

    .wheel-picker-option:focus-visible {
        outline: none;
    }

    .wheel-picker-option::before {
        inset-inline: 0.125rem;
    }
</style>
