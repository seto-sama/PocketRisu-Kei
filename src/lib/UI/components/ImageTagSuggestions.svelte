<script lang="ts">
    import { Popover } from 'bits-ui'
    import { tick } from 'svelte'
    import { language } from 'src/lang'
    import { provideOverlayLayer } from 'src/ts/gui/overlayLayer.svelte'
    import { INPUT_COMMIT_DEBOUNCE_MS } from 'src/ts/inputCommit'
    import { searchImageTags, getImageTagDetail, getImageTagRange, type ImageTag, type ImageTagStatus } from 'src/ts/imageGeneration/imageTags'
    import { getTextareaCaretRect } from 'src/ts/gui/textareaCaret'
    import { completionContent } from 'src/ts/gui/completionContent'
    import { registerTextEntryEscapeHandler } from 'src/ts/gui/escapeKey'
    import { getCompletionAnchor, getCompletionBounds, getCompletionViewport } from 'src/ts/gui/completionPlacement'
    import OverlayLayerRoot from './overlay/OverlayLayerRoot.svelte'

    let { target }: { target: HTMLTextAreaElement } = $props()
    const listId = $props.id()
    let open = $state(false)
    let tags = $state<ImageTag[]>([])
    let selected = $state(0)
    let status = $state<ImageTagStatus>('idle')
    let caretRect = $state<DOMRect>()
    let popupWidth = $state(0)
    let collisionPadding = $state({ left: 0, right: 0, top: 0, bottom: 0 })
    const caretAnchor = $derived.by(() => {
        const rect = caretRect
        return { contextElement: target, getBoundingClientRect: () => rect ?? target.getBoundingClientRect() }
    })
    let composing = false
    let timer: ReturnType<typeof setTimeout>
    let controller: AbortController | undefined
    let sequence = 0
    let lastQuery: string | undefined
    provideOverlayLayer(() => open)

    function reposition() {
        if (!open) return
        const bounds = getCompletionBounds(target)
        const caret = getTextareaCaretRect(target, target.selectionEnd)
        const range = getImageTagRange(target.value, target.selectionEnd)
        const start = range ? getTextareaCaretRect(target, range.from) : caret
        caretRect = getCompletionAnchor(bounds, start, caret)
        popupWidth = bounds.right - bounds.left
        const viewport = getCompletionViewport(target)
        collisionPadding = {
            left: bounds.left - viewport.left,
            right: viewport.right - bounds.right,
            top: 0,
            bottom: 0,
        }
    }

    function cancelSearch() {
        sequence += 1
        clearTimeout(timer)
        controller?.abort()
        controller = undefined
    }

    function close() {
        cancelSearch()
        open = false
        tags = []
        status = 'idle'
        lastQuery = undefined
    }

    function queueSearch() {
        if (document.activeElement !== target) { close(); return }
        const range = composing || target.selectionStart === target.selectionEnd
            ? getImageTagRange(target.value, target.selectionEnd) : null
        if (!range) { close(); return }
        if (range.query === lastQuery) {
            reposition()
            return
        }
        cancelSearch()
        tags = []
        open = false
        status = 'idle'
        lastQuery = range.query
        const request = sequence
        timer = setTimeout(async () => {
            const pending = new AbortController()
            controller = pending
            try {
                const result = await searchImageTags(range.query, pending.signal, next => {
                    if (sequence === request) status = next
                })
                if (sequence !== request) return
                tags = result
                selected = 0
                open = tags.length > 0
                reposition()
            } catch {}
        }, INPUT_COMMIT_DEBOUNCE_MS)
    }

    function choose(tag: ImageTag) {
        const range = getImageTagRange(target.value, target.selectionStart)
        if (!range || target.selectionStart !== target.selectionEnd || composing) return
        const insert = tag.name + range.suffix
        target.setRangeText(insert, range.from, range.to, 'end')
        const cursor = range.from + insert.length
        target.focus()
        // Reuse the field's normal draft, commit and resize path.
        target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: insert }))
        close()
        void tick().then(() => target.setSelectionRange(cursor, cursor))
    }

    function dismissCompletion() {
        if (composing || !open) return false
        close()
        return true
    }

    function handleKeydown(event: KeyboardEvent) {
        if (event.isComposing || composing || !open) return
        if (event.key === 'Escape') dismissCompletion()
        else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            selected = (selected + (event.key === 'ArrowDown' ? 1 : -1) + tags.length) % tags.length
            void tick().then(() => document.getElementById(`${listId}-${selected}`)?.scrollIntoView({ block: 'nearest' }))
        } else if (event.key === 'Enter') choose(tags[selected])
        else return
        event.preventDefault()
        event.stopImmediatePropagation()
    }

    $effect(() => {
        const element = target
        const unregisterEscape = registerTextEntryEscapeHandler(element, dismissCompletion)
        const compositionStart = () => { composing = true; close() }
        const compositionEnd = () => { composing = false }
        const keyup = (event: KeyboardEvent) => {
            if (!composing && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) close()
        }
        element.addEventListener('input', queueSearch)
        element.addEventListener('pointerdown', close)
        element.addEventListener('keydown', handleKeydown, true)
        element.addEventListener('keyup', keyup)
        element.addEventListener('blur', close)
        element.addEventListener('compositionstart', compositionStart)
        element.addEventListener('compositionend', compositionEnd)
        window.addEventListener('scroll', reposition, true)
        window.addEventListener('resize', reposition)
        window.visualViewport?.addEventListener('resize', reposition)
        const resizeObserver = new ResizeObserver(reposition)
        resizeObserver.observe(element)
        return () => {
            unregisterEscape()
            close()
            element.removeEventListener('input', queueSearch)
            element.removeEventListener('pointerdown', close)
            element.removeEventListener('keydown', handleKeydown, true)
            element.removeEventListener('keyup', keyup)
            element.removeEventListener('blur', close)
            element.removeEventListener('compositionstart', compositionStart)
            element.removeEventListener('compositionend', compositionEnd)
            window.removeEventListener('scroll', reposition, true)
            window.removeEventListener('resize', reposition)
            window.visualViewport?.removeEventListener('resize', reposition)
            resizeObserver.disconnect()
        }
    })

    $effect(() => {
        const attributes = {
            'aria-autocomplete': 'list',
            'aria-expanded': String(open),
            'aria-controls': open ? listId : null,
            'aria-activedescendant': open ? `${listId}-${selected}` : null,
        }
        const element = target
        const previous = Object.fromEntries(Object.keys(attributes).map(name => [name, element.getAttribute(name)]))
        for (const [name, value] of Object.entries(attributes)) {
            if (value === null) element.removeAttribute(name)
            else element.setAttribute(name, value)
        }
        return () => {
            for (const [name, value] of Object.entries(previous)) {
                if (value === null) element.removeAttribute(name)
                else element.setAttribute(name, value)
            }
        }
    })
