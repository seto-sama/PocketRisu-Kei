<script lang="ts">
    import { AlignLeftIcon, CheckIcon, MenuIcon, SaveIcon, TextWrapIcon } from '@lucide/svelte'
    import { language } from 'src/lang'
    import { notifyError } from 'src/ts/alert'
    import { textAreaTextSize } from 'src/ts/gui/guisize'
    import { popUpEditorStore } from 'src/ts/stores.svelte'
    import ShButton from 'src/lib/UI/GUI/ShButton.svelte'
    import ShDialog from 'src/lib/UI/GUI/ShDialog.svelte'
    import ShDropdownMenu from 'src/lib/UI/GUI/ShDropdownMenu.svelte'
    import ShDropdownMenuContent from 'src/lib/UI/GUI/ShDropdownMenuContent.svelte'
    import ShDropdownMenuItem from 'src/lib/UI/GUI/ShDropdownMenuItem.svelte'
    import ShDropdownMenuTrigger from 'src/lib/UI/GUI/ShDropdownMenuTrigger.svelte'
    import ShToggle from 'src/lib/UI/GUI/ShToggle.svelte'
    import CBSCodeEditor from 'src/lib/UI/GUI/CBSCodeEditor.svelte'

    let saving = $state(false)
    let wordWrap = $state(true)

    function requestClose() {
        popUpEditorStore.open = false
        popUpEditorStore.onSave = null
        popUpEditorStore.title = ''
        popUpEditorStore.metadata = []
        popUpEditorStore.formatJson = false
        popUpEditorStore.mode = 'plain'
    }

    async function requestSave() {
        if (!popUpEditorStore.onSave || saving) return

        saving = true
        try {
            const canClose = await popUpEditorStore.onSave(popUpEditorStore.value)
            if (canClose !== false) requestClose()
        } finally {
            saving = false
        }
    }

    function formatJson() {
        try {
            popUpEditorStore.value = JSON.stringify(JSON.parse(popUpEditorStore.value), null, 2)
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            notifyError(language.popupEditorJsonError(message))
        }
    }

    function handleKeydown(event: KeyboardEvent) {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault()
            void requestSave()
        }
    }
</script>

<ShDialog
    open={popUpEditorStore.open}
    onOpenChange={(open) => { if (!open) requestClose() }}
    size="xl"
    tier="alert"
    closeOnEscape
    contentClass="h-[calc(100dvh-1rem)] max-h-[calc(100dvh-1rem)] sm:h-[90vh] sm:max-h-[90vh] gap-3 overflow-hidden p-3 sm:p-4"
    bodyClass="flex min-h-0 flex-1 flex-col"
>
    {#snippet title()}
        <span class:font-mono={popUpEditorStore.title !== ''} class:break-all={popUpEditorStore.title !== ''}>
            {popUpEditorStore.title || language.hotkeyDesc.popupEditor}
        </span>
    {/snippet}

    <div class="flex min-h-0 flex-1 flex-col gap-2">
        {#if popUpEditorStore.metadata.length > 0}
            <div class="flex flex-wrap gap-x-6 gap-y-1 text-xs">
                {#each popUpEditorStore.metadata as item (item.label)}
                    <span class="text-textcolor2">
                        {item.label}: <span class="font-mono text-textcolor">{item.value}</span>
                    </span>
                {/each}
            </div>
        {/if}

        {#if popUpEditorStore.mode === 'cbs'}
            <div
                class="min-h-0 w-full flex-1 font-mono"
                class:text-xs={$textAreaTextSize === 0}
                class:text-sm={$textAreaTextSize === 1}
                class:text-md={$textAreaTextSize === 2}
                class:text-lg={$textAreaTextSize === 3}
            >
                <CBSCodeEditor bind:value={popUpEditorStore.value} {wordWrap} onSave={() => void requestSave()} />
            </div>
        {:else}
            <textarea
                bind:value={popUpEditorStore.value}
                wrap={wordWrap ? 'soft' : 'off'}
                class="risu-field-border min-h-0 w-full flex-1 resize-none overflow-auto rounded-md bg-bgcolor p-3 font-mono leading-relaxed text-textcolor outline-none"
                class:text-xs={$textAreaTextSize === 0}
                class:text-sm={$textAreaTextSize === 1}
                class:text-md={$textAreaTextSize === 2}
                class:text-lg={$textAreaTextSize === 3}
                class:whitespace-pre-wrap={wordWrap}
                class:break-all={wordWrap}
                class:whitespace-pre={!wordWrap}
                autocomplete="off"
                autocapitalize="off"
                spellcheck="false"
                onkeydown={handleKeydown}
            ></textarea>
        {/if}
    </div>

    {#snippet footer()}
        <div class="flex w-full items-center justify-between gap-2">
            <!-- Keep the mobile footer on one line by moving editor tools into
                 the same compact dropdown pattern used by the chat composer. -->
            <div class="sm:hidden">
                <ShDropdownMenu>
                    <ShDropdownMenuTrigger>
                        {#snippet child({ props })}
                            <ShButton
                                {...props}
                                size="icon-sm"
                                variant="outline"
                                aria-label={language.tools}
                                title={language.tools}
                                disabled={saving}
                            >
                                <MenuIcon />
                            </ShButton>
                        {/snippet}
                    </ShDropdownMenuTrigger>
                    <ShDropdownMenuContent side="top" align="start" class="z-[60] min-w-44">
                        <ShDropdownMenuItem onSelect={() => (wordWrap = !wordWrap)} disabled={saving}>
                            <TextWrapIcon />
                            <span>{language.popupEditorWordWrap}</span>
                            {#if wordWrap}<CheckIcon class="ml-auto" />{/if}
                        </ShDropdownMenuItem>
                        {#if popUpEditorStore.formatJson}
                            <ShDropdownMenuItem onSelect={formatJson} disabled={saving}>
                                <AlignLeftIcon />
                                <span>{language.popupEditorFormatJson}</span>
                            </ShDropdownMenuItem>
                        {/if}
                    </ShDropdownMenuContent>
                </ShDropdownMenu>
            </div>

            <div class="hidden items-center gap-2 sm:flex">
                <ShToggle
                    size="sm"
                    className="gap-1 text-textcolor [&_svg]:size-4"
                    bind:pressed={wordWrap}
                    disabled={saving}
                >
                    <TextWrapIcon />
                    {language.popupEditorWordWrap}
                </ShToggle>
                {#if popUpEditorStore.formatJson}
                    <ShButton size="sm" variant="outline" onclick={formatJson} disabled={saving}>
                        <AlignLeftIcon />
                        {language.popupEditorFormatJson}
                    </ShButton>
                {/if}
            </div>
            <div class="ml-auto flex items-center gap-2">
                <ShButton size="sm" variant="outline" onclick={requestClose} disabled={saving}>
                    {language.cancel}
                </ShButton>
                <ShButton size="sm" variant="primary" onclick={requestSave} disabled={saving}>
                    <SaveIcon />
                    {language.popupEditorSave}
                </ShButton>
            </div>
        </div>
    {/snippet}
</ShDialog>
