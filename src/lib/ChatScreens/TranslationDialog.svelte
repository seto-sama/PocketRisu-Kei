<script lang="ts">
    import { CheckIcon, CopyIcon, LanguagesIcon, LoaderCircleIcon, RefreshCwIcon } from '@lucide/svelte'
    import { onDestroy, onMount, tick } from 'svelte'
    import { language } from 'src/lang'
    import Button from '../UI/components/Button.svelte'
    import Dialog from '../UI/components/Dialog.svelte'
    import Textarea from '../UI/components/Textarea.svelte'
    import IconButton from '../UI/components/IconButton.svelte'
    import Switch from '../UI/components/Switch.svelte'
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

<Dialog
    bind:open
    size="default"
    closable
>
    {#snippet title()}
        <span class="inline-flex items-center">
            {language.translator}<Help key="translationDialog" name={language.translator} />
        </span>
    {/snippet}

    <div class="flex flex-col gap-3">
        <div>
            <div class="flex flex-col gap-2">
                <div class="flex min-h-8 items-center justify-between gap-3">
                    <span class="text-sm text-maintext">{language.translationPrompt}</span>
                    <TranslatorPresetList
                        compact
                        bind:value={DBState.db.translationDialogPromptPresetId}
                        bind:open={promptPickerOpen}
                        showConfigure
                        onConfigure={() => { open = false }}
                    />
                </div>
                <div class="flex min-h-8 items-center justify-between gap-3">
                    <span class="text-sm text-maintext">{language.modelPresetMenu}</span>
                    <ModelPresetList
                        compact
                        bind:value={DBState.db.translationDialogModelPresetId}
                        bind:open={modelPickerOpen}
                        showConfigure
                        onConfigure={() => { open = false }}
                        blankable
                    />
                </div>
                <div class="flex min-h-8 items-center justify-between gap-3">
                    <span class="min-w-0 text-sm text-maintext">
                        {language.translationDialogClearAfterConfirm}<Help
                            key="translationDialogClearAfterConfirm"
                            name={language.translationDialogClearAfterConfirm}
                        />
                    </span>
                    <Switch
                        className="shrink-0"
                        bind:checked={DBState.db.translationDialogClearAfterConfirm}
                        ariaLabel={language.translationDialogClearAfterConfirm}
                    />
                </div>
            </div>
            <div class="mt-2 border-t border-darkborderc pt-3">
                <Textarea
                    bind:value={input}
                    fullwidth
                    commitMode="input"
                    onInput={() => {
                        output = ''
                        draftStore.schedule({ input })
                    }}
                    placeholder={language.translationInputPlaceholder}
                    contentClassName="placeholder:text-subtext"
                />
            </div>
        </div>

        {#if translating}
            <div class="min-h-24 flex items-center justify-center">
                <LoaderCircleIcon class="size-8 animate-spin text-primary" />
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
            <Textarea
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
        <Button variant="outline" onclick={() => { open = false }}>
            {translating ? language.close : language.cancel}
        </Button>
        {#if output && !translating}
            <Button variant="primary" onclick={confirmOutput}>
                <CheckIcon />
                {language.confirm}
            </Button>
        {:else}
            <Button
                variant="primary"
                disabled={translating
                    || !input.trim()
                    || !DBState.db.translatorPresets?.some(preset => preset.id === DBState.db.translationDialogPromptPresetId)}
                onclick={translateInput}
            >
                <LanguagesIcon />
                {translating ? language.loading : language.translate}
            </Button>
        {/if}
    {/snippet}
</Dialog>
