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

    const DRAFT_STORAGE_KEY = 'risu-image-generation-cache'

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
    let generating = $state(false)
    let draftSaveTimer: ReturnType<typeof setTimeout> | null = null

    onMount(() => {
        try {
            const raw = globalThis.localStorage?.getItem(DRAFT_STORAGE_KEY)
            if(!raw) return
            const parsed = JSON.parse(raw)
            const draft = parsed?.draft ?? parsed
            if(typeof draft?.prompt === 'string') prompt = draft.prompt
            if(typeof draft?.negativePrompt === 'string') negativePrompt = draft.negativePrompt
        }
        catch {
            // An unavailable or corrupt browser cache should not block image generation.
        }
    })

    function persistDraft() {
        try {
            globalThis.localStorage?.setItem(DRAFT_STORAGE_KEY, JSON.stringify({ prompt, negativePrompt }))
        }
        catch {
            // Keep the current in-memory draft when browser storage is unavailable.
        }
    }

    function scheduleDraftSave() {
        if(draftSaveTimer) clearTimeout(draftSaveTimer)
        draftSaveTimer = setTimeout(() => {
            draftSaveTimer = null
            persistDraft()
        }, 250)
    }

    onDestroy(() => {
        if(draftSaveTimer) clearTimeout(draftSaveTimer)
        persistDraft()
    })

    async function generate() {
        const trimmedPrompt = prompt.trim()
        if(!trimmedPrompt || generating) return
        if(!DBState.db.sdProvider) {
            notifyError(language.imageProviderNotConfigured)
            return
        }
        const targetChat = character.chats[character.chatPage]
        if(!targetChat?.id) return
        const target = { characterId: character.chaId, chatId: targetChat.id }

        generating = true
        try {
            const trimmedNegativePrompt = negativePrompt.trim()
            persistDraft()
            const reference = await generateAIImageInlay(trimmedPrompt, character, trimmedNegativePrompt, target)
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

<ShDialog bind:open size="default" closeOnEscape={!generating} closeOnOutsideClick={!generating} closable={!generating}>
    {#snippet title()}{language.imageGeneration}{/snippet}

    <div class="flex flex-col gap-3">
        <label class="flex flex-col gap-1 text-sm text-textcolor">
            <span>{language.prompt}</span>
            <TextAreaInput bind:value={prompt} fullwidth optimaizedInput={false} onInput={scheduleDraftSave} />
        </label>
        <label class="flex flex-col gap-1 text-sm text-textcolor">
            <span>{language.negativePrompt}</span>
            <TextAreaInput bind:value={negativePrompt} fullwidth optimaizedInput={false} onInput={scheduleDraftSave} />
        </label>
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
