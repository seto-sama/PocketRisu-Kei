<script lang="ts">
    import { LanguagesIcon, LoaderCircleIcon } from '@lucide/svelte'
    import { onDestroy, onMount } from 'svelte'
    import { language } from 'src/lang'
    import ShButton from 'src/lib/UI/GUI/ShButton.svelte'
    import ShDialog from 'src/lib/UI/GUI/ShDialog.svelte'
    import TextAreaInput from 'src/lib/UI/GUI/TextAreaInput.svelte'
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
    }

    let { open = $bindable(false) }: Props = $props()
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
            <div>
                <div class="flex items-center justify-between gap-3 py-1">
                    <span class="text-sm text-textcolor">{language.translationPrompt}</span>
                    <TranslatorPresetList
                        compact
                        bind:value={DBState.db.translationDialogPromptPresetId}
                        bind:open={promptPickerOpen}
                        showConfigure
                    />
                </div>
                <div class="flex items-center justify-between gap-3 py-1">
                    <span class="text-sm text-textcolor">{language.modelPresetMenu}</span>
                    <ModelPresetList
                        compact
                        bind:value={DBState.db.translationDialogModelPresetId}
                        bind:open={modelPickerOpen}
                        showConfigure
                        blankable
                    />
                </div>
            </div>
        </div>

        <div class="pt-3 border-t border-darkborderc">
            <TextAreaInput
                bind:value={input}
                fullwidth
                optimaizedInput={false}
                onInput={() => draftStore.schedule({ input })}
                placeholder={language.translationInputPlaceholder}
                contentClassName="placeholder:text-textcolor2"
            />
        </div>

        {#if translating}
            <div class="min-h-24 flex items-center justify-center text-textcolor2">
                <LoaderCircleIcon class="size-8 animate-spin" />
            </div>
        {:else if output}
            <TextAreaInput bind:value={output} fullwidth optimaizedInput={false} readonly />
        {/if}
    </div>

    {#snippet footer()}
        <ShButton variant="outline" onclick={() => { open = false }}>
            {translating ? language.close : language.cancel}
        </ShButton>
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
    {/snippet}
</ShDialog>
