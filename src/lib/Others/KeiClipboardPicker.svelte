<script lang="ts">
    import { ClipboardCopyIcon, PinIcon, PinOffIcon, SearchIcon, Trash2Icon } from '@lucide/svelte'
    import { language } from 'src/lang'
    import {
        applyKeiClipboardChoice,
        clearKeiClipboard,
        pinKeiClipboardEntry,
        removeKeiClipboardEntry,
        keiClipboard,
        keiClipboardPicker,
        writeSystemClipboard,
    } from 'src/ts/clipboard/keiClipboard.svelte'
    import type { KeiClipboardEntry } from 'src/ts/clipboard/keiClipboardTypes'
    import { alertConfirm, notifyError, notifySuccess } from 'src/ts/alert'
    import Button from '../UI/components/Button.svelte'
    import Dialog from '../UI/components/Dialog.svelte'
    import IconButton from '../UI/components/IconButton.svelte'
    import IconButtonGroup from '../UI/components/IconButtonGroup.svelte'

    let query = $state('')
    let activeIndex = $state(0)
    // Pointer hover is pure CSS; the selected look marks the keyboard cursor only after
    // an arrow key, so opening the picker leaves the search field as the one focus cue.
    let keyboardNavigating = $state(false)
    let listRef = $state<HTMLElement | null>(null)
    let chosen: KeiClipboardEntry | null = null

    const filtered = $derived.by(() => {
        const needle = query.trim().toLocaleLowerCase()
        return needle
            ? keiClipboard.entries.filter(entry => entry.text.toLocaleLowerCase().includes(needle))
            : keiClipboard.entries
    })
    const hasUnpinned = $derived(keiClipboard.entries.some(entry => !entry.pinned))
    const relativeTime = $derived(new Intl.RelativeTimeFormat(navigator.language, { numeric: 'auto' }))

    $effect(() => {
        if (!keiClipboardPicker.open) return
        query = ''
        activeIndex = 0
        keyboardNavigating = false
        chosen = null
    })

    $effect(() => {
        if (activeIndex >= filtered.length) activeIndex = Math.max(0, filtered.length - 1)
    })

    $effect(() => {
        listRef?.querySelector(`[data-index="${activeIndex}"]`)?.scrollIntoView({ block: 'nearest' })
    })

    function formatAge(createdAt: number): string {
        const seconds = Math.round((createdAt - Date.now()) / 1000)
        const steps: [Intl.RelativeTimeFormatUnit, number][] = [
            ['second', 60], ['minute', 60], ['hour', 24], ['day', 7], ['week', 5], ['month', 12],
        ]
        let value = seconds
        for (const [unit, size] of steps) {
            if (Math.abs(value) < size) return relativeTime.format(value, unit)
            value = Math.round(value / size)
        }
        return relativeTime.format(value, 'year')
    }

    function choose(entry: KeiClipboardEntry) {
        chosen = entry
        keiClipboardPicker.open = false
    }

    async function copyToSystem(entry: KeiClipboardEntry) {
        try {
            await writeSystemClipboard(entry.text)
            notifySuccess(language.copiedToSystemClipboard)
        } catch (error) {
            notifyError(error)
        }
    }

    function handleSearchKeydown(event: KeyboardEvent) {
        if (event.isComposing) return
        const cursorEntry = keyboardNavigating ? filtered[activeIndex] : undefined
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            if (!filtered.length) return
            const step = event.key === 'ArrowDown' ? 1 : -1
            // The first arrow press only reveals the cursor (top entry, or the one under the pointer).
            if (keyboardNavigating) activeIndex = (activeIndex + step + filtered.length) % filtered.length
            keyboardNavigating = true
        } else if (event.key === 'Enter' && (cursorEntry ?? filtered[0])) {
            // Like a launcher, Enter without a cursor takes the top match.
            event.preventDefault()
            choose(cursorEntry ?? filtered[0])
        } else if (event.key === 'Delete' && event.shiftKey && cursorEntry) {
            event.preventDefault()
            removeKeiClipboardEntry(cursorEntry)
        }
    }
</script>

