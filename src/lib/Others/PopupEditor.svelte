<script lang="ts">
    import { AlignLeftIcon, BookOpenIcon, CheckIcon, ChevronDownIcon, ChevronUpIcon, EyeIcon, MenuIcon, SquarePenIcon, SaveIcon, SearchIcon, SendIcon, TextWrapIcon, XIcon } from '@lucide/svelte'
    import { language } from 'src/lang'
    import { alertConfirm, notifyError } from 'src/ts/alert'
    import { textAreaTextSize } from 'src/ts/gui/guisize'
    import { DBState, popUpEditorStore } from 'src/ts/stores.svelte'
    import Button from '../UI/components/Button.svelte'
    import Dialog from '../UI/components/Dialog.svelte'
    import * as DropdownMenu from '../UI/components/dropdown-menu';
    import CBSCodeEditor from '../UI/components/CBSCodeEditor.svelte'
    import Input from '../UI/components/Input.svelte'
    import Textarea from '../UI/components/Textarea.svelte'
    import SettingsList from '../UI/components/SettingsList.svelte'
    import Switch from '../UI/components/Switch.svelte'
    import Select from '../UI/components/Select.svelte'
    import SelectOption from '../UI/components/SelectOption.svelte'
    import IconButton from '../UI/components/IconButton.svelte'
    import IconButtonGroup from '../UI/components/IconButtonGroup.svelte'
    import { risuChatParser } from 'src/ts/parser/parser.svelte'
    import { getCurrentCharacter } from 'src/ts/storage/database.svelte'
    import { getChatVar, getGlobalChatVar } from 'src/ts/parser/chatVar.svelte'
    import { getModuleToggles } from 'src/ts/process/modules'
    import { parseToggleSyntax, type sidebarToggle } from 'src/ts/util'
    import { applyCBSPreviewValues, extractCBSPreviewReferences } from 'src/ts/parser/cbsPreview'
    import { createDebouncedDraftWriter } from 'src/ts/storage/draftPersistence'
    import { createPopupEditorCommitController } from 'src/ts/popupEditorCommit'
    import { INPUT_COMMIT_DEBOUNCE_MS } from 'src/ts/inputCommit'
    import { onDestroy, tick } from 'svelte'
    import CBSDocumentationDialog from './CBSDocumentationDialog.svelte'

    type PreviewToggleDefinition = {
        key:string
        value:string
        type:'select'|'text'|'textarea'|undefined
        options:string[]
    }

    type PreviewVariable = {
        id:string
        kind:'expression'|'chat'|'global'|'toggle'
        label:string
        expression?:string
        key?:string
        value:string
        dirty:boolean
        toggle?:PreviewToggleDefinition
    }

    let saving = $state(false)
    let confirmingClose = $state(false)
    let wordWrap = $state(true)
    let previewing = $state(false)
    let previewVariables:PreviewVariable[] = $state([])
    const previewVariableOverrides = new Map<string, Pick<PreviewVariable, 'value'|'dirty'>>()
    let previewText = $state('')
    let previewError = $state('')
    let searchRequest = $state(0)
    let editorSearchOpen = $state(false)
    let previewSearchOpen = $state(false)
    let previewSearchQuery = $state('')
    let previewSearchIndex = $state(0)
    let previewSearchInput:HTMLInputElement | null = $state(null)
    let previewPane:HTMLDivElement | undefined = $state()
    let documentationOpen = $state(false)
    const commitController = createPopupEditorCommitController(
        async (value) => popUpEditorStore.onCommit?.(value),
        () => popUpEditorStore.debounceMs,
    )

    function updateEditorValue(value: string) {
        popUpEditorStore.value = value
        commitController.update(value, popUpEditorStore.commitMode)
    }

    const previewSearchMatches = $derived.by(() => {
        const query = previewSearchQuery.toLocaleLowerCase()
        if (!query) return [] as { from:number, to:number }[]

        const text = previewText.toLocaleLowerCase()
        const matches:{ from:number, to:number }[] = []
        let from = 0
        while (from <= text.length - query.length) {
            const index = text.indexOf(query, from)
            if (index < 0) break
            matches.push({ from: index, to: index + query.length })
            from = index + query.length
        }
        return matches
    })

    const previewSearchChunks = $derived.by(() => {
        if (previewSearchMatches.length === 0) return [{ text: previewText }]

        const chunks:{ text:string, matchIndex?:number }[] = []
        let from = 0
        for (const [matchIndex, match] of previewSearchMatches.entries()) {
            if (match.from > from) chunks.push({ text: previewText.slice(from, match.from) })
            chunks.push({ text: previewText.slice(match.from, match.to), matchIndex })
            from = match.to
        }
        if (from < previewText.length) chunks.push({ text: previewText.slice(from) })
        return chunks
    })

    $effect(() => {
        const count = previewSearchMatches.length
        if (count === 0) previewSearchIndex = 0
        else if (previewSearchIndex >= count) previewSearchIndex = count - 1
    })

    function closeEditor() {
        debouncedPreviewRenderer.cancel()
        commitController.cancel()
        popUpEditorStore.open = false
        popUpEditorStore.value = ''
        popUpEditorStore.originalValue = ''
        popUpEditorStore.onCommit = null
        popUpEditorStore.onSubmit = null
        popUpEditorStore.title = ''
        popUpEditorStore.metadata = []
        popUpEditorStore.formatJson = false
        popUpEditorStore.mode = 'cbs'
        popUpEditorStore.commitMode = 'submit'
        popUpEditorStore.debounceMs = INPUT_COMMIT_DEBOUNCE_MS
        popUpEditorStore.hideCancel = false
        popUpEditorStore.submitKind = 'save'
        previewing = false
        previewVariables = []
        previewVariableOverrides.clear()
        previewText = ''
        previewError = ''
        searchRequest = 0
        editorSearchOpen = false
        closePreviewSearch()
        documentationOpen = false
    }

    async function requestClose() {
        if (saving || confirmingClose) return
        if (popUpEditorStore.commitMode !== 'submit') {
            await commitController.flush(popUpEditorStore.value, popUpEditorStore.commitMode)
            popUpEditorStore.originalValue = popUpEditorStore.value
        }
        if (popUpEditorStore.value !== popUpEditorStore.originalValue) {
            confirmingClose = true
            try {
                if (!await alertConfirm(language.popupEditorDiscardConfirm)) return
            } finally {
                confirmingClose = false
            }
        }
        closeEditor()
    }

    async function requestSubmit() {
        if (!popUpEditorStore.onCommit || saving) return

        saving = true
        try {
            let canClose = await commitController.flush(popUpEditorStore.value, popUpEditorStore.commitMode)
            if (canClose === false) return
            if (popUpEditorStore.onSubmit) {
                canClose = await popUpEditorStore.onSubmit(popUpEditorStore.value)
            }
            if (canClose !== false) closeEditor()
        } finally {
            saving = false
        }
    }

    function formatJson() {
        try {
            updateEditorValue(JSON.stringify(JSON.parse(popUpEditorStore.value), null, 2))
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            notifyError(language.popupEditorJsonError(message))
        }
    }

    function handleKeydown(event: KeyboardEvent) {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault()
            void requestSubmit()
        }
    }

    function handlePreviewShortcut(event: KeyboardEvent) {
        if (!previewing) return
        if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'f') {
            event.preventDefault()
            void openPreviewSearch()
            return
        }
        if (previewSearchOpen && event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            closePreviewSearch()
        }
    }

    async function openPreviewSearch() {
        previewSearchOpen = true
        await tick()
        previewSearchInput?.focus()
        previewSearchInput?.select()
    }

    function closePreviewSearch() {
        previewSearchOpen = false
        previewSearchQuery = ''
        previewSearchIndex = 0
    }

    async function scrollToPreviewSearchMatch() {
        await tick()
        previewPane
            ?.querySelector<HTMLElement>(`[data-preview-search-match="${previewSearchIndex}"]`)
            ?.scrollIntoView({ block: 'center' })
    }

    function movePreviewSearchMatch(offset:number) {
        const count = previewSearchMatches.length
        if (count === 0) return
        previewSearchIndex = (previewSearchIndex + offset + count) % count
        void scrollToPreviewSearchMatch()
    }

    function handlePreviewSearchInput() {
        previewSearchIndex = 0
        void scrollToPreviewSearchMatch()
    }

    function handlePreviewSearchKeydown(event:KeyboardEvent) {
        if (event.key !== 'Enter') return
        event.preventDefault()
        movePreviewSearchMatch(event.shiftKey ? -1 : 1)
    }

    function resolveCBSPreviewValue(expression:string):string {
        const character = getCurrentCharacter()
        return risuChatParser(expression, character
            ? { chara: character }
            : {})
    }

    function getToggleDefinitions():Map<string, PreviewToggleDefinition> {
        const character = getCurrentCharacter()
        const parsed = parseToggleSyntax([
            DBState.db.customPromptTemplateToggle,
            getModuleToggles(),
            character?.customModuleToggle ?? '',
        ].join('\n'))
        const definitions = new Map<string, PreviewToggleDefinition>()

        const addDefinitions = (items:sidebarToggle[]) => {
            for (const item of items) {
                if (item.type === 'group') {
                    addDefinitions(item.children)
                } else if (
                    item.key && item.value &&
                    item.type !== 'groupEnd' && item.type !== 'caption' && item.type !== 'divider'
                ) {
                    definitions.set(item.key, {
                        key: item.key,
                        value: item.value,
                        type: item.type,
                        options: item.options ?? [],
                    })
                }
            }
        }
        addDefinitions(parsed)
        return definitions
    }

    function getVariableOverrides() {
        const chat = Object.create(null) as Record<string, string>
        const global = Object.create(null) as Record<string, string>
        for (const variable of previewVariables) {
            if (!variable.dirty) continue
            if (variable.kind === 'chat' && variable.key) chat[variable.key] = variable.value
            if (variable.kind === 'global' && variable.key) global[variable.key] = variable.value
            if (variable.kind === 'toggle' && variable.key) global[`toggle_${variable.key}`] = variable.value
        }
        return { chat, global }
    }

    function renderPreview() {
        previewError = ''
        try {
            const source = applyCBSPreviewValues(
                popUpEditorStore.value,
                previewVariables.flatMap(variable => variable.dirty && variable.expression
                    ? [{ expression: variable.expression, value: variable.value }]
                    : []),
            )
            const character = getCurrentCharacter()
            const variableOverrides = getVariableOverrides()
            const parsedSource = risuChatParser(source, character
                ? { chara: character, variableOverrides }
                : { variableOverrides })
            previewText = parsedSource
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            previewText = ''
            previewError = language.popupEditorPreviewError(message)
        }
    }

    const debouncedPreviewRenderer = createDebouncedDraftWriter<void>(() => renderPreview(), 150)
    onDestroy(debouncedPreviewRenderer.cancel)

    function updatePreviewVariable(index:number, immediate = false) {
        previewVariables[index].dirty = true
        previewVariableOverrides.set(previewVariables[index].id, {
            value: previewVariables[index].value,
            dirty: true,
        })
        if (immediate) {
            debouncedPreviewRenderer.cancel()
            void renderPreview()
        } else {
            debouncedPreviewRenderer.schedule()
        }
    }

    function togglePreview() {
        if (previewing) {
            debouncedPreviewRenderer.cancel()
            closePreviewSearch()
            previewing = false
            return
        }

        debouncedPreviewRenderer.cancel()
        previewing = true
        previewText = ''
        previewError = ''
        try {
            const toggleDefinitions = getToggleDefinitions()
            previewVariables = extractCBSPreviewReferences(popUpEditorStore.value).map(reference => {
                if (reference.kind === 'expression') {
                    const id = `expression:${reference.expression}`
                    const previous = previewVariableOverrides.get(id)
                    return {
                        id,
                        kind: reference.kind,
                        label: reference.expression,
                        expression: reference.expression,
                        value: previous?.value ?? resolveCBSPreviewValue(reference.expression),
                        dirty: previous?.dirty ?? false,
                    }
                }
                if (reference.kind === 'toggle') {
                    const id = `toggle:${reference.key}`
                    const previous = previewVariableOverrides.get(id)
                    const toggle = toggleDefinitions.get(reference.key)
                    const storedValue = getGlobalChatVar(`toggle_${reference.key}`)
                    return {
                        id,
                        kind: reference.kind,
                        key: reference.key,
                        label: toggle?.value ?? reference.key,
                        value: previous?.value ?? (storedValue === 'null' ? '0' : storedValue),
                        dirty: previous?.dirty ?? false,
                        toggle,
                    }
                }
                const id = `${reference.kind}:${reference.key}`
                const previous = previewVariableOverrides.get(id)
                const storedValue = reference.kind === 'global'
                    ? getGlobalChatVar(reference.key)
                    : getChatVar(reference.key)
                return {
                    id,
                    kind: reference.kind,
                    key: reference.key,
                    label: reference.key,
                    value: previous?.value ?? (storedValue === 'null' ? '' : storedValue),
                    dirty: previous?.dirty ?? false,
                }
            })
            renderPreview()
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            previewVariables = []
            previewText = ''
            previewError = language.popupEditorPreviewError(message)
        }
    }

    function openSearch() {
        debouncedPreviewRenderer.cancel()
        if (previewing) {
            void openPreviewSearch()
            return
        }
        searchRequest++
    }
