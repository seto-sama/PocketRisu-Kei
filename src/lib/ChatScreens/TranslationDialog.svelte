<script lang="ts">
    import { CheckIcon, CopyIcon, LanguagesIcon, LoaderCircleIcon, RefreshCwIcon } from '@lucide/svelte'
    import { onDestroy, onMount, tick } from 'svelte'
    import { language } from 'src/lang'
    import ShButton from 'src/lib/UI/GUI/ShButton.svelte'
    import ShDialog from 'src/lib/UI/GUI/ShDialog.svelte'
    import TextAreaInput from 'src/lib/UI/GUI/TextAreaInput.svelte'
    import IconButton from 'src/lib/UI/GUI/IconButton.svelte'
    import ShSwitch from 'src/lib/UI/GUI/ShSwitch.svelte'
    import Help from 'src/lib/Others/Help.svelte'
    import ModelPresetList from 'src/lib/UI/ModelPresetList.svelte'
    import TranslatorPresetList from 'src/lib/UI/TranslatorPresetList.svelte'
    import { notifyError } from 'src/ts/alert'
    import { DBState } from 'src/ts/stores.svelte'
    import { runPromptTranslator } from 'src/ts/translator/translator'
    import { createBrowserDraftStore } from 'src/ts/storage/draftPersistence'

    const DRAFT_STORAGE_KEY = 'risu-translation-dialog-cache'
    interface TranslationDraft { input: string }
    const draftStore = createBrowserDraftStore<TranslationDraft>(DRAFT_STORAGE_KEY)

    interface Props {
        open?: boolean
        onConfirm?: (translation: string) => void | Promise<void>
    }

    let { open = $bindable(false), onConfirm = () => {} }: Props = $props()
    let input = $state('')
    let output = $state('')
    let translating = $state(false)
    let promptPickerOpen = $state(false)
    let modelPickerOpen = $state(false)
    let controller: AbortController | null = null

    onMount(() => {
        const cached = draftStore.load()
        if(typeof cached?.input === 'string') input = cached.input
    })

    async function translateInput() {
        const preset = DBState.db.translatorPresets?.find(candidate =>
            candidate.id === DBState.db.translationDialogPromptPresetId)
        const modelPresetId = DBState.db.translationDialogModelPresetId
        if(!input.trim() || !preset || translating) return

        translating = true
        output = ''
        void draftStore.flush({ input })
        const abortController = new AbortController()
        controller = abortController
        try {
            output = await runPromptTranslator(input, {
                preset,
                modelPresetId,
                regenerate: true,
                cache: false,
                onRequestStatusActivate: () => { open = true },
            }, abortController.signal)
        }
        catch(error) {
            if(!abortController.signal.aborted) notifyError(`${error}`)
        }
        finally {
            translating = false
            controller = null
        }
    }

    async function confirmOutput() {
        if(!output) return
        const translation = output
        output = ''
        open = false
        await tick()
        await onConfirm(translation)
        if(DBState.db.translationDialogClearAfterConfirm){
            input = ''
            await draftStore.flush({ input: '' })
        }
    }

    onDestroy(() => {
        void draftStore.flush({ input })
        controller?.abort()
    })
</script>

<ShDialog
    bind:open
    size="default"
    closeOnEscape={!promptPickerOpen && !modelPickerOpen}
    closeOnOutsideClick={!promptPickerOpen && !modelPickerOpen}
    closable
>
    {#snippet title()}{language.translator}{/snippet}

    <div class="flex flex-col gap-3">
        <div>
            <div class="flex flex-col gap-2">
                <div class="flex min-h-8 items-center justify-between gap-3">
                    <span class="text-sm text-textcolor">{language.translationPrompt}</span>
                    <TranslatorPresetList
                        compact
                        bind:value={DBState.db.translationDialogPromptPresetId}
                        bind:open={promptPickerOpen}
                        showConfigure
                    />
                </div>
                <div class="flex min-h-8 items-center justify-between gap-3">
                    <span class="text-sm text-textcolor">{language.modelPresetMenu}</span>
                    <ModelPresetList
                        compact
                        bind:value={DBState.db.translationDialogModelPresetId}
                        bind:open={modelPickerOpen}
                        showConfigure
                        blankable
                    />
                </div>
                <div class="flex min-h-8 items-center justify-between gap-3">
                    <span class="min-w-0 text-sm text-textcolor">
                        {language.translationDialogClearAfterConfirm}<Help
                            key="translationDialogClearAfterConfirm"
                            name={language.translationDialogClearAfterConfirm}
                        />
                    </span>
                    <ShSwitch
                        className="shrink-0"
                        bind:checked={DBState.db.translationDialogClearAfterConfirm}
                        ariaLabel={language.translationDialogClearAfterConfirm}
                    />
                </div>
            </div>
            <div class="mt-2 border-t border-darkborderc pt-3">
                <TextAreaInput
                    bind:value={input}
                    fullwidth
                    commitMode="input"
                    onInput={() => {
                        output = ''
                        draftStore.schedule({ input })
                    }}
                    placeholder={language.translationInputPlaceholder}
                    contentClassName="placeholder:text-textcolor2"
                />
            </div>
        </div>

        {#if translating}
            <div class="min-h-24 flex items-center justify-center text-textcolor2">
                <LoaderCircleIcon class="size-8 animate-spin" />
            </div>
        {:else if output}
            {#snippet resultActionBar(copyOutput: () => Promise<void>, copied: boolean)}
                <IconButton title={language.copy} aria-label={language.copy} onclick={copyOutput}>
                    {#if copied}
                        <CheckIcon class="text-success" />
                    {:else}
                        <CopyIcon />
                    {/if}
                </IconButton>
                <IconButton title={language.retranslate} aria-label={language.retranslate} onclick={translateInput}>
                    <RefreshCwIcon />
                </IconButton>
            {/snippet}
            <TextAreaInput
                bind:value={output}
                fullwidth
                readonly
                actionBar
                actionBarVariant="custom"
                customActionBar={resultActionBar}
            />
        {/if}
    </div>

    {#snippet footer()}
        <ShButton variant="outline" onclick={() => { open = false }}>
            {translating ? language.close : language.cancel}
        </ShButton>
        {#if output && !translating}
            <ShButton variant="primary" onclick={confirmOutput}>
                <CheckIcon />
                {language.confirm}
            </ShButton>
        {:else}
            <ShButton
                variant="primary"
                disabled={translating
                    || !input.trim()
                    || !DBState.db.translatorPresets?.some(preset => preset.id === DBState.db.translationDialogPromptPresetId)}
                onclick={translateInput}
            >
                <LanguagesIcon />
                {translating ? language.loading : language.translate}
            </ShButton>
        {/if}
    {/snippet}
</ShDialog>
