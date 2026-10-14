<script lang="ts">
    import { BookImageIcon, ImageIcon, MenuIcon, UserPlusIcon, XIcon } from '@lucide/svelte'
    import { getChatPage } from 'src/ts/storage/chatSelection.svelte';

    import { language } from 'src/lang'
    import Button from '../UI/components/Button.svelte'
    import Dialog from '../UI/components/Dialog.svelte'
    import Textarea from '../UI/components/Textarea.svelte'
    import IconButton from '../UI/components/IconButton.svelte'
    import Tooltip from '../UI/components/Tooltip.svelte'
    import * as DropdownMenu from '../UI/components/dropdown-menu'
    import DropdownMenuHelp from '../UI/components/DropdownMenuHelp.svelte'
    import { selectSingleFile } from 'src/ts/util'
    import type { character as Character } from 'src/ts/storage/database.svelte'
    import { notifyError } from 'src/ts/alert'
    import { DBState, showPopupEditor } from 'src/ts/stores.svelte'
    import { onDestroy, onMount, untrack } from 'svelte'
    import { createBrowserDraftStore } from 'src/ts/storage/draftPersistence'
    import ImageGenerationPresetList from 'src/lib/UI/ImageGenerationPresetList.svelte'
    import { getCurrentImageGenerationPreset } from 'src/ts/imageGeneration/presets'
    import ImageStylePresetList from 'src/lib/UI/ImageStylePresetList.svelte'
    import NovelAIUsageGauge from 'src/lib/UI/NovelAIUsageGauge.svelte'
    import { applyImageStylePreset, joinImagePrompts, loadImageStylePresets } from 'src/ts/imageGeneration/stylePresets'
    import { parseSDStudioPresets, type SDStudioPrompt } from 'src/ts/imageGeneration/sdStudioPresets'
    import { expandImageTagBundles, getImageTagBundleLorebook, listImageTagBundles, saveImageTagBundleLorebook } from 'src/ts/imageGeneration/tagBundles'
    import NumberInput from '../UI/components/NumberInput.svelte'
    import Help from 'src/lib/Others/Help.svelte'
    import { getActiveImageGenerationWorkflow } from 'src/ts/process/revenant/workflow'
    import { generateImageWorkflowSequence, observeRevenantImageGenerationWorkflow } from 'src/ts/process/revenant/workflow/imageWorkflow'
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
    let cancelRequested = $state(false)
    let queuedImages = $state(0)
    let presetPickerOpen = $state(false)
    let stylePresetPickerOpen = $state(false)
    let sdPreset = $state<{ name: string; prompts: SDStudioPrompt[] } | null>(null)
    let recovering = false

    onMount(() => {
        const cached = draftStore.load() as (Omit<ImageGenerationDraft, 'seed'> & {
            seed?: number | string
            draft?: ImageGenerationDraft
        }) | null
        // Accept the wrapper shape stored by an earlier version of the draft.
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

    function activateWorkflow(workflow: RevenantWorkflow) {
        if (workflow.context?.kind !== 'image-generation') return
        const target = workflow.context.target
        if (!navigateToRequestStatusChat(workflow.context.messageId)) {
            navigateToRequestStatusChat(target.roomId)
        }
    }

    async function recoverActiveWorkflow() {
        const roomId = character.chats?.[getChatPage(character)]?.id
        if (!character.chaId || !roomId || generating || recovering) return
        recovering = true
        try {
            const workflow = await getActiveImageGenerationWorkflow(character.chaId, roomId)
            if (!workflow) return
            generating = true
            await observeRevenantImageGenerationWorkflow(workflow, () => activateWorkflow(workflow))
        }
        catch(error) {
            notifyError(`${error}`)
        }
        finally {
            generating = false
            cancelRequested = false
            recovering = false
        }
    }

    $effect(() => {
        character.chaId
        character.chats?.[getChatPage(character)]?.id
        // Recovery changes `generating`/`recovering` itself. Keep those state
        // writes out of this effect's dependency graph so a failed/busy claim
        // cannot create a self-sustaining recovery loop.
        untrack(() => void recoverActiveWorkflow())
    })

    function editTagBundles() {
        const moduleId = loadImageStylePresets(DBState.db)
            .find(item => item.id === DBState.db.imageStylePresetId)?.moduleId
        showPopupEditor({
            title: language.imageCharacterPresetSettings,
            helpKey: 'imageCharacterPresets',
            mode: 'plain',
            value: getImageTagBundleLorebook(DBState.db, moduleId)?.content ?? '',
            onCommit: content => saveImageTagBundleLorebook(DBState.db, content, moduleId),
        })
    }

    async function selectSDPreset() {
        try {
            const file = await selectSingleFile(['json'])
            if (!file) return
            const prompts = parseSDStudioPresets(new TextDecoder().decode(file.data))
            sdPreset = { name: file.name.replace(/\.json$/i, ''), prompts }
        }
        catch {
            notifyError(language.sdPresetInvalid)
        }
    }

    async function generate() {
        const trimmedPrompt = prompt.trim()
        if((!trimmedPrompt && !sdPreset) || generating) return
        if(!getCurrentImageGenerationPreset(DBState.db).settings.sdProvider) {
            notifyError(language.imageProviderNotConfigured)
            return
        }
        const targetChat = character.chats[getChatPage(character)]
        if(!targetChat?.id) return
        const target = { characterId: character.chaId, chatId: targetChat.id }

        generating = true
        cancelRequested = false
        try {
            const trimmedNegativePrompt = negativePrompt.trim()
            const stylePreset = loadImageStylePresets(DBState.db)
                .find(item => item.id === DBState.db.imageStylePresetId)
            const requestPrompt = stylePreset
                ? applyImageStylePreset(stylePreset.content, trimmedPrompt, trimmedNegativePrompt)
                : { prompt: trimmedPrompt, negativePrompt: trimmedNegativePrompt }
            const bundles = listImageTagBundles(DBState.db, character)
            void draftStore.flush({ prompt, negativePrompt, seed })
            const currentPreset = getCurrentImageGenerationPreset(DBState.db)
            const expandedNegativePrompt = expandImageTagBundles(requestPrompt.negativePrompt, bundles).prompt
            const requests = (sdPreset?.prompts ?? [{ name: '', prompt: '' }]).map((scene, index) => {
                const expanded = expandImageTagBundles(joinImagePrompts(requestPrompt.prompt, scene.prompt), bundles)
                return {
                    characterId: target.characterId,
                    roomId: target.chatId,
                    prompt: expanded.prompt,
                    negativePrompt: expandedNegativePrompt,
                    preset: sdPreset ? { tagBundleNames: expanded.bundleNames, sceneName: scene.name } : undefined,
                    seed: Number.isFinite(seed) ? seed : undefined,
                    label: sdPreset
                        ? `${stylePreset?.name ?? language.imageStylePresetNone} · ${scene.name} · ${index + 1}/${sdPreset.prompts.length}`
                        : currentPreset.name,
                }
            })
            await generateImageWorkflowSequence(requests, {
                onActivate: activateWorkflow,
                onStart: pending => { queuedImages = pending },
                shouldStop: () => cancelRequested,
            })
            if (!cancelRequested) open = false
        }
        catch(error) {
            notifyError(`${error}`)
        }
        finally {
            generating = false
            cancelRequested = false
            queuedImages = 0
        }
    }
</script>

<Dialog bind:open size="default" closable>
    {#snippet title()}
        <span class="inline-flex items-center">
            {language.imageGeneration}<Help key="imageGenerationPresetQuickEdit" name={language.imageGeneration} />
        </span>
    {/snippet}

    {#snippet headerActions()}
        {#if getCurrentImageGenerationPreset(DBState.db).settings.sdProvider === 'novelai'}
            <NovelAIUsageGauge settings={getCurrentImageGenerationPreset(DBState.db).settings} {open} {generating} />
        {/if}
    {/snippet}

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
        <div class="mt-2 flex flex-col gap-3 pt-1.5">
            <label class="flex flex-col gap-1 text-sm text-maintext">
                <span>{language.prompt}</span>
                <Textarea bind:value={prompt} fullwidth commitMode="input" onInput={cacheDraft} imageTags />
            </label>
            <label class="flex flex-col gap-1 text-sm text-maintext">
                <span>{language.negativePrompt}</span>
                <Textarea bind:value={negativePrompt} fullwidth commitMode="input" onInput={cacheDraft} imageTags />
            </label>
        </div>
    </div>

    {#snippet footer()}
        <div class="flex w-full items-center justify-between gap-2">
            <div class="flex min-w-0 items-center gap-2">
                <DropdownMenu.Root>
                    <DropdownMenu.Trigger>
                        {#snippet child({ props })}
                            <Button {...props} size="icon" variant="outline" aria-label={language.tools} title={language.tools}>
                                <MenuIcon />
                            </Button>
                        {/snippet}
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Content side="top" align="start" class="min-w-44">
                        <DropdownMenu.Item onSelect={editTagBundles}>
                            <BookImageIcon />
                            <span>{language.imageCharacterPresetSettings}</span>
                        </DropdownMenu.Item>
                        <DropdownMenu.Item onSelect={selectSDPreset} disabled={generating}>
                            <UserPlusIcon />
                            <span>{language.sdPresetGenerate}</span>
                            <DropdownMenuHelp text={language.sdPresetGenerateHelp} />
                        </DropdownMenu.Item>
                    </DropdownMenu.Content>
                </DropdownMenu.Root>
                {#if sdPreset && !generating}
                    <div class="flex min-w-0 items-center gap-1 text-subtext">
                        <Tooltip>
                            {#snippet trigger(props)}
                                <button {...props} type="button" data-risu-help class="min-w-0 truncate text-xs cursor-help">
                                    {language.sdPresetQueued}
                                </button>
                            {/snippet}
                            <div>{language.imageStylePresetName}: {sdPreset.name}</div>
                            <div>{language.sdPresetCount(sdPreset.prompts.length)}</div>
                        </Tooltip>
                        <IconButton size="xs" title={language.remove} onclick={() => { sdPreset = null }}><XIcon /></IconButton>
                    </div>
                {/if}
            </div>
            <div class="flex items-center gap-2">
                <Button variant="outline" onclick={() => { open = false }}>
                    {generating ? language.close : language.cancel}
                </Button>
                <Button variant={generating ? 'destructive' : 'primary'} disabled={generating ? cancelRequested || queuedImages === 0 : (!prompt.trim() && !sdPreset)} onclick={() => {
                    if (generating) cancelRequested = true
                    else void generate()
                }}>
                    {#if generating}<XIcon />{:else}<ImageIcon />{/if}
                    {generating ? language.cancel : language.generateImage}
                </Button>
            </div>
        </div>
    {/snippet}
</Dialog>