</script>

<svelte:window onkeydowncapture={handlePreviewShortcut} />

<Dialog
    open={popUpEditorStore.open}
    size="xl"
    closeOnEscape={!previewSearchOpen && !editorSearchOpen}
    onRequestClose={() => void requestClose()}
    contentClass="h-[calc(100dvh-2rem)] gap-3 p-3 sm:p-4"
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
                    <span class="text-subtext">
                        {item.label}: <span class="font-mono text-maintext">{item.value}</span>
                    </span>
                {/each}
            </div>
        {/if}

        {#if previewing}
            <div class="grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(0,7fr)_minmax(0,3fr)] gap-1 md:grid-cols-[minmax(0,1fr)_minmax(16rem,0.42fr)] md:grid-rows-[minmax(0,1fr)] md:gap-2">
                <div class="relative min-h-0 overflow-hidden rounded-md border border-darkborderc bg-lightbg">
                    {#if previewSearchOpen}
                        <div class="absolute top-1.5 right-1.5 z-10 flex w-[min(22rem,calc(100%-0.75rem))] items-center gap-0.5 overflow-hidden rounded-md border border-darkborderc bg-darkbg p-1 shadow-lg">
                            <div class="relative min-w-0 flex-1">
                                <SearchIcon class="pointer-events-none absolute left-1.5 top-1/2 z-10 size-3.5 -translate-y-1/2 text-subtext" />
                                <Input
                                    bind:ref={previewSearchInput}
                                    bind:value={previewSearchQuery}
                                    type="search"
                                    autocomplete="off"
                                    enterkeyhint="search"
                                    className="h-[1.625rem] min-h-[1.625rem] border-0 bg-lightbg py-0 pl-6 pr-1.5 text-xs shadow-none outline-none"
                                    placeholder={language.search}
                                    aria-label={language.search}
                                    oninput={handlePreviewSearchInput}
                                    onkeydown={handlePreviewSearchKeydown}
                                />
                            </div>
                            <span class="ml-1 shrink-0 text-xs tabular-nums text-subtext" aria-live="polite">
                                {language.popupEditorSearchCount(
                                    previewSearchMatches.length === 0 ? 0 : previewSearchIndex + 1,
                                    previewSearchMatches.length,
                                )}
                            </span>
                            <IconButtonGroup size="sm" className="shrink-0 gap-0.5">
                                <IconButton
                                    className="text-maintext"
                                    title={language.popupEditorPreviousMatch}
                                    aria-label={language.popupEditorPreviousMatch}
                                    onclick={() => movePreviewSearchMatch(-1)}
                                >
                                    <ChevronUpIcon />
                                </IconButton>
                                <IconButton
                                    className="text-maintext"
                                    title={language.popupEditorNextMatch}
                                    aria-label={language.popupEditorNextMatch}
                                    onclick={() => movePreviewSearchMatch(1)}
                                >
                                    <ChevronDownIcon />
                                </IconButton>
                                <IconButton
                                    className="text-maintext"
                                    title={language.close}
                                    aria-label={language.close}
                                    onclick={closePreviewSearch}
                                >
                                    <XIcon />
                                </IconButton>
                            </IconButtonGroup>
                        </div>
                    {/if}
                    <div bind:this={previewPane} class="h-full overflow-auto p-3">
                        {#if previewError}
                            <p class="text-sm text-danger">{previewError}</p>
                        {:else if !previewText}
                            <p class="text-sm text-subtext">{language.popupEditorPreviewEmpty}</p>
                        {:else}
                            <pre
                                class="m-0 font-mono leading-relaxed text-maintext"
                                class:text-xs={$textAreaTextSize === 0}
                                class:text-sm={$textAreaTextSize === 1}
                                class:text-md={$textAreaTextSize === 2}
                                class:text-lg={$textAreaTextSize === 3}
                                class:min-w-0={wordWrap}
                                class:min-w-max={!wordWrap}
                                class:whitespace-pre-wrap={wordWrap}
                                class:break-all={wordWrap}
                                class:whitespace-pre={!wordWrap}
                            >{#each previewSearchChunks as chunk}{#if chunk.matchIndex !== undefined}<mark
                                        data-preview-search-match={chunk.matchIndex}
                                        class="rounded-[1px] bg-primary/20 text-inherit"
                                        class:ring-1={chunk.matchIndex === previewSearchIndex}
                                        class:ring-primary={chunk.matchIndex === previewSearchIndex}
                                    >{chunk.text}</mark>{:else}{chunk.text}{/if}{/each}</pre>
                        {/if}
                    </div>
                </div>
                <aside class="min-h-0 min-w-0 overflow-x-hidden overflow-y-auto rounded-md border border-darkborderc bg-lightbg p-2 md:p-3">
                    <h3 class="mb-1 text-xs font-semibold text-maintext md:mb-3 md:text-sm">{language.popupEditorPreviewVariables}</h3>
                    {#if previewVariables.length === 0}
                        <p class="text-xs text-subtext md:text-sm">{language.popupEditorPreviewNoVariables}</p>
                    {:else}
                        <SettingsList spacing="none" className="gap-1 md:gap-2">
                            {#each previewVariables as variable, index (variable.id)}
                                <SettingsList variant="row" size="compact" align={variable.toggle?.type === 'textarea' ? 'start' : 'center'} layout="grid" className="min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-1 px-0 md:gap-2">
                                    <div class="min-w-0 flex-1 pl-1 pr-1 md:pr-2">
                                        <span
                                            class="block truncate whitespace-nowrap text-xs leading-tight text-maintext"
                                            title={variable.label}
                                        >{variable.label}</span>
                                        {#if variable.kind !== 'expression'}
                                            <code
                                                class="block truncate whitespace-nowrap text-[9px] leading-tight text-subtext md:text-[10px]"
                                                title={`${variable.kind}: ${variable.key}`}
                                            >{variable.kind}: {variable.key}</code>
                                        {/if}
                                    </div>

                                    {#if variable.kind === 'toggle' && variable.toggle?.type === 'select'}
                                        <Select
                                            className="min-w-0 flex-1"
                                            size="sm"
                                            bind:value={previewVariables[index].value}
                                            onchange={() => updatePreviewVariable(index, true)}
                                        >
                                            {#each variable.toggle.options as option, optionIndex}
                                                <SelectOption value={optionIndex.toString()}>{option}</SelectOption>
                                            {/each}
                                        </Select>
                                    {:else if variable.kind === 'toggle' && variable.toggle?.type === 'textarea'}
                                        <Textarea
                                            className="min-w-0 flex-1"
                                            size="xs"
                                            height="20"
                                            actionBar={false}
                                            commitMode="input"
                                            bind:value={previewVariables[index].value}
                                            onInput={() => updatePreviewVariable(index)}
                                        />
                                    {:else if variable.kind === 'toggle' && variable.toggle?.type === 'text'}
                                        <Input
                                            className="min-w-0 flex-1"
                                            size="sm"
                                            bind:value={previewVariables[index].value}
                                            oninput={() => updatePreviewVariable(index)}
                                        />
                                    {:else if variable.kind === 'toggle'}
                                        <Switch
                                            className="shrink-0 justify-self-end"
                                            size="sm"
                                            checked={previewVariables[index].value === '1'}
                                            onCheckedChange={(checked) => {
                                                previewVariables[index].value = checked ? '1' : '0'
                                                updatePreviewVariable(index, true)
                                            }}
                                        />
                                    {:else}
                                        <Input
                                            className="min-w-0 flex-1"
                                            size="sm"
                                            bind:value={previewVariables[index].value}
                                            oninput={() => updatePreviewVariable(index)}
                                        />
                                    {/if}
                                </SettingsList>
                            {/each}
                        </SettingsList>
                    {/if}
                </aside>
            </div>
        {:else if popUpEditorStore.mode === 'cbs'}
            <div
                class="min-h-0 w-full flex-1 font-mono"
                class:text-xs={$textAreaTextSize === 0}
                class:text-sm={$textAreaTextSize === 1}
                class:text-md={$textAreaTextSize === 2}
                class:text-lg={$textAreaTextSize === 3}
            >
                <CBSCodeEditor
                    value={popUpEditorStore.value}
                    {wordWrap}
                    {searchRequest}
                    onValueChange={updateEditorValue}
                    onSearchOpened={() => (searchRequest = 0)}
                    onSearchOpenChange={(open) => (editorSearchOpen = open)}
                    onSave={() => void requestSubmit()}
                />
            </div>
        {:else}
            <textarea
                bind:value={popUpEditorStore.value}
                wrap={wordWrap ? 'soft' : 'off'}
                class="risu-field-border min-h-0 w-full flex-1 resize-none overflow-auto rounded-md bg-lightbg p-3 font-mono leading-relaxed text-maintext outline-none"
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
                oninput={() => updateEditorValue(popUpEditorStore.value)}
                onkeydown={handleKeydown}
            ></textarea>
        {/if}
    </div>

    {#snippet footer()}
        <div class="flex w-full items-center justify-between gap-2">
            <div>
                <DropdownMenu.Root>
                    <DropdownMenu.Trigger>
                        {#snippet child({ props })}
                            <Button
                                {...props}
                                size="icon-sm"
                                variant="outline"
                                aria-label={language.tools}
                                title={language.tools}
                                disabled={saving}
                            >
                                <MenuIcon />
                            </Button>
                        {/snippet}
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Content side="top" align="start" class="min-w-44">
                        {#if popUpEditorStore.mode === 'cbs'}
                            <DropdownMenu.Item onSelect={openSearch} disabled={saving}>
                                <SearchIcon />
                                <span>{language.search}</span>
                            </DropdownMenu.Item>
                            <DropdownMenu.Item onSelect={togglePreview} disabled={saving}>
                                {#if previewing}<SquarePenIcon />{:else}<EyeIcon />{/if}
                                <span>{previewing ? language.popupEditorEdit : language.popupEditorPreview}</span>
                            </DropdownMenu.Item>
                            <DropdownMenu.Item onSelect={() => (documentationOpen = true)} disabled={saving}>
                                <BookOpenIcon />
                                <span>{language.cbsDocumentationMenu}</span>
                            </DropdownMenu.Item>
                        {/if}
                        <DropdownMenu.Item onSelect={() => (wordWrap = !wordWrap)} disabled={saving}>
                            <TextWrapIcon />
                            <span>{language.popupEditorWordWrap}</span>
                            {#if wordWrap}<CheckIcon class="ml-auto" />{/if}
                        </DropdownMenu.Item>
                        {#if popUpEditorStore.formatJson}
                            <DropdownMenu.Item onSelect={formatJson} disabled={saving}>
                                <AlignLeftIcon />
                                <span>{language.popupEditorFormatJson}</span>
                            </DropdownMenu.Item>
                        {/if}
                    </DropdownMenu.Content>
                </DropdownMenu.Root>
            </div>
            <div class="ml-auto flex items-center gap-2">
                {#if !popUpEditorStore.hideCancel}
                    <Button size="sm" variant="outline" onclick={() => void requestClose()} disabled={saving || confirmingClose}>
                        {language.cancel}
                    </Button>
                {/if}
                <Button size="sm" variant="primary" onclick={requestSubmit} disabled={saving}>
                    {#if popUpEditorStore.submitKind === 'send'}
                        <SendIcon />
                        {language.send}
                    {:else}
                        <SaveIcon />
                        {language.popupEditorSave}
                    {/if}
                </Button>
            </div>
        </div>
    {/snippet}
</Dialog>

<CBSDocumentationDialog bind:open={documentationOpen} />