</script>

<Popover.Root {open} onOpenChange={next => { if (!next) close() }}>
    {#if open}
        <Popover.Portal>
            <OverlayLayerRoot interactive>
                <Popover.Content
                    customAnchor={caretAnchor}
                    align="start"
                    sideOffset={0}
                    {collisionPadding}
                    style={`--risu-completion-width: ${popupWidth}px`}
                    trapFocus={false}
                    onOpenAutoFocus={event => event.preventDefault()}
                    onCloseAutoFocus={event => event.preventDefault()}
                    onmousedown={event => event.preventDefault()}
                    onEscapeKeydown={event => { if (event.isComposing) event.preventDefault(); else event.stopPropagation() }}
                    class="risu-completion-list risu-layer-overlay z-[var(--risu-overlay-z)] max-h-[var(--bits-popover-content-available-height)]"
                >
                    <div id={listId} role="listbox" aria-label={language.imageTagAutocomplete.label} class="risu-completion-scroll">
                        {#each tags as tag, index (tag.name)}
                            <button
                                id={`${listId}-${index}`}
                                type="button"
                                role="option"
                                aria-label={tag.name}
                                aria-selected={index === selected}
                                tabindex={-1}
                                class="risu-completion-option"
                                onpointerdown={event => event.preventDefault()}
                                onclick={() => choose(tag)}
                            >
                                <span use:completionContent={{ label: tag.name, detail: getImageTagDetail(tag), description: tag.description }}></span>
                            </button>
                        {/each}
                    </div>
                </Popover.Content>
            </OverlayLayerRoot>
        </Popover.Portal>
    {/if}
</Popover.Root>

{#if status !== 'idle'}
    <p role="status" class="text-xs text-subtext">
        {language.imageTagAutocomplete[status]}
    </p>
{/if}
