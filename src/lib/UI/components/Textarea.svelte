{#snippet defaultActionBarContent()}
    <IconButton title={language.copy} aria-label={language.copy} onclick={copyValue}>
        {#if copied}
            <CheckIcon class="text-success" />
        {:else}
            <CopyIcon />
        {/if}
    </IconButton>
    {#if !readonly}
        <IconButton tone="destructive" title={language.reset} aria-label={language.reset} onclick={resetValue}>
            <EraserIcon />
        </IconButton>
        <IconButton title="Popup Editor" aria-label="Popup Editor" onclick={openPopupEditor}>
            <Maximize2Icon />
        </IconButton>
    {/if}
{/snippet}

<div
    bind:this={containerRef}
    class={"risu-field-border risu-local-stack risu-local-stack-focus relative flex flex-col n-scroll rounded-md shadow-xs text-maintext focus-within:outline-hidden"
        + (margin === 'top' ? ' mt-4' : margin === 'bottom' ? ' mb-4' : margin === 'both' ? ' mt-2 mb-2' : '')
        + ((className) ? (' ' + className) : '')}
    class:text-sm={size === 'sm' || (size === 'default' && $textAreaTextSize === 1)}
    class:text-md={size === 'md' || (size === 'default' && $textAreaTextSize === 2)}
    class:text-lg={size === 'lg' || (size === 'default' && $textAreaTextSize === 3)}
    class:text-xl={size === 'xl'}
    class:text-xs={size === 'xs' || (size === 'default' && $textAreaTextSize === 0)}
    class:w-full={fullwidth}
    class:h-20={height === '20' || (height === 'default' && $textAreaSize === -5)}
    class:h-24={height === '24' || (height === 'default' && $textAreaSize === -4)}
    class:h-28={height === '28' || (height === 'default' && $textAreaSize === -3)}
    class:h-32={height === '32' || (height === 'default' && $textAreaSize === -2)}
    class:h-36={height === '36' || (height === 'default' && $textAreaSize === -1)}
    class:h-40={height === 'default' && $textAreaSize === 0}
    class:h-44={height === 'default' && $textAreaSize === 1}
    class:h-48={height === 'default' && $textAreaSize === 2}
    class:h-52={height === 'default' && $textAreaSize === 3}
    class:h-56={height === 'default' && $textAreaSize === 4}
    class:h-60={height === 'default' && $textAreaSize === 5}
    class:h-full={height === 'full'}
    class:min-h-20={height === '20' || (height === 'default' && $textAreaSize === -5)}
    class:min-h-24={height === '24' || (height === 'default' && $textAreaSize === -4)}
    class:min-h-28={height === '28' || (height === 'default' && $textAreaSize === -3)}
    class:min-h-32={height === '32' || (height === 'default' && $textAreaSize === -2)}
    class:min-h-36={height === '36' || (height === 'default' && $textAreaSize === -1)}
    class:min-h-40={height === 'default' && $textAreaSize === 0}
    class:min-h-48={height === 'default' && $textAreaSize === 1}
    class:min-h-56={height === 'default' && $textAreaSize === 2}
    class:min-h-64={height === 'default' && $textAreaSize === 3}
    class:min-h-72={height === 'default' && $textAreaSize === 4}
    class:min-h-80={height === 'default' && $textAreaSize === 5}
    style={autoResize ? `${style};height:${autoHeight};min-height:44px` : (style || undefined)}
>
    <div class="relative flex-1 min-h-0 w-full">
        <textarea
            class="risu-layer-local-content w-full h-full bg-transparent resize-none absolute top-0 left-0 {autoResize ? 'overflow-y-hidden' : 'overflow-y-auto'} {contentClassName}"
            class:risu-textarea-padding-x={padding}
            class:py-2={padding}
            {autocomplete}
            {placeholder}
            id={id}
            {readonly}
            {tabindex}
            bind:this={textareaRef}
            value={draftValue}
            onfocus={handleFocus}
            onblur={handleBlur}
            oninput={(e) => {
                draftValue = e.currentTarget.value
                dirty = draftValue !== value
                ondraft(draftValue)
                scheduleCommit()
                scheduleAutoResize()
            }}
            onchange={() => {
                if(resolvedCommitMode !== 'input') commitDraft()
                onchange()
            }}
            onkeydown={(e) => {
                if(!composing && e.key === 'Escape' && dirty){
                    e.preventDefault()
                    revertDraft()
                    return
                }
                handlePopupEditorHotkey(e)
            }}
            oncompositionstart={() => composing = true}
            oncompositionend={(e) => {
                composing = false
                draftValue = e.currentTarget.value
                dirty = draftValue !== value
                ondraft(draftValue)
                scheduleCommit()
            }}
            oncontextmenu={(e) => {
                if(!onLongPress && !readonly && DBState.db.longPressToPopupEditor){
                    e.preventDefault()
                    openPopupEditor()
                }
            }}
            use:optionalLongpress
></textarea>
    </div>
    {#if showActionBar}
        <IconButtonGroup size="sm" className="risu-layer-local-control absolute bottom-0 right-0 px-1.5 py-1">
            {#if actionBarVariant === 'custom'}
                {@render customActionBar(copyValue, copied)}
            {:else}
                {@render defaultActionBarContent()}
            {/if}
        </IconButtonGroup>
    {/if}
</div>

<style>
    .risu-textarea-padding-x {
        padding-inline: 0.625rem;
    }
</style>
<script lang="ts">
    import { textAreaSize, textAreaTextSize } from 'src/ts/gui/guisize'
    import { onDestroy, tick, untrack, type Snippet } from 'svelte';
  import { DBState, showPopupEditor } from 'src/ts/stores.svelte';
    import { Maximize2Icon, CopyIcon, CheckIcon, EraserIcon } from '@lucide/svelte'
    import { alertConfirm } from 'src/ts/alert'
    import { isSecureContext } from 'src/ts/secureContext'
    import { language } from 'src/lang'
    import IconButton from './IconButton.svelte'
    import IconButtonGroup from './IconButtonGroup.svelte'
    import { hotkeyMatches } from 'src/ts/defaulthotkeys'
    import { longpress } from 'src/ts/gui/longtouch'
    import { createDebouncedDraftWriter } from 'src/ts/storage/draftPersistence'
    import { INPUT_COMMIT_DEBOUNCE_MS, resolveInputCommitMode, type InputCommitMode } from 'src/ts/inputCommit'
    interface BaseProps {
        size?: 'xs'|'sm'|'md'|'lg'|'xl'|'default';
        autocomplete?: 'on'|'off';
        placeholder?: string;
        value: string;
        id?: string;
        padding?: boolean;
        margin?: "none"|"top"|"bottom"|"both";
        onInput?: any;
        fullwidth?: boolean;
        height?: '20'|'24'|'28'|'32'|'36'|'full'|'default';
        className?: string;
        optimaizedInput?: boolean;
        commitMode?: InputCommitMode;
        debounceMs?: number;
        oncommit?: (value: string) => void;
        ondraft?: (value: string) => void;
        onchange?: () => void;
        actionBar?: boolean;
        readonly?: boolean;
        tabindex?: number;
        textareaRef?: HTMLTextAreaElement;
        onfocus?: (event: FocusEvent & { currentTarget: HTMLTextAreaElement }) => void;
        autoResize?: boolean;
        onLongPress?: (event: MouseEvent) => void;
        contentClassName?: string;
        style?: string;
        popupTitle?: string;
    }

    type Props = BaseProps & (
        | { actionBarVariant?: 'default'; customActionBar?: never }
        | { actionBarVariant: 'custom'; customActionBar: Snippet<[() => Promise<void>, boolean]> }
    )

    let {
        size = 'default',
        autocomplete = 'off',
        placeholder = '',
        value = $bindable(),
        id = undefined,
        padding = true,
        margin = "none",
        onInput = () => {},
        fullwidth = false,
        height = 'default',
        className = '',
        optimaizedInput = true,
        commitMode = undefined,
        debounceMs = INPUT_COMMIT_DEBOUNCE_MS,
        oncommit = () => {},
        ondraft = () => {},
        onchange = () => {},
        actionBar = undefined,
        actionBarVariant = 'default',
        customActionBar = undefined,
        readonly = false,
        tabindex = undefined,
        textareaRef = $bindable(),
        onfocus = undefined,
        autoResize = false,
        onLongPress = undefined,
        contentClassName = '',
        style = '',
        popupTitle = '',
    }: Props = $props();
    // `actionBar` prop overrides per-field; otherwise follow the accessibility toggle.
    const showActionBar = $derived(actionBar ?? DBState.db.showInputActionBar ?? true)
    const resolvedCommitMode = $derived(resolveInputCommitMode(commitMode, optimaizedInput))
    let copied = $state(false)
    let copiedTimer: ReturnType<typeof setTimeout> | null = null
    let draftValue = $state(untrack(() => value ?? ''))
    let dirty = $state(false)
    let composing = $state(false)
    let autoHeight = $state('44px')
    let containerRef: HTMLDivElement

    function commitDraft(nextValue = draftValue) {
        commitWriter.cancel()
        draftValue = nextValue
        dirty = false
        if(nextValue === value) return
        value = nextValue
        onInput()
        oncommit(nextValue)
    }

    const commitWriter = createDebouncedDraftWriter<string>((nextValue) => {
        if(!composing) commitDraft(nextValue)
    }, untrack(() => debounceMs))

    function scheduleCommit() {
        if(composing) return
        if(resolvedCommitMode === 'input') commitDraft()
        else if(resolvedCommitMode === 'debounce') commitWriter.schedule(draftValue)
    }

    function revertDraft() {
        commitWriter.cancel()
        draftValue = value ?? ''
        dirty = false
        ondraft(draftValue)
        scheduleAutoResize()
    }

    function handleFocus(event: FocusEvent & { currentTarget: HTMLTextAreaElement }) {
        onfocus?.(event)
    }

    function handleBlur() {
        if(resolvedCommitMode !== 'input') commitDraft()
    }

    const labelText = (element: Element | null) => {
        const text = element?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
        return text.length <= 120 ? text : ''
    }

    const inferPopupTitle = () => {
        if(popupTitle.trim()) return popupTitle.trim()

        const disclosureLabel = containerRef
            ?.closest('[data-disclosure-field]')
            ?.querySelector(':scope > [data-disclosure-label]')
        const disclosureTitle = labelText(disclosureLabel)
        if(disclosureTitle) return disclosureTitle

        if(textareaRef?.labels?.length){
            const associatedTitle = labelText(textareaRef.labels[0])
            if(associatedTitle) return associatedTitle
        }

        let current: Element | null = containerRef
        for(let depth = 0; current && depth < 3; depth += 1){
            const previous = current.previousElementSibling
            if(previous){
                const directLabel = previous.matches('label, span, h1, h2, h3, h4')
                    ? previous
                    : previous.querySelector(':scope > label, :scope > span, :scope > h1, :scope > h2, :scope > h3, :scope > h4')
                const inferredTitle = labelText(directLabel)
                if(inferredTitle) return inferredTitle
            }
            current = current.parentElement
        }

        return ''
    }

    const scheduleAutoResize = () => {
        if(!autoResize) return
        tick().then(() => {
            const target = textareaRef
            if(!target) return
            // Measure against a collapsed input without collapsing the outer
            // field itself. Changing autoHeight to 44px here used to publish a
            // full layout frame on every keystroke, which could move an
            // ancestor chat scroller before the real height was restored.
            const previousInlineHeight = target.style.height
            target.style.height = '0px'
            const nextHeight = Math.max(target.scrollHeight, 44)
            target.style.height = previousInlineHeight
            autoHeight = `${nextHeight}px`
        })
    }

    function optionalLongpress(node: HTMLElement) {
        const action = onLongPress ? longpress(node, onLongPress) : undefined
        return {
            destroy: () => action?.destroy(),
        }
    }

    $effect(() => {
        if(autoResize){
            void draftValue
            scheduleAutoResize()
        }
    })

    $effect(() => {
        const externalValue = value ?? ''
        if(!dirty && externalValue !== draftValue){
            draftValue = externalValue
            ondraft(draftValue)
        }
    })

    // Open the shared popup editor for this field, mirroring the contextmenu path.
    const openPopupEditor = () => {
        showPopupEditor({
            value: draftValue,
            title: inferPopupTitle(),
            commitMode: resolvedCommitMode === 'input'
                ? 'input'
                : resolvedCommitMode === 'debounce' ? 'debounce' : 'submit',
            debounceMs,
            onCommit: (nextValue) => {
                draftValue = nextValue
                dirty = draftValue !== value
                ondraft(draftValue)
                scheduleAutoResize()
                commitDraft(nextValue)
                return true
            }
        })
    }

    const handlePopupEditorHotkey = (event: KeyboardEvent) => {
        if (readonly) return false
        const hotkey = DBState.db.hotkeys?.find((entry) => entry.action === 'popupEditor')
        if (!hotkeyMatches(hotkey, event)) return false
        event.preventDefault()
        event.stopPropagation()
        openPopupEditor()
        return true
    }

    const copyValue = async () => {
        const text = draftValue ?? ''
        try {
            if(isSecureContext && navigator.clipboard?.writeText){
                await navigator.clipboard.writeText(text)
            }
            else {
                // Fallback for non-secure (remote http) contexts where the Clipboard API is unavailable
                const ta = document.createElement('textarea')
                ta.value = text
                ta.style.position = 'fixed'
                ta.style.opacity = '0'
                document.body.appendChild(ta)
                ta.focus()
                ta.select()
                document.execCommand('copy')
                document.body.removeChild(ta)
            }
            copied = true
            if(copiedTimer) clearTimeout(copiedTimer)
            copiedTimer = setTimeout(() => { copied = false }, 1500)
        } catch (error) {}
    }

    const resetValue = async () => {
        if(await alertConfirm(language.clearInputConfirm)){
            draftValue = ''
            dirty = draftValue !== value
            ondraft(draftValue)
            commitDraft()
        }
    }

    onDestroy(() => {
        if (copiedTimer) clearTimeout(copiedTimer)
        if (dirty) commitDraft()
        else commitWriter.cancel()
    });

</script>
