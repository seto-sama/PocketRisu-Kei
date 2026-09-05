<script lang="ts">
    import { language } from "src/lang";
    import SettingLayout from "src/lib/Setting/Wrappers/SettingLayout.svelte";
    import ApiKeyModeControl, { getInitialApiKeyInputMode, type ApiKeyInputMode } from "src/lib/Setting/ApiKeyModeControl.svelte";
    import Switch from "../../UI/components/Switch.svelte";
    import Button from "../../UI/components/Button.svelte";
    import NumberInput from "../../UI/components/NumberInput.svelte";
    import Input from "../../UI/components/Input.svelte";
    import Select from "../../UI/components/Select.svelte";
    import SelectOption from "../../UI/components/SelectOption.svelte";
    import Slider from "../../UI/components/Slider.svelte";
    import { DBState } from "src/ts/stores.svelte";
    import { listApiKeys } from "src/ts/preset/apiKeyPool";
    import { selectSingleFile } from "src/ts/util";
    import { getCharImage } from "src/ts/characters";
    import { saveAsset } from "src/ts/globalApi.svelte";
    import { alertConfirm, alertError, notifyError, notifySuccess } from "src/ts/alert";
    import { ImageIcon, XIcon } from "@lucide/svelte";
    import SettingRenderer from "../SettingRenderer.svelte";
    import type { SettingItem } from "src/ts/setting/types";
    import PresetHeader from "../../UI/components/PresetHeader.svelte";
    import PresetPickerLayout from "src/lib/UI/PresetPickerLayout.svelte";
    import PresetPickerActions from "src/lib/UI/PresetPickerActions.svelte";
    import InlineEditableName from "../../UI/components/InlineEditableName.svelte";
    import {
        appendImageGenerationPreset,
        createImageGenerationPreset,
        decodeImageGenerationPresetFile,
        duplicateImageGenerationPreset,
        moveImageGenerationPreset,
        removeImageGenerationPreset,
    } from "src/ts/imageGeneration/presets";
    import { untrack } from "svelte";
    import NovelAIImageCoreSettings from "src/lib/UI/NovelAIImageCoreSettings.svelte";
    import ImageStylePresetList from "src/lib/UI/ImageStylePresetList.svelte";
    import { removePresetTag, togglePresetTag } from "src/ts/preset/tags";

    const emotionPromptItems: SettingItem[] = [
        {
            id: 'image.emotionPrompt',
            type: 'textarea',
            labelKey: 'emotionPrompt',
            bindKey: 'emotionPrompt2',
            helpKey: 'emotionPrompt',
            options: { placeholder: 'Leave it blank to use default' },
        },
    ];

    const imagePreset = $derived(DBState.db.imageGenerationPresets[DBState.db.imageGenerationPresetId]);
    const settings = $derived(imagePreset.settings);
    const imageNovelAIKeys = $derived.by(() => { DBState.db.apiKeyPool; return listApiKeys('novelai'); });
    const imageNovelAIKeyRef = $derived(validImageKeyRef(imageNovelAIKeys));
    let imageNovelAIKeyMode = $state<ApiKeyInputMode>('direct');
    let presetPickerOpen = $state(false);
    let selectedPresetFolder = $state("all");
    let presetSearchQuery = $state("");
    let visiblePresetIndexes = $state<number[]>([]);
    let presetEmptyMessage = $state("");
    const imagePresetTags = $derived(DBState.db.imageGenerationPresetTags ?? []);

    function validImageKeyRef(keys: { id: string }[]): string {
        const ref = settings.imageApiKeyRefs?.novelai ?? '';
        return keys.some((key) => key.id === ref) ? ref : '';
    }

    function selectImageKey(value: string) {
        settings.imageApiKeyRefs = {
            ...(settings.imageApiKeyRefs ?? {}),
            novelai: value || undefined,
        };
    }

    $effect(() => {
        if (settings.imageApiKeyRefs?.novelai && !imageNovelAIKeyRef) {
            selectImageKey('');
            imageNovelAIKeyMode = 'direct';
        }
    });

    $effect(() => {
        imagePreset.id;
        const keyRef = imageNovelAIKeyRef;
        const directKey = settings.NAIApiKey;
        untrack(() => {
            imageNovelAIKeyMode = getInitialApiKeyInputMode(keyRef, directKey);
        });
    });

    function selectImagePreset(index: number) {
        const preset = DBState.db.imageGenerationPresets[index];
        if (!preset) return;
        DBState.db.imageGenerationPresetId = index;
        presetPickerOpen = false;
    }

    function addImagePreset() {
        const preset = createImageGenerationPreset(
            language.imageGenerationPresetNew,
            settings,
        );
        appendImageGenerationPreset(DBState.db, preset);
    }

    function duplicateImagePreset(index: number) {
        if (duplicateImageGenerationPreset(DBState.db, index, language.copy)) {
            notifySuccess(language.presetDuplicated);
        }
    }

    async function deleteImagePreset(index: number) {
        const presets = DBState.db.imageGenerationPresets;
        if (presets.length <= 1) return notifyError(language.errors.onlyOnePreset);
        const target = presets[index];
        if (!target || !await alertConfirm(`${language.removeConfirm}${target.name}`)) return;
        removeImageGenerationPreset(DBState.db, index);
    }

    function moveImagePreset(fromIndex: number, toIndex: number) {
        moveImageGenerationPreset(DBState.db, fromIndex, toIndex);
    }

    async function importImagePreset() {
        try {
            const file = await selectSingleFile(["json"]);
            if (!file?.data) return;
            const preset = decodeImageGenerationPresetFile(file.data, settings, language.imageGenerationPresetInvalid);
            appendImageGenerationPreset(DBState.db, preset);
            notifySuccess(language.successImport);
        } catch (error) {
            alertError(`${error}`);
        }
    }

    async function uploadVibeFile() {
        const file = await selectSingleFile(['naiv4vibe']);
        if (!file) return;

        try {
            const vibeData = JSON.parse(new TextDecoder().decode(file.data));
            if (vibeData.version !== 1 || vibeData.identifier !== 'novelai-vibe-transfer') {
                alertError(language.imageSettings.invalidVibeFile);
                return;
            }

            settings.NAIImgConfig.vibe_data = vibeData;
            if (vibeData.thumbnail) {
                settings.NAIImgConfig.reference_image_multiple = [];

                if (settings.NAIImgModel.includes('nai-diffusion-4-full')) {
                    settings.NAIImgConfig.vibe_model_selection = 'v4full';
                } else if (settings.NAIImgModel.includes('nai-diffusion-4-curated')) {
                    settings.NAIImgConfig.vibe_model_selection = 'v4curated';
                } else if (settings.NAIImgModel.includes('nai-diffusion-4-5-full')) {
                    settings.NAIImgConfig.vibe_model_selection = 'v4-5full';
                } else if (settings.NAIImgModel.includes('nai-diffusion-4-5-curated')) {
                    settings.NAIImgConfig.vibe_model_selection = 'v4-5curated';
                }

                const selectedModel = settings.NAIImgConfig.vibe_model_selection;
                if (selectedModel && vibeData.encodings[selectedModel]) {
                    const encodings = vibeData.encodings[selectedModel];
                    const firstKey = Object.keys(encodings)[0];
                    if (firstKey) {
                        settings.NAIImgConfig.InfoExtracted = Number(encodings[firstKey].params.information_extracted);
                    }
                }
            }

            settings.NAIImgConfig.reference_strength_multiple ??= [0.7];
        } catch (error) {
            alertError(language.imageSettings.vibeParseError(error));
        }
    }

    async function uploadReferenceImage() {
        const image = await selectSingleFile(['jpg', 'jpeg', 'png', 'webp']);
        if (!image) return;

        settings.NAIImgConfig.character_image = await saveAsset(image.data);
        delete settings.NAIImgConfig.character_base64image;
    }

