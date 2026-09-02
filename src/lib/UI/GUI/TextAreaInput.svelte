<div
    class={"risu-field-border risu-local-stack risu-local-stack-focus relative flex flex-col n-scroll rounded-md shadow-xs text-textcolor focus-within:outline-hidden"
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
            bind:value={value}
            {onfocus}
            oninput={(e) => {
                if(optimaizedInput){
                    if(inpa++ > 10){
                        value = e.currentTarget.value
                        inpa = 0
                        onInput()
                    }
                }
                else{
                    value = e.currentTarget.value
                    onInput()
                }
                scheduleAutoResize()
            }}
            onchange={(e) => {
                if(optimaizedInput){
                    value = e.currentTarget.value
                    onInput()
                }
                onchange()
            }}
            onkeydown={(e) => {
                handlePopupEditorHotkey(e)
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
            <IconButton title={language.copy} aria-label={language.copy} onclick={copyValue}>
                {#if copied}
                    <CheckIcon class="text-success" />
                {:else}
                    <CopyIcon />
                {/if}
            </IconButton>
            {#if !readonly}
                <IconButton tone="destructive" title={language.reset} aria-label={language.reset} onclick={resetValue}>
                    <RefreshCwIcon />
                </IconButton>
            {/if}
            {#if !readonly}
                <IconButton title="Popup Editor" aria-label="Popup Editor" onclick={openPopupEditor}>
                    <Maximize2 />
                </IconButton>
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
    import { onDestroy, tick } from 'svelte';
  import { DBState, showPopupEditor } from 'src/ts/stores.svelte';
    import { Maximize2, CopyIcon, CheckIcon, RefreshCwIcon } from '@lucide/svelte'
    import { alertConfirm } from 'src/ts/alert'
    import { isSecureContext } from 'src/ts/secureContext'
    import { language } from 'src/lang'
    import IconButton from './IconButton.svelte'
    import IconButtonGroup from './IconButtonGroup.svelte'
    import { hotkeyMatches } from 'src/ts/defaulthotkeys'
    import { longpress } from 'src/ts/gui/longtouch'
    interface Props {
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
    }

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
        onchange = () => {},
        actionBar = undefined,
        readonly = false,
        tabindex = undefined,
        textareaRef = $bindable(),
        onfocus = undefined,
        autoResize = false,
        onLongPress = undefined,
        contentClassName = '',
        style = '',
    }: Props = $props();
    // `actionBar` prop overrides per-field; otherwise follow the accessibility toggle.
    const showActionBar = $derived(actionBar ?? DBState.db.showInputActionBar ?? true)
    let copied = $state(false)
    let copiedTimer: ReturnType<typeof setTimeout> | null = null
    let inpa = $state(0)
    let autoHeight = $state('44px')

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
            void value
            scheduleAutoResize()
        }
    })

    // Open the shared popup editor for this field, mirroring the contextmenu path.
    const openPopupEditor = () => {
        showPopupEditor({
            value,
            onSave: (nextValue) => {
                value = nextValue
                onInput()
                return true
            }
        })
    }

    const handlePopupEditorHotkey = (event: KeyboardEvent) => {
        if (readonly || DBState.db.enableHotkeys === false) return false
        const hotkey = DBState.db.hotkeys?.find((entry) => entry.action === 'popupEditor')
        if (!hotkeyMatches(hotkey, event)) return false
        event.preventDefault()
        event.stopPropagation()
        openPopupEditor()
        return true
    }

    const copyValue = async () => {
        const text = value ?? ''
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
            value = ''
            onInput()
        }
    }

    onDestroy(() => {
        if (copiedTimer) clearTimeout(copiedTimer)
    });

</script>
