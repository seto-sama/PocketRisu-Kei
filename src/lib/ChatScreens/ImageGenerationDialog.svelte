<script lang="ts">
    import { ImageIcon } from '@lucide/svelte'
    import { language } from 'src/lang'
    import ShButton from 'src/lib/UI/GUI/ShButton.svelte'
    import ShDialog from 'src/lib/UI/GUI/ShDialog.svelte'
    import TextAreaInput from 'src/lib/UI/GUI/TextAreaInput.svelte'
    import type { character as Character } from 'src/ts/storage/database.svelte'
    import { generateAIImageInlay } from 'src/ts/process/stableDiff'
    import { notifyError } from 'src/ts/alert'
    import { DBState } from 'src/ts/stores.svelte'
    import { onDestroy, onMount } from 'svelte'
    import { createBrowserDraftStore } from 'src/ts/storage/draftPersistence'
    import ImageGenerationPresetList from 'src/lib/UI/ImageGenerationPresetList.svelte'
    import { getCurrentImageGenerationPreset } from 'src/ts/imageGeneration/presets'
    import ImageStylePresetList from 'src/lib/UI/ImageStylePresetList.svelte'
    import { applyImageStylePreset, listImageStylePresets } from 'src/ts/imageGeneration/stylePresets'
    import NumberInput from 'src/lib/UI/GUI/NumberInput.svelte'
    import Help from 'src/lib/Others/Help.svelte'

    const DRAFT_STORAGE_KEY = 'risu-image-generation-cache'
    interface ImageGenerationDraft { prompt: string; negativePrompt: string; seed?: number }
    const draftStore = createBrowserDraftStore<ImageGenerationDraft>(DRAFT_STORAGE_KEY)

    interface Props {
        open?: boolean
        character: Character
        onGenerated: (
            reference: string,
            target: { characterId: string, chatId: string },
        ) => void | Promise<void>
    }

    let { open = $bindable(false), character, onGenerated }: Props = $props()
    let prompt = $state('')
    let negativePrompt = $state('')
    let seed = $state<number | undefined>(undefined)
    let generating = $state(false)
    let presetPickerOpen = $state(false)
    let stylePresetPickerOpen = $state(false)

    onMount(() => {
        const cached = draftStore.load() as (Omit<ImageGenerationDraft, 'seed'> & {
            seed?: number | string
            draft?: ImageGenerationDraft
        }) | null
        // `draft` supports the short-lived wrapper shape used by an earlier build.
        const draft = cached?.draft ?? cached
        if(typeof draft?.prompt === 'string') prompt = draft.prompt
        if(typeof draft?.negativePrompt === 'string') negativePrompt = draft.negativePrompt
        if(typeof draft?.seed === 'number' && Number.isFinite(draft.seed)) seed = draft.seed
        else if(typeof draft?.seed === 'string' && draft.seed.trim() && Number.isFinite(Number(draft.seed))) {
            seed = Number(draft.seed)
        }
    })

    onDestroy(() => {
        void draftStore.flush({ prompt, negativePrompt, seed })
    })

    function cacheDraft() {
        draftStore.schedule({ prompt, negativePrompt, seed })
    }

    async function generate() {
        const trimmedPrompt = prompt.trim()
        if(!trimmedPrompt || generating) return
        if(!getCurrentImageGenerationPreset(DBState.db).settings.sdProvider) {
            notifyError(language.imageProviderNotConfigured)
            return
        }
        const targetChat = character.chats[character.chatPage]
        if(!targetChat?.id) return
        const target = { characterId: character.chaId, chatId: targetChat.id }

        generating = true
        try {
            const trimmedNegativePrompt = negativePrompt.trim()
            const stylePreset = listImageStylePresets(DBState.db)
                .find(item => item.id === DBState.db.imageStylePresetId)
            const requestPrompt = stylePreset
                ? applyImageStylePreset(stylePreset.content, trimmedPrompt, trimmedNegativePrompt)
                : { prompt: trimmedPrompt, negativePrompt: trimmedNegativePrompt }
            void draftStore.flush({ prompt, negativePrompt, seed })
            const reference = await generateAIImageInlay(
                requestPrompt.prompt,
                character,
                requestPrompt.negativePrompt,
                target,
                Number.isFinite(seed) ? seed : undefined,
            )
            if(!reference) return

            await onGenerated(reference, target)
            open = false
        }
        catch(error) {
            notifyError(`${error}`)
        }
        finally {
            generating = false
        }
    }
</script>

<ShDialog bind:open size="default" closeOnEscape={!generating && !presetPickerOpen && !stylePresetPickerOpen} closeOnOutsideClick={!generating && !presetPickerOpen && !stylePresetPickerOpen} closable={!generating}>
    {#snippet title()}{language.imageGeneration}{/snippet}

    <div>
        <div class="flex flex-col gap-2">
            <div class="flex min-h-8 items-center justify-between gap-3">
                <span class="text-sm text-maintext">{language.imageGenerationPreset}</span>
                <ImageGenerationPresetList compact bind:open={presetPickerOpen} showConfigure />
            </div>
            <div class="flex min-h-8 items-center justify-between gap-3">
                <span class="text-sm text-maintext">{language.imageStylePreset}</span>
                <ImageStylePresetList compact bind:open={stylePresetPickerOpen} />
            </div>
            <div class="flex min-h-8 items-center justify-between gap-3">
                <span class="inline-flex items-center text-sm text-maintext">
                    {language.seed}<Help key="imageGenerationSeed" name={language.seed} />
                </span>
                <NumberInput
                    className="box-border h-8 w-48 text-sm"
                    size="sm"
                    min={0}
                    allowEmpty
                    bind:value={seed}
                    commitMode="input"
                    onCommit={cacheDraft}
                    ariaLabel={language.seed}
                />
            </div>
        </div>
        <div class="mt-2 flex flex-col gap-3 border-t border-darkborderc pt-2">
            <label class="flex flex-col gap-1 text-sm text-maintext">
                <span>{language.prompt}</span>
                <TextAreaInput bind:value={prompt} fullwidth commitMode="input" onInput={cacheDraft} />
            </label>
            <label class="flex flex-col gap-1 text-sm text-maintext">
                <span>{language.negativePrompt}</span>
                <TextAreaInput bind:value={negativePrompt} fullwidth commitMode="input" onInput={cacheDraft} />
            </label>
        </div>
    </div>

    {#snippet footer()}
        <ShButton variant="outline" disabled={generating} onclick={() => { open = false }}>
            {language.cancel}
        </ShButton>
        <ShButton variant="primary" disabled={generating || !prompt.trim()} onclick={generate}>
            <ImageIcon />
            {generating ? language.loading : language.generateImage}
        </ShButton>
    {/snippet}
</ShDialog>