</script>

<div class="flex flex-col w-full">
    <SettingLayout variant="section" title={language.emotionImage} first>
        <div class="[&>*:first-child]:border-t-0">
            <SettingLayout variant="row" title={language.emotionMethod} description={language.help.emotionMethod}>
                {#snippet control()}
                    <Select className="w-48 text-sm" size="sm" bind:value={DBState.db.emotionProcesser}>
                        <SelectOption value="submodel">{language.submodel}</SelectOption>
                        <SelectOption value="embedding">{language.hypaV3Settings.embeddingModelLabel}</SelectOption>
                    </Select>
                {/snippet}
            </SettingLayout>
            <SettingRenderer items={emotionPromptItems} layout="row" />
        </div>
    </SettingLayout>

    <SettingLayout variant="section" title={language.imageGeneration}>
      <div class="[&>*:first-child]:border-t-0">
        <SettingLayout variant="row" title={language.imageGenerationPreset}>
            {#snippet control()}
                <PresetHeader
                    compact
                    label={language.imageGenerationPreset}
                    activeName={imagePreset.name}
                    onManage={() => presetPickerOpen = true}
                />
            {/snippet}
        </SettingLayout>
        <SettingLayout variant="row" title={language.imageStylePreset}>
            {#snippet control()}
                <ImageStylePresetList compact />
            {/snippet}
        </SettingLayout>
        <SettingLayout variant="row" title={`${language.imageGeneration} ${language.provider}`} description={language.help.sdProvider}>
          {#snippet control()}
          <Select className="w-48 text-sm" size="sm" bind:value={settings.sdProvider}>
            <SelectOption value="" >{language.none}</SelectOption>
            <SelectOption value="novelai" >Novel AI</SelectOption>
            <SelectOption value="comfyui" >ComfyUI</SelectOption>
          </Select>
          {/snippet}
        </SettingLayout>

        {#if settings.sdProvider === 'novelai'}
            <SettingLayout variant="row" title={language.novelAIApiKey} description={language.help.novelaiToken}>
                {#snippet control()}<ApiKeyModeControl bind:mode={imageNovelAIKeyMode} entries={imageNovelAIKeys} selectedId={imageNovelAIKeyRef} bind:directValue={settings.NAIApiKey} onSelect={selectImageKey} placeholder="pst-..." />{/snippet}
            </SettingLayout>

            <SettingLayout variant="row" title={language.model} description={language.help.naiModel}>{#snippet control()}<Select className="w-48 text-sm" size="sm" bind:value={settings.NAIImgModel}>
                <SelectOption value="nai-diffusion-5-full">NAI V5 Full</SelectOption>
                <SelectOption value="nai-diffusion-5-curated">NAI V5 Curated</SelectOption>
                <SelectOption value="nai-diffusion-4-5-full">NAI V4.5 Full</SelectOption>
                <SelectOption value="nai-diffusion-4-5-curated">NAI V4.5 Curated</SelectOption>
                <SelectOption value="nai-diffusion-4-full">NAI V4 Full</SelectOption>
                <SelectOption value="nai-diffusion-4-curated-preview">NAI V4 Curated</SelectOption>

            </Select>{/snippet}</SettingLayout>
            <NovelAIImageCoreSettings {settings} />

            <SettingLayout variant="row" title={language.imageSettings.imageReference} description={language.help.naiImageReference}>{#snippet control()}<Select className="w-48 text-sm" size="sm" bind:value={settings.NAIImgConfig.reference_mode}>
                <SelectOption value="" >{language.none}</SelectOption>
                <SelectOption value="vibe" >{language.imageSettings.vibeTransfer}</SelectOption>
                {#if settings.NAIImgModel === 'nai-diffusion-4-5-full' || settings.NAIImgModel === 'nai-diffusion-4-5-curated'}
                    <SelectOption value="reference" >{language.imageSettings.characterReference}</SelectOption>
                {/if}
            </Select>{/snippet}</SettingLayout>

            {#if settings.NAIImgConfig.reference_mode === 'vibe'}
                <SettingLayout variant="row" title={language.imageSettings.vibeFile}>
                {#snippet control()}
                    <div class="flex items-center gap-2">
                        {#if settings.NAIImgConfig.vibe_data?.thumbnail}
                            <img src={settings.NAIImgConfig.vibe_data.thumbnail} alt={language.imageSettings.vibePreview} class="h-8 w-8 rounded object-cover border border-darkborderc" />
                        {/if}
                        <Button variant="outline" size="sm" onclick={uploadVibeFile}>
                            <ImageIcon />
                            {settings.NAIImgConfig.vibe_data ? language.edit : language.select}
                        </Button>
                        {#if settings.NAIImgConfig.vibe_data}
                            <Button
                                variant="destructive"
                                size="icon-sm"
                                onclick={() => {
                                    settings.NAIImgConfig.vibe_data = undefined;
                                    settings.NAIImgConfig.vibe_model_selection = undefined;
                                }}
                                aria-label={language.remove}
                            >
                                <XIcon />
                            </Button>
                        {/if}
                    </div>
                {/snippet}
                </SettingLayout>

                {#if settings.NAIImgConfig.vibe_data}

                    <SettingLayout variant="row" title={language.imageSettings.vibeModel} description={language.help.naiVibeModel}>{#snippet control()}<Select className="w-48 text-sm" size="sm" bind:value={settings.NAIImgConfig.vibe_model_selection} onchange={(e) => {
                        // When vibe model changes, set InfoExtracted to the first value
                        if (settings.NAIImgConfig.vibe_data?.encodings &&
                            settings.NAIImgConfig.vibe_model_selection &&
                            settings.NAIImgConfig.vibe_data.encodings[settings.NAIImgConfig.vibe_model_selection]) {
                            const encodings = settings.NAIImgConfig.vibe_data.encodings[settings.NAIImgConfig.vibe_model_selection];
                            const firstKey = Object.keys(encodings)[0];
                            if (firstKey) {
                                settings.NAIImgConfig.InfoExtracted = Number(encodings[firstKey].params.information_extracted);
                            }
                        }
                    }}>
                        {#if settings.NAIImgConfig.vibe_data.encodings?.v4full}
                            <SelectOption value="v4full">nai-diffusion-4-full</SelectOption>
                        {/if}
                        {#if settings.NAIImgConfig.vibe_data.encodings?.v4curated}
                            <SelectOption value="v4curated">nai-diffusion-4-curated</SelectOption>
                        {/if}
                        {#if settings.NAIImgConfig.vibe_data.encodings?.['v4-5full']}
                            <SelectOption value="v4-5full">nai-diffusion-4-5-full</SelectOption>
                        {/if}
                        {#if settings.NAIImgConfig.vibe_data.encodings?.['v4-5curated']}
                            <SelectOption value="v4-5curated">nai-diffusion-4-5-curated</SelectOption>
                        {/if}
                    </Select>{/snippet}</SettingLayout>

                    <SettingLayout variant="row" title={language.imageSettings.informationExtracted} description={language.help.naiInfoExtracted}>{#snippet control()}<Select className="w-48 text-sm" size="sm" value={String(settings.NAIImgConfig.InfoExtracted)} onchange={(event) => settings.NAIImgConfig.InfoExtracted = Number(event.currentTarget.value)}>
                        {#if settings.NAIImgConfig.vibe_model_selection && settings.NAIImgConfig.vibe_data.encodings[settings.NAIImgConfig.vibe_model_selection]}
                            {#each Object.entries(settings.NAIImgConfig.vibe_data.encodings[settings.NAIImgConfig.vibe_model_selection]) as [key, value]}
                                <SelectOption value={String(value.params.information_extracted)}>{value.params.information_extracted}</SelectOption>
                            {/each}
                        {/if}
                    </Select>{/snippet}</SettingLayout>

                    <SettingLayout variant="row" title={language.imageSettings.referenceStrength} description={language.help.naiRefStrength}>{#snippet control()}<div class="w-48"><Slider min={0} max={1} step={0.1} fixed={2} bind:value={settings.NAIImgConfig.reference_strength_multiple[0]} /></div>{/snippet}</SettingLayout>
                {/if}
            {/if}

            {#if settings.NAIImgConfig.reference_mode === 'reference' &&
                (settings.NAIImgModel === 'nai-diffusion-4-5-full' || settings.NAIImgModel === 'nai-diffusion-4-5-curated')}
                <SettingLayout variant="row" title={language.imageSettings.referenceType} description={language.help.naiReferenceType}>
                    {#snippet control()}
                        <Select className="w-48 text-sm" size="sm" bind:value={settings.NAIImgConfig.reference_type}>
                            <SelectOption value="character">{language.imageSettings.referenceCharacter}</SelectOption>
                            <SelectOption value="style">{language.imageSettings.referenceStyle}</SelectOption>
                            <SelectOption value="character&style">{language.imageSettings.referenceCharacterAndStyle}</SelectOption>
                        </Select>
                    {/snippet}
                </SettingLayout>
                <SettingLayout variant="row" title={language.imageSettings.characterReferenceImage} description={language.imageSettings.useCharacterDefaultHint}>
                {#snippet control()}
                    <div class="flex items-center gap-2">
                        {#if settings.NAIImgConfig.character_image}
                            {#await getCharImage(settings.NAIImgConfig.character_image, 'plain')}
                                <div class="h-8 w-8 rounded border border-darkborderc bg-button animate-pulse"></div>
                            {:then image}
                                <img src={image} class="h-8 w-8 rounded object-cover border border-darkborderc" alt={language.imageSettings.imagePreview}/>
                            {/await}
                        {/if}
                        <Button variant="outline" size="sm" onclick={uploadReferenceImage}>
                            <ImageIcon />
                            {settings.NAIImgConfig.character_image ? language.edit : language.select}
                        </Button>
                        {#if settings.NAIImgConfig.character_image}
                            <Button
                                variant="destructive"
                                size="icon-sm"
                                onclick={() => {
                                    settings.NAIImgConfig.character_image = '';
                                    delete settings.NAIImgConfig.character_base64image;
                                }}
                                aria-label={language.remove}
                            >
                                <XIcon />
                            </Button>
                        {/if}
                    </div>
                {/snippet}
                </SettingLayout>
                <SettingLayout variant="row" title={language.imageSettings.preciseReferenceStrength} description={language.help.naiReferenceStrength}>
                    {#snippet control()}<div class="w-48"><Slider min={0} max={1} step={0.05} fixed={2} inputWidth="w-16" bind:value={settings.NAIImgConfig.reference_strength} /></div>{/snippet}
                </SettingLayout>
                <SettingLayout variant="row" title={language.imageSettings.referenceFidelity} description={language.help.naiReferenceFidelity}>
                    {#snippet control()}<div class="w-48"><Slider min={0} max={1} step={0.05} fixed={2} inputWidth="w-16" bind:value={settings.NAIImgConfig.reference_fidelity} /></div>{/snippet}
                </SettingLayout>

            {/if}




            {#if (settings.NAIImgModel === 'nai-diffusion-3' || settings.NAIImgModel === 'nai-diffusion-furry-3' || settings.NAIImgModel === 'nai-diffusion-2')
            && settings.NAIImgConfig.sampler !== 'ddim_v3'}
                <SettingLayout variant="row" title={language.imageSettings.useSmea} description={language.help.naiUseSMEA}>{#snippet control()}<Switch bind:checked={settings.NAIImgConfig.sm}/>{/snippet}</SettingLayout>
            {/if}

            {#if settings.NAIImgModel === 'nai-diffusion-3' && settings.NAIImgConfig.sampler !== 'ddim_v3'}
                <SettingLayout variant="row" title={language.imageSettings.useDyn} description={language.help.naiUseDYN}>{#snippet control()}<Switch bind:checked={settings.NAIImgConfig.sm_dyn}/>{/snippet}</SettingLayout>
            {/if}

            {#if settings.NAIImgModel === 'nai-diffusion-4-5-full' || settings.NAIImgModel === 'nai-diffusion-4-5-curated'
            || settings.NAIImgModel === 'nai-diffusion-4-full' || settings.NAIImgModel === 'nai-diffusion-4-curated-preview'
            || settings.NAIImgModel === 'nai-diffusion-3' || settings.NAIImgModel === 'nai-diffusion-furry-3'}
                <SettingLayout variant="row" title={language.imageSettings.varietyPlus} description={language.help.naiVarietyPlus}>{#snippet control()}<Switch bind:checked={settings.NAIImgConfig.variety_plus}/>{/snippet}</SettingLayout>
            {/if}

            {#if settings.NAIImgModel === 'nai-diffusion-3' || settings.NAIImgModel === 'nai-diffusion-furry-3' || settings.NAIImgModel === 'nai-diffusion-2'}
                <SettingLayout variant="row" title={language.imageSettings.decrisp} description={language.help.naiDecrisp}>{#snippet control()}<Switch bind:checked={settings.NAIImgConfig.decrisp}/>{/snippet}</SettingLayout>
            {/if}

            {#if settings.NAIImgModel === 'nai-diffusion-4-full'
            || settings.NAIImgModel === 'nai-diffusion-4-curated-preview'}
                <SettingLayout variant="row" title={language.imageSettings.useLegacyUc} description={language.help.naiLegacyUC}>{#snippet control()}<Switch bind:checked={settings.NAIImgConfig.legacy_uc}/>{/snippet}</SettingLayout>
            {/if}

            <SettingLayout variant="row" title={language.imageSettings.enableI2i} description={language.help.naiEnableI2I}>{#snippet control()}<Switch bind:checked={settings.NAII2I}/>{/snippet}</SettingLayout>

            {#if settings.NAII2I}
                <SettingLayout variant="row" title={language.imageSettings.i2iReferenceImage} description={language.imageSettings.useCharacterDefaultHint} stacked>
                <div class="relative">
                    <button class="mb-2" onclick={async () => {
                        const img = await selectSingleFile([
                            'jpg',
                            'jpeg',
                            'png',
                            'webp'
                        ])
                        if(!img){
                            return null
                        }
                        const saveId = await saveAsset(img.data)
                        settings.NAIImgConfig.image = saveId
                        delete settings.NAIImgConfig.base64image
                    }}>
                        {#if !settings.NAIImgConfig.image || settings.NAIImgConfig.image === ''}
                            <div class="rounded-md h-20 w-20 shadow-lg bg-subtext cursor-pointer risu-interactive-accent flex items-center justify-center">
                                <span class="text-sm">{language.imageSettings.uploadImage}</span>
                            </div>
                        {:else}
                            {#await getCharImage(settings.NAIImgConfig.image, 'plain')}
                                <div class="rounded-md h-20 w-20 shadow-lg bg-subtext cursor-pointer risu-interactive-accent flex items-center justify-center">
                                    <span class="text-sm">{language.imageSettings.uploadingImage}</span>
                                </div>
                            {:then im}
                                <img src={im} class="rounded-md h-40 shadow-lg bg-subtext cursor-pointer risu-interactive-accent" alt={language.imageSettings.imagePreview}/>
                            {/await}
                        {/if}
                    </button>

                    {#if settings.NAIImgConfig.image && settings.NAIImgConfig.image !== ''}
                        <Button
                            variant="destructive"
                            size="sm"
                            onclick={() => {
                                settings.NAIImgConfig.image = undefined;
                                delete settings.NAIImgConfig.base64image;
                            }}
                            className="absolute top-2 right-2"
                        >
                            {language.remove}
                        </Button>
                    {/if}
                </div>
                </SettingLayout>
                <SettingLayout variant="row" title={language.imageSettings.strength}>{#snippet control()}<div class="w-48"><Slider min={0} max={0.99} step={0.01} fixed={2} bind:value={settings.NAIImgConfig.strength}/></div>{/snippet}</SettingLayout>
                <SettingLayout variant="row" title={language.imageSettings.noise}>{#snippet control()}<div class="w-48"><Slider min={0} max={0.99} step={0.01} fixed={2} bind:value={settings.NAIImgConfig.noise}/></div>{/snippet}</SettingLayout>


            {/if}
        {/if}



        {#if settings.sdProvider === 'comfyui'}
            <SettingLayout variant="row" title={`ComfyUI ${language.providerURL}`} description={language.help.comfyUrl}>{#snippet control()}<Input commitMode="blur" className="w-48 text-sm" size="sm" placeholder="http://127.0.0.1:8188" bind:value={settings.comfyUiUrl}/>{/snippet}</SettingLayout>
            <SettingLayout variant="row" title={language.imageSettings.workflow} description={language.help.comfyWorkflow}>{#snippet control()}<Input commitMode="blur" className="w-48 text-sm" size="sm" bind:value={settings.comfyConfig.workflow}/>{/snippet}</SettingLayout>
            <SettingLayout variant="row" title={language.imageSettings.timeoutSeconds} description={language.help.comfyTimeout}>{#snippet control()}<NumberInput className="w-48 text-sm" size="sm" bind:value={settings.comfyConfig.timeout} min={1} max={120}/>{/snippet}</SettingLayout>
        {/if}

      </div>
    </SettingLayout>
</div>

{#if presetPickerOpen}
    <PresetPickerLayout
        title={language.imageGenerationPreset}
        folders={imagePresetTags}
        itemFolderIds={DBState.db.imageGenerationPresets.map(item => item.tagIds)}
        organizationKind="tag"
        itemNames={DBState.db.imageGenerationPresets.map(item => item.name)}
        itemDragDataKey="imageGenerationPresetIndex"
        bind:selectedFolder={selectedPresetFolder}
        bind:searchQuery={presetSearchQuery}
        bind:visibleItemIndexes={visiblePresetIndexes}
        bind:emptyMessage={presetEmptyMessage}
        close={() => presetPickerOpen = false}
        onFoldersChange={(tags) => DBState.db.imageGenerationPresetTags = tags}
        onAssignItem={(index, tagId) => {
            const preset = DBState.db.imageGenerationPresets[index];
            preset.tagIds = togglePresetTag(preset.tagIds, tagId);
            DBState.db.imageGenerationPresets = [...DBState.db.imageGenerationPresets];
        }}
        onDeleteFolder={(tagId) => DBState.db.imageGenerationPresets = DBState.db.imageGenerationPresets.map(item => ({
            ...item,
            tagIds: removePresetTag(item.tagIds, tagId),
        }))}
        selectedItemIndex={DBState.db.imageGenerationPresetId}
        onMoveItem={moveImagePreset}
        onSelectItem={selectImagePreset}
        onDuplicateItem={duplicateImagePreset}
        onDeleteItem={deleteImagePreset}
        itemRenameable
    >
        {#snippet itemContent(index, renameController)}
            <InlineEditableName
                controller={renameController}
                bind:value={DBState.db.imageGenerationPresets[index].name}
                size="default"
                editorLeadingInset="row"
                placeholder={language.imageGenerationPresetNew}
                onActivate={() => selectImagePreset(index)}
            />
        {/snippet}
        <PresetPickerActions
            onCreate={addImagePreset}
            onImport={importImagePreset}
        />
    </PresetPickerLayout>
{/if}
