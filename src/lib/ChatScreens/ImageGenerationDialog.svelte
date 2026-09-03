<script lang="ts">
    import { ImageIcon } from '@lucide/svelte'
    import { language } from 'src/lang'
    import ShButton from 'src/lib/UI/GUI/ShButton.svelte'
    import ShDialog from 'src/lib/UI/GUI/ShDialog.svelte'
    import TextAreaInput from 'src/lib/UI/GUI/TextAreaInput.svelte'
    import type { character as Character } from 'src/ts/storage/database.svelte'
    import { notifyError } from 'src/ts/alert'
    import { DBState } from 'src/ts/stores.svelte'
    import { onDestroy, onMount, untrack } from 'svelte'
    import { createBrowserDraftStore } from 'src/ts/storage/draftPersistence'
    import ImageGenerationPresetList from 'src/lib/UI/ImageGenerationPresetList.svelte'
    import { getCurrentImageGenerationPreset } from 'src/ts/imageGeneration/presets'
    import ImageStylePresetList from 'src/lib/UI/ImageStylePresetList.svelte'
    import { applyImageStylePreset, listImageStylePresets } from 'src/ts/imageGeneration/stylePresets'
    import NumberInput from 'src/lib/UI/GUI/NumberInput.svelte'
    import Help from 'src/lib/Others/Help.svelte'
    import {
        beginImageGenerationWorkflow,
        getActiveImageGenerationWorkflow,
    } from 'src/ts/process/revenant/workflow'
    import { observeRevenantImageGenerationWorkflow } from 'src/ts/process/revenant/workflow/imageWorkflow'
    import { navigateToRequestStatusChat } from 'src/ts/status/requestStatusNavigation'
    import type { RevenantWorkflow } from 'src/ts/process/revenant'

    const DRAFT_STORAGE_KEY = 'risu-image-generation-cache'
    interface ImageGenerationDraft { prompt: string; negativePrompt: string; seed?: number }
    const draftStore = createBrowserDraftStore<ImageGenerationDraft>(DRAFT_STORAGE_KEY)

    interface Props {
        open?: boolean
        character: Character
    }

    let { open = $bindable(false), character }: Props = $props()
    let prompt = $state('')
    let negativePrompt = $state('')
    let seed = $state<number | undefined>(undefined)
    let generating = $state(false)
    let presetPickerOpen = $state(false)
    let stylePresetPickerOpen = $state(false)
    let recovering = false

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

    function activationFor(workflow: RevenantWorkflow): () => void {
        return () => {
            if (workflow.context?.kind !== 'image-generation') return
            const target = workflow.context.target
            if (!navigateToRequestStatusChat(workflow.context.messageId)) {
                navigateToRequestStatusChat(target.roomId)
            }
        }
    }

    async function executeWorkflow(workflow: RevenantWorkflow) {
        const context = workflow.context
        if (context?.kind !== 'image-generation') return
        await observeRevenantImageGenerationWorkflow(workflow, activationFor(workflow))
    }

    async function recoverActiveWorkflow() {
        const roomId = character.chats?.[character.chatPage]?.id
        if (!character.chaId || !roomId || generating || recovering) return
        recovering = true
        try {
            const workflow = await getActiveImageGenerationWorkflow(character.chaId, roomId)
            if (!workflow) return
            generating = true
            await executeWorkflow(workflow)
        }
        catch(error) {
            notifyError(`${error}`)
        }
        finally {
            generating = false
            recovering = false
        }
    }

    $effect(() => {
        character.chaId
        character.chats?.[character.chatPage]?.id
        // Recovery changes `generating`/`recovering` itself. Keep those state
        // writes out of this effect's dependency graph so a failed/busy claim
        // cannot create a self-sustaining recovery loop.
        untrack(() => void recoverActiveWorkflow())
    })

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
            const currentPreset = getCurrentImageGenerationPreset(DBState.db)
            const workflow = await beginImageGenerationWorkflow({
                characterId: target.characterId,
                roomId: target.chatId,
                prompt: requestPrompt.prompt,
                negativePrompt: requestPrompt.negativePrompt,
                seed: Number.isFinite(seed) ? seed : undefined,
                label: currentPreset.name,
            })
            await executeWorkflow(workflow)
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

<ShDialog bind:open size="default" closeOnEscape={!presetPickerOpen && !stylePresetPickerOpen} closeOnOutsideClick={!presetPickerOpen && !stylePresetPickerOpen} closable>
    {#snippet title()}{language.imageGeneration}{/snippet}

    <div>
        <div class="flex flex-col gap-2">
            <div class="flex min-h-8 items-center justify-between gap-3">
                <span class="text-sm text-maintext">{language.imageGenerationPreset}</span>
                <ImageGenerationPresetList compact bind:open={presetPickerOpen} showConfigure onConfigure={() => { open = false }} />
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
        <ShButton variant="outline" onclick={() => { open = false }}>
            {generating ? language.close : language.cancel}
        </ShButton>
        <ShButton variant="primary" disabled={generating || !prompt.trim()} onclick={generate}>
            <ImageIcon />
            {generating ? language.loading : language.generateImage}
        </ShButton>
    {/snippet}
</ShDialog>