<Dialog
    bind:open={keiClipboardPicker.open}
    size="lg"
    ariaLabel={language.keiClipboardHistory}
    contentClass="max-h-[80dvh] gap-3"
    bodyClass="flex min-h-0 flex-col gap-3"
    onCloseAutoFocus={(event) => {
        event.preventDefault()
        applyKeiClipboardChoice(chosen)
        chosen = null
    }}
>
    {#snippet title()}{language.keiClipboardHistory}{/snippet}

    <label class="risu-field-border flex items-center gap-2 rounded-md px-3 py-2">
        <SearchIcon size={16} class="shrink-0 text-subtext" />
        <input
            class="min-w-0 flex-1 bg-transparent text-maintext outline-none placeholder:text-subtext"
            placeholder={language.keiClipboardSearch}
            aria-label={language.keiClipboardSearch}
            role="combobox"
            aria-expanded="true"
            aria-controls="kei-clipboard-list"
            aria-activedescendant={keyboardNavigating && filtered[activeIndex] ? `kei-clipboard-${filtered[activeIndex].id}` : undefined}
            bind:value={query}
            onkeydown={handleSearchKeydown}
        />
    </label>

    <div
        bind:this={listRef}
        id="kei-clipboard-list"
        role="listbox"
        aria-label={language.keiClipboardHistory}
        class="flex min-h-24 flex-col gap-1.5 overflow-y-auto"
    >
        {#each filtered as entry, index (entry.id)}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <div
                id={`kei-clipboard-${entry.id}`}
                data-index={index}
                role="option"
                tabindex="-1"
                aria-selected={keyboardNavigating && index === activeIndex}
                class="risu-interactive-surface group flex cursor-pointer items-start gap-2 rounded-md border border-darkborderc px-3 py-2"
                data-selected={keyboardNavigating && index === activeIndex}
                onpointermove={() => {
                    keyboardNavigating = false
                    activeIndex = index
                }}
                onclick={() => choose(entry)}
            >
                <div class="min-w-0 flex-1">
                    <p class="line-clamp-3 whitespace-pre-wrap break-words text-sm text-maintext">{entry.text}</p>
                    <p class="mt-1 flex items-center gap-1 text-xs text-subtext">
                        {#if entry.pinned}<PinIcon size={12} />{/if}
                        <span>{formatAge(entry.createdAt)}</span>
                        <span aria-hidden="true">·</span>
                        <span>{entry.text.length.toLocaleString()}</span>
                    </p>
                </div>
                <!-- The card is padded px-3 but py-2; pull the actions out to match the top gap. -->
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <div class="-mr-1" onclick={(event) => event.stopPropagation()}>
                    <IconButtonGroup size="sm" className="shrink-0 opacity-70 group-hover:opacity-100">
                        <IconButton
                            title={language.keiClipboardCopyToSystem}
                            aria-label={language.keiClipboardCopyToSystem}
                            onclick={() => { void copyToSystem(entry) }}
                        >
                            <ClipboardCopyIcon />
                        </IconButton>
                        <IconButton
                            title={entry.pinned ? language.keiClipboardUnpin : language.keiClipboardPin}
                            aria-label={entry.pinned ? language.keiClipboardUnpin : language.keiClipboardPin}
                            active={entry.pinned}
                            onclick={() => pinKeiClipboardEntry(entry, !entry.pinned)}
                        >
                            {#if entry.pinned}<PinOffIcon />{:else}<PinIcon />{/if}
                        </IconButton>
                        <IconButton
                            tone="destructive"
                            title={language.remove}
                            aria-label={language.remove}
                            onclick={() => removeKeiClipboardEntry(entry)}
                        >
                            <Trash2Icon />
                        </IconButton>
                    </IconButtonGroup>
                </div>
            </div>
        {:else}
            <p class="px-1 py-6 text-center text-sm text-subtext">{language.keiClipboardEmpty}</p>
        {/each}
    </div>

    {#snippet footer()}
        <div class="flex w-full flex-wrap items-center justify-between gap-2">
            <span class="hidden text-xs text-subtext sm:inline">{language.keiClipboardHint}</span>
            <Button variant="outline" size="sm" disabled={!hasUnpinned} onclick={async () => {
                if (await alertConfirm(language.keiClipboardClearConfirm)) clearKeiClipboard()
            }}>
                {language.keiClipboardClear}
            </Button>
        </div>
    {/snippet}
</Dialog>
