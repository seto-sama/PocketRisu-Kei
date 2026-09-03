<script lang="ts">
    import { getCurrentLocale } from 'src/lang'
    import WheelPickerPopover from './WheelPickerPopover.svelte'

    type DatePart = 'year' | 'month' | 'day' | 'period' | 'hour' | 'minute'
    type DateParts = {
        year: number
        month: number
        day: number
        hour: number
        minute: number
    }

    interface Props {
        value?: string
        className?: string
        onchange?: () => void
    }

    let { value = $bindable(''), className = '', onchange }: Props = $props()

    const ITEM_HEIGHT = 28
    const WHEEL_INLINE_PADDING = 4
    const MAX_VISIBLE_ITEMS = 5
    const MIN_VISIBLE_ITEMS = 3
    const YEAR_RANGE = 100
    const YEAR_CONTEXT = 20
    const pad = (number: number) => String(number).padStart(2, '0')

    function parseValue(input: string): DateParts {
        const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(input)
        if (match) {
            return {
                year: Number(match[1]),
                month: Number(match[2]),
                day: Number(match[3]),
                hour: Number(match[4]),
                minute: Number(match[5]),
            }
        }
        const now = new Date()
        return {
            year: now.getFullYear(),
            month: now.getMonth() + 1,
            day: now.getDate(),
            hour: now.getHours(),
            minute: now.getMinutes(),
        }
    }

    function serialize(parts: DateParts): string {
        return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`
    }

    function daysInMonth(year: number, month: number): number {
        return new Date(year, month, 0).getDate()
    }

    const locale = getCurrentLocale()
    const periodLabels = [9, 21].map(hour => {
        const date = new Date(2020, 0, 1, hour)
        return new Intl.DateTimeFormat(locale, { hour: 'numeric', hour12: true })
            .formatToParts(date)
            .find(part => part.type === 'dayPeriod')?.value ?? (hour < 12 ? 'AM' : 'PM')
    })

    let parts = $state(parseValue(value))
    let openPart = $state<DatePart | null>(null)
    let trigger = $state<HTMLDivElement>()
    let segmentTrigger = $state<HTMLButtonElement>()

    const hour12 = $derived(parts.hour % 12 || 12)
    const selectedPeriod = $derived(parts.hour >= 12 ? 1 : 0)

    function valuesFor(part: DatePart): number[] {
        if (part === 'year') {
            const current = new Date().getFullYear()
            const start = Math.min(current - YEAR_RANGE, parts.year - YEAR_CONTEXT)
            const end = Math.max(current + YEAR_RANGE, parts.year + YEAR_CONTEXT)
            return Array.from({ length: end - start + 1 }, (_, index) => start + index)
        }
        if (part === 'month') return Array.from({ length: 12 }, (_, index) => index + 1)
        if (part === 'day') return Array.from({ length: daysInMonth(parts.year, parts.month) }, (_, index) => index + 1)
        if (part === 'period') return [0, 1]
        if (part === 'hour') return Array.from({ length: 12 }, (_, index) => index + 1)
        return Array.from({ length: 60 }, (_, index) => index)
    }

    function selectedFor(part: DatePart): number {
        if (part === 'period') return selectedPeriod
        if (part === 'hour') return hour12
        return parts[part]
    }

    function labelFor(part: DatePart, number: number): string {
        if (part === 'period') return periodLabels[number]
        if (part === 'year') return String(number)
        return pad(number)
    }

    const openOptions = $derived(openPart
        ? valuesFor(openPart).map(number => ({ value: number, label: labelFor(openPart, number) }))
        : [])
    // Two-value wheels still need one full row above/below the selected value;
    // using only two rows clips AM/PM at the viewport edges.
    const visibleItemCount = $derived(Math.min(MAX_VISIBLE_ITEMS, Math.max(MIN_VISIBLE_ITEMS, openOptions.length)))

    function commit(part: DatePart, number: number) {
        const next = { ...parts }
        if (part === 'period') {
            next.hour = (next.hour % 12) + number * 12
        } else if (part === 'hour') {
            next.hour = (next.hour >= 12 ? 12 : 0) + (number % 12)
        } else {
            next[part] = number
        }
        next.day = Math.min(next.day, daysInMonth(next.year, next.month))
        parts = next
    }

    function flush() {
        const nextValue = serialize(parts)
        if (nextValue !== value) {
            value = nextValue
            onchange?.()
        }
    }

    function open(part: DatePart, anchor: HTMLButtonElement) {
        if (openPart === part) {
            close()
            return
        }
        segmentTrigger = anchor
        openPart = part
    }

    function close() {
        openPart = null
        segmentTrigger = undefined
    }

    function selectAndClose(part: DatePart, number: number) {
        commit(part, number)
        flush()
        openPart = null
        segmentTrigger = undefined
    }

    function handleSegmentKeydown(event: KeyboardEvent, part: DatePart) {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            open(part, event.currentTarget as HTMLButtonElement)
        } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            event.preventDefault()
            const values = valuesFor(part)
            const index = values.indexOf(selectedFor(part))
            const offset = event.key === 'ArrowUp' ? -1 : 1
            commit(part, values[Math.max(0, Math.min(values.length - 1, index + offset))])
            flush()
        }
    }

    $effect(() => {
        const external = value
        if (!openPart && serialize(parts) !== external) parts = parseValue(external)
    })

</script>

<div
    bind:this={trigger}
    class="risu-field-border datetime-field flex h-8 min-h-8 w-full min-w-0 items-center rounded-md px-[3px]
           text-sm text-maintext tabular-nums select-none {className}"
>
    <span class="datetime-part-group">
        <button type="button" class="segment segment-year" class:active={openPart === 'year'} onclick={(event) => open('year', event.currentTarget)} onkeydown={(event) => handleSegmentKeydown(event, 'year')} aria-label="year">{parts.year}</button>
        <span>.</span>
        <button type="button" class="segment" class:active={openPart === 'month'} onclick={(event) => open('month', event.currentTarget)} onkeydown={(event) => handleSegmentKeydown(event, 'month')} aria-label="month">{pad(parts.month)}</button>
        <span>.</span>
        <button type="button" class="segment" class:active={openPart === 'day'} onclick={(event) => open('day', event.currentTarget)} onkeydown={(event) => handleSegmentKeydown(event, 'day')} aria-label="day">{pad(parts.day)}</button>
    </span>
    <span class="datetime-group-gap" aria-hidden="true"></span>
    <span class="datetime-part-group">
        <button type="button" class="segment segment-period" class:active={openPart === 'period'} onclick={(event) => open('period', event.currentTarget)} onkeydown={(event) => handleSegmentKeydown(event, 'period')} aria-label="AM or PM">{periodLabels[selectedPeriod]}</button>
        <button type="button" class="segment" class:active={openPart === 'hour'} onclick={(event) => open('hour', event.currentTarget)} onkeydown={(event) => handleSegmentKeydown(event, 'hour')} aria-label="hour">{pad(hour12)}</button>
        <span>:</span>
        <button type="button" class="segment" class:active={openPart === 'minute'} onclick={(event) => open('minute', event.currentTarget)} onkeydown={(event) => handleSegmentKeydown(event, 'minute')} aria-label="minute">{pad(parts.minute)}</button>
    </span>
</div>

{#if openPart}
    <WheelPickerPopover
        trigger={segmentTrigger}
        interactionRoot={trigger}
        options={openOptions}
        selectedValue={selectedFor(openPart)}
        visibleItems={visibleItemCount}
        itemHeight={ITEM_HEIGHT}
        inlinePadding={WHEEL_INLINE_PADDING}
        onSelect={(optionValue) => selectAndClose(openPart!, Number(optionValue))}
        onClose={close}
    />
{/if}

<style>
    .datetime-part-group {
        display: contents;
    }

    .datetime-field:focus-within {
        border-color: var(--risu-theme-darkborderc);
    }

    .segment {
        flex: 1 1 0;
        min-width: 0;
        border-radius: 0.25rem;
        padding: 0.125rem 0.1rem;
        cursor: pointer;
        line-height: 1.25rem;
    }

    .segment-year {
        flex-grow: 1.6;
    }

    .segment-period {
        flex-grow: 1.25;
    }

    .datetime-group-gap {
        flex: 0 0 0.25rem;
    }

    .segment:hover,
    .segment:focus-visible,
    .segment.active {
        background: var(--risu-theme-selected);
        outline: none;
    }

</style>
