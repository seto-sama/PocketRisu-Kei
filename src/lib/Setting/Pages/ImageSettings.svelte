<script lang="ts">
    import { language } from "src/lang";
    import SettingLayout from "src/lib/Setting/Wrappers/SettingLayout.svelte";
    import ApiKeyModeControl, { getInitialApiKeyInputMode, type ApiKeyInputMode } from "src/lib/Setting/ApiKeyModeControl.svelte";
    import ShSwitch from "src/lib/UI/GUI/ShSwitch.svelte";
    import ShButton from "src/lib/UI/GUI/ShButton.svelte";
    import NumberInput from "src/lib/UI/GUI/NumberInput.svelte";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import SelectInput from "src/lib/UI/GUI/SelectInput.svelte";
    import OptionInput from "src/lib/UI/GUI/OptionInput.svelte";
    import SliderInput from "src/lib/UI/GUI/SliderInput.svelte";
    import ShSlider from "src/lib/UI/GUI/ShSlider.svelte";
    import { DBState } from "src/ts/stores.svelte";
    import { listApiKeys } from "src/ts/preset/apiKeyPool";
    import { selectSingleFile } from "src/ts/util";
    import { getCharImage } from "src/ts/characters";
    import { saveAsset } from "src/ts/globalApi.svelte";
    import { alertError } from "src/ts/alert";
    import { ImageIcon, XIcon } from "@lucide/svelte";
    import SettingRenderer from "../SettingRenderer.svelte";
    import type { SettingItem } from "src/ts/setting/types";

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

    const imageNovelAIKeys = $derived.by(() => { DBState.db.apiKeyPool; return listApiKeys('novelai'); });
    const imageNovelAIKeyRef = $derived(validImageKeyRef(imageNovelAIKeys));
    let imageNovelAIKeyMode = $state<ApiKeyInputMode>(getInitialApiKeyInputMode(
        validImageKeyRef(listApiKeys('novelai')),
        DBState.db.NAIApiKey,
    ));

    function validImageKeyRef(keys: { id: string }[]): string {
        const ref = DBState.db.imageApiKeyRefs?.novelai ?? '';
        return keys.some((key) => key.id === ref) ? ref : '';
    }

    function selectImageKey(value: string) {
        DBState.db.imageApiKeyRefs = {
            ...(DBState.db.imageApiKeyRefs ?? {}),
            novelai: value || undefined,
        };
    }

    $effect(() => {
        if (DBState.db.imageApiKeyRefs?.novelai && !imageNovelAIKeyRef) {
            selectImageKey('');
            imageNovelAIKeyMode = 'direct';
        }
    });

    async function uploadVibeFile() {
        const file = await selectSingleFile(['naiv4vibe']);
        if (!file) return;

        try {
            const vibeData = JSON.parse(new TextDecoder().decode(file.data));
            if (vibeData.version !== 1 || vibeData.identifier !== 'novelai-vibe-transfer') {
                alertError(language.imageSettings.invalidVibeFile);
                return;
            }

            DBState.db.NAIImgConfig.vibe_data = vibeData;
            if (vibeData.thumbnail) {
                DBState.db.NAIImgConfig.reference_image_multiple = [];

                if (DBState.db.NAIImgModel.includes('nai-diffusion-4-full')) {
                    DBState.db.NAIImgConfig.vibe_model_selection = 'v4full';
                } else if (DBState.db.NAIImgModel.includes('nai-diffusion-4-curated')) {
                    DBState.db.NAIImgConfig.vibe_model_selection = 'v4curated';
                } else if (DBState.db.NAIImgModel.includes('nai-diffusion-4-5-full')) {
                    DBState.db.NAIImgConfig.vibe_model_selection = 'v4-5full';
                } else if (DBState.db.NAIImgModel.includes('nai-diffusion-4-5-curated')) {
                    DBState.db.NAIImgConfig.vibe_model_selection = 'v4-5curated';
                }

                const selectedModel = DBState.db.NAIImgConfig.vibe_model_selection;
                if (selectedModel && vibeData.encodings[selectedModel]) {
                    const encodings = vibeData.encodings[selectedModel];
                    const firstKey = Object.keys(encodings)[0];
                    if (firstKey) {
                        DBState.db.NAIImgConfig.InfoExtracted = Number(encodings[firstKey].params.information_extracted);
                    }
                }
            }

            DBState.db.NAIImgConfig.reference_strength_multiple ??= [0.7];
        } catch (error) {
            alertError(language.imageSettings.vibeParseError(error));
        }
    }

    async function uploadReferenceImage() {
        const image = await selectSingleFile(['jpg', 'jpeg', 'png', 'webp']);
        if (!image) return;

        DBState.db.NAIImgConfig.character_base64image = Buffer.from(image.data).toString('base64');
        DBState.db.NAIImgConfig.character_image = await saveAsset(image.data);
    }

</script>

<div class="flex flex-col w-full">
    <SettingLayout variant="section" title={language.emotionImage} first>
        <div class="[&>*:first-child]:border-t-0">
            <SettingLayout variant="row" title={language.emotionMethod} description={language.help.emotionMethod}>
                {#snippet control()}
                    <SelectInput className="w-48 text-sm" size="sm" bind:value={DBState.db.emotionProcesser}>
                        <OptionInput value="submodel">{language.submodel}</OptionInput>
                        <OptionInput value="embedding">MiniLM-L6-v2</OptionInput>
                    </SelectInput>
                {/snippet}
            </SettingLayout>
            <SettingRenderer items={emotionPromptItems} layout="row" />
        </div>
    </SettingLayout>

    <SettingLayout variant="section" title={language.imageGeneration}>
      <div class="[&>*:first-child]:border-t-0">
        <SettingLayout variant="row" title={`${language.imageGeneration} ${language.provider}`} description={language.help.sdProvider}>
          {#snippet control()}
          <SelectInput className="w-48 text-sm" size="sm" bind:value={DBState.db.sdProvider}>
            <OptionInput value="" >{language.none}</OptionInput>
            <OptionInput value="novelai" >Novel AI</OptionInput>
            <OptionInput value="comfyui" >ComfyUI</OptionInput>
          </SelectInput>
          {/snippet}
        </SettingLayout>

        {#if DBState.db.sdProvider === 'novelai'}
            <SettingLayout variant="row" title={`Novel AI ${language.providerURL}`} description={language.help.naiImgUrl}>{#snippet control()}<TextInput className="w-48 text-sm" size="sm" placeholder="https://image.novelai.net" bind:value={DBState.db.NAIImgUrl}/>{/snippet}</SettingLayout>
            <SettingLayout variant="row" title={language.novelAIApiKey} description={language.help.novelaiToken}>
                {#snippet control()}<ApiKeyModeControl bind:mode={imageNovelAIKeyMode} entries={imageNovelAIKeys} selectedId={imageNovelAIKeyRef} bind:directValue={DBState.db.NAIApiKey} onSelect={selectImageKey} placeholder="pst-..." />{/snippet}
            </SettingLayout>

            <SettingLayout variant="row" title={language.model} description={language.help.naiModel}>{#snippet control()}<SelectInput className="w-48 text-sm" size="sm" bind:value={DBState.db.NAIImgModel}>
                <OptionInput value="nai-diffusion-4-5-full" >nai-diffusion-4-5-full</OptionInput>
                <OptionInput value="nai-diffusion-4-5-curated" >nai-diffusion-4-5-curated</OptionInput>
                <OptionInput value="nai-diffusion-4-full" >nai-diffusion-4-full</OptionInput>
                <OptionInput value="nai-diffusion-4-curated-preview" >nai-diffusion-4-curated-preview</OptionInput>
                <OptionInput value="nai-diffusion-3" >nai-diffusion-3</OptionInput>
                <OptionInput value="nai-diffusion-furry-3" >nai-diffusion-furry-3</OptionInput>
                <OptionInput value="nai-diffusion-2" >nai-diffusion-2</OptionInput>

            </SelectInput>{/snippet}</SettingLayout>
            <SettingLayout variant="row" title={language.imageSettings.width} description={language.help.naiWidth}>{#snippet control()}<NumberInput className="w-48 text-sm" size="sm" min={0} max={2048} bind:value={DBState.db.NAIImgConfig.width}/>{/snippet}</SettingLayout>
            <SettingLayout variant="row" title={language.imageSettings.height} description={language.help.naiHeight}>{#snippet control()}<NumberInput className="w-48 text-sm" size="sm" min={0} max={2048} bind:value={DBState.db.NAIImgConfig.height}/>{/snippet}</SettingLayout>
            <SettingLayout variant="row" title={language.imageSettings.sampler} description={language.help.naiSampler}>{#snippet control()}{#if DBState.db.NAIImgModel === 'nai-diffusion-4-full'
            || DBState.db.NAIImgModel === 'nai-diffusion-4-curated-preview'
            || DBState.db.NAIImgModel === 'nai-diffusion-4-5-full'
            || DBState.db.NAIImgModel === 'nai-diffusion-4-5-curated'}
                <SelectInput className="w-48 text-sm" size="sm" bind:value={DBState.db.NAIImgConfig.sampler}>
                    <OptionInput value="k_euler_ancestral" >Euler Ancestral</OptionInput>
                    <OptionInput value="k_dpmpp_2s_ancestral" >DPM++ 2S Ancestral</OptionInput>
                    <OptionInput value="k_dpmpp_2m_sde" >DPM++ 2M SDE</OptionInput>
                    <OptionInput value="k_euler" >Euler</OptionInput>
                    <OptionInput value="k_dpmpp_2m" >DPM++ 2M</OptionInput>
                    <OptionInput value="k_dpmpp_sde" >DPM++ SDE</OptionInput>
                </SelectInput>
            {:else}
                <SelectInput className="w-48 text-sm" size="sm" bind:value={DBState.db.NAIImgConfig.sampler}>
                    <OptionInput value="k_euler_ancestral" >Euler Ancestral</OptionInput>
                    <OptionInput value="k_dpmpp_2s_ancestral" >DPM++ 2S Ancestral</OptionInput>
                    <OptionInput value="k_dpmpp_sde" >DPM++ SDE</OptionInput>
                    <OptionInput value="k_euler" >Euler</OptionInput>
                    <OptionInput value="k_dpmpp_2m" >DPM++ 2M</OptionInput>
                    <OptionInput value="k_dpmpp_2s" >DPM++ 2S</OptionInput>
                    <OptionInput value="ddim_v3" >DDIM</OptionInput>
                </SelectInput>
            {/if}{/snippet}</SettingLayout>

            <SettingLayout variant="row" title={language.imageSettings.noiseSchedule} description={language.help.naiNoiseSchedule}>{#snippet control()}<SelectInput className="w-48 text-sm" size="sm" bind:value={DBState.db.NAIImgConfig.noise_schedule}>
                <OptionInput value="native" >native</OptionInput>
                <OptionInput value="karras" >karras</OptionInput>
                <OptionInput value="exponential" >exponential</OptionInput>
                <OptionInput value="polyexponential" >polyexponential</OptionInput>
            </SelectInput>{/snippet}</SettingLayout>
            <SettingLayout variant="row" title={language.imageSettings.steps} description={language.help.naiSteps}>{#snippet control()}<NumberInput className="w-48 text-sm" size="sm" min={0} max={2048} bind:value={DBState.db.NAIImgConfig.steps}/>{/snippet}</SettingLayout>
            <SettingLayout variant="row" title={language.imageSettings.cfgScale} description={language.help.naiCFG}>{#snippet control()}<NumberInput className="w-48 text-sm" size="sm" min={0} max={2048} bind:value={DBState.db.NAIImgConfig.scale}/>{/snippet}</SettingLayout>
            <SettingLayout variant="row" title={language.imageSettings.cfgRescale} description={language.help.naiCFGRescale}>{#snippet control()}<NumberInput className="w-48 text-sm" size="sm" min={0} max={1} bind:value={DBState.db.NAIImgConfig.cfg_rescale}/>{/snippet}</SettingLayout>

            <SettingLayout variant="row" title={language.imageSettings.imageReference} description={language.help.naiImageReference}>{#snippet control()}<SelectInput className="w-48 text-sm" size="sm" bind:value={DBState.db.NAIImgConfig.reference_mode}>
                <OptionInput value="" >{language.none}</OptionInput>
                <OptionInput value="vibe" >{language.imageSettings.vibeTransfer}</OptionInput>
                {#if DBState.db.NAIImgModel === 'nai-diffusion-4-5-full' || DBState.db.NAIImgModel === 'nai-diffusion-4-5-curated'}
                    <OptionInput value="reference" >{language.imageSettings.characterReference}</OptionInput>
                {/if}
            </SelectInput>{/snippet}</SettingLayout>

            {#if DBState.db.NAIImgConfig.reference_mode === 'vibe'}
                <SettingLayout variant="row" title={language.imageSettings.vibeFile}>
                {#snippet control()}
                    <div class="flex items-center gap-2">
                        {#if DBState.db.NAIImgConfig.vibe_data?.thumbnail}
                            <img src={DBState.db.NAIImgConfig.vibe_data.thumbnail} alt={language.imageSettings.vibePreview} class="h-8 w-8 rounded object-cover border border-darkborderc" />
                        {/if}
                        <ShButton variant="outline" size="sm" onclick={uploadVibeFile}>
                            <ImageIcon />
                            {DBState.db.NAIImgConfig.vibe_data ? language.edit : language.select}
                        </ShButton>
                        {#if DBState.db.NAIImgConfig.vibe_data}
                            <ShButton
                                variant="destructive"
                                size="icon-sm"
                                onclick={() => {
                                    DBState.db.NAIImgConfig.vibe_data = undefined;
                                    DBState.db.NAIImgConfig.vibe_model_selection = undefined;
                                }}
                                aria-label={language.remove}
                            >
                                <XIcon />
                            </ShButton>
                        {/if}
                    </div>
                {/snippet}
                </SettingLayout>

                {#if DBState.db.NAIImgConfig.vibe_data}

                    <SettingLayout variant="row" title={language.imageSettings.vibeModel} description={language.help.naiVibeModel}>{#snippet control()}<SelectInput className="w-48 text-sm" size="sm" bind:value={DBState.db.NAIImgConfig.vibe_model_selection} onchange={(e) => {
                        // When vibe model changes, set InfoExtracted to the first value
                        if (DBState.db.NAIImgConfig.vibe_data?.encodings &&
                            DBState.db.NAIImgConfig.vibe_model_selection &&
                            DBState.db.NAIImgConfig.vibe_data.encodings[DBState.db.NAIImgConfig.vibe_model_selection]) {
                            const encodings = DBState.db.NAIImgConfig.vibe_data.encodings[DBState.db.NAIImgConfig.vibe_model_selection];
                            const firstKey = Object.keys(encodings)[0];
                            if (firstKey) {
                                DBState.db.NAIImgConfig.InfoExtracted = Number(encodings[firstKey].params.information_extracted);
                            }
                        }
                    }}>
                        {#if DBState.db.NAIImgConfig.vibe_data.encodings?.v4full}
                            <OptionInput value="v4full">nai-diffusion-4-full</OptionInput>
                        {/if}
                        {#if DBState.db.NAIImgConfig.vibe_data.encodings?.v4curated}
                            <OptionInput value="v4curated">nai-diffusion-4-curated</OptionInput>
                        {/if}
                        {#if DBState.db.NAIImgConfig.vibe_data.encodings?.['v4-5full']}
                            <OptionInput value="v4-5full">nai-diffusion-4-5-full</OptionInput>
                        {/if}
                        {#if DBState.db.NAIImgConfig.vibe_data.encodings?.['v4-5curated']}
                            <OptionInput value="v4-5curated">nai-diffusion-4-5-curated</OptionInput>
                        {/if}
                    </SelectInput>{/snippet}</SettingLayout>

                    <SettingLayout variant="row" title={language.imageSettings.informationExtracted} description={language.help.naiInfoExtracted}>{#snippet control()}<SelectInput className="w-48 text-sm" size="sm" bind:value={DBState.db.NAIImgConfig.InfoExtracted}>
                        {#if DBState.db.NAIImgConfig.vibe_model_selection && DBState.db.NAIImgConfig.vibe_data.encodings[DBState.db.NAIImgConfig.vibe_model_selection]}
                            {#each Object.entries(DBState.db.NAIImgConfig.vibe_data.encodings[DBState.db.NAIImgConfig.vibe_model_selection]) as [key, value]}
                                <OptionInput value={value.params.information_extracted}>{value.params.information_extracted}</OptionInput>
                            {/each}
                        {/if}
                    </SelectInput>{/snippet}</SettingLayout>

                    <SettingLayout variant="row" title={language.imageSettings.referenceStrength} description={language.help.naiRefStrength}>{#snippet control()}<div class="w-48"><SliderInput min={0} max={1} step={0.1} fixed={2} bind:value={DBState.db.NAIImgConfig.reference_strength_multiple[0]} /></div>{/snippet}</SettingLayout>
                {/if}
            {/if}

            {#if DBState.db.NAIImgConfig.reference_mode === 'reference' &&
                (DBState.db.NAIImgModel === 'nai-diffusion-4-5-full' || DBState.db.NAIImgModel === 'nai-diffusion-4-5-curated')}
                <SettingLayout variant="row" title={language.imageSettings.referenceType} description={language.help.naiReferenceType}>
                    {#snippet control()}
                        <SelectInput className="w-48 text-sm" size="sm" bind:value={DBState.db.NAIImgConfig.reference_type}>
                            <OptionInput value="character">{language.imageSettings.referenceCharacter}</OptionInput>
                            <OptionInput value="style">{language.imageSettings.referenceStyle}</OptionInput>
                            <OptionInput value="character&style">{language.imageSettings.referenceCharacterAndStyle}</OptionInput>
                        </SelectInput>
                    {/snippet}
                </SettingLayout>
                <SettingLayout variant="row" title={language.imageSettings.characterReferenceImage} description={language.imageSettings.useCharacterDefaultHint}>
                {#snippet control()}
                    <div class="flex items-center gap-2">
                        {#if DBState.db.NAIImgConfig.character_image}
                            {#await getCharImage(DBState.db.NAIImgConfig.character_image, 'plain')}
                                <div class="h-8 w-8 rounded border border-darkborderc bg-darkbutton animate-pulse"></div>
                            {:then image}
                                <img src={image} class="h-8 w-8 rounded object-cover border border-darkborderc" alt={language.imageSettings.imagePreview}/>
                            {/await}
                        {/if}
                        <ShButton variant="outline" size="sm" onclick={uploadReferenceImage}>
                            <ImageIcon />
                            {DBState.db.NAIImgConfig.character_image ? language.edit : language.select}
                        </ShButton>
                        {#if DBState.db.NAIImgConfig.character_image}
                            <ShButton
                                variant="destructive"
                                size="icon-sm"
                                onclick={() => {
                                    DBState.db.NAIImgConfig.character_image = '';
                                    DBState.db.NAIImgConfig.character_base64image = '';
                                }}
                                aria-label={language.remove}
                            >
                                <XIcon />
                            </ShButton>
                        {/if}
                    </div>
                {/snippet}
                </SettingLayout>
                <SettingLayout variant="row" title={language.imageSettings.preciseReferenceStrength} description={language.help.naiReferenceStrength}>
                    {#snippet control()}<div class="w-48"><ShSlider min={0} max={1} step={0.05} fixed={2} inputWidth="w-16" bind:value={DBState.db.NAIImgConfig.reference_strength} /></div>{/snippet}
                </SettingLayout>
                <SettingLayout variant="row" title={language.imageSettings.referenceFidelity} description={language.help.naiReferenceFidelity}>
                    {#snippet control()}<div class="w-48"><ShSlider min={0} max={1} step={0.05} fixed={2} inputWidth="w-16" bind:value={DBState.db.NAIImgConfig.reference_fidelity} /></div>{/snippet}
                </SettingLayout>

            {/if}




            {#if (DBState.db.NAIImgModel === 'nai-diffusion-3' || DBState.db.NAIImgModel === 'nai-diffusion-furry-3' || DBState.db.NAIImgModel === 'nai-diffusion-2')
            && DBState.db.NAIImgConfig.sampler !== 'ddim_v3'}
                <SettingLayout variant="row" title={language.imageSettings.useSmea} description={language.help.naiUseSMEA}>{#snippet control()}<ShSwitch bind:checked={DBState.db.NAIImgConfig.sm}/>{/snippet}</SettingLayout>
            {/if}

            {#if DBState.db.NAIImgModel === 'nai-diffusion-3' && DBState.db.NAIImgConfig.sampler !== 'ddim_v3'}
                <SettingLayout variant="row" title={language.imageSettings.useDyn} description={language.help.naiUseDYN}>{#snippet control()}<ShSwitch bind:checked={DBState.db.NAIImgConfig.sm_dyn}/>{/snippet}</SettingLayout>
            {/if}

            {#if DBState.db.NAIImgModel === 'nai-diffusion-4-5-full' || DBState.db.NAIImgModel === 'nai-diffusion-4-5-curated'
            || DBState.db.NAIImgModel === 'nai-diffusion-4-full' || DBState.db.NAIImgModel === 'nai-diffusion-4-curated-preview'
            || DBState.db.NAIImgModel === 'nai-diffusion-3' || DBState.db.NAIImgModel === 'nai-diffusion-furry-3'}
                <SettingLayout variant="row" title={language.imageSettings.varietyPlus} description={language.help.naiVarietyPlus}>{#snippet control()}<ShSwitch bind:checked={DBState.db.NAIImgConfig.variety_plus}/>{/snippet}</SettingLayout>
            {/if}

            {#if DBState.db.NAIImgModel === 'nai-diffusion-3' || DBState.db.NAIImgModel === 'nai-diffusion-furry-3' || DBState.db.NAIImgModel === 'nai-diffusion-2'}
                <SettingLayout variant="row" title={language.imageSettings.decrisp} description={language.help.naiDecrisp}>{#snippet control()}<ShSwitch bind:checked={DBState.db.NAIImgConfig.decrisp}/>{/snippet}</SettingLayout>
            {/if}

            {#if DBState.db.NAIImgModel === 'nai-diffusion-4-full'
            || DBState.db.NAIImgModel === 'nai-diffusion-4-curated-preview'}
                <SettingLayout variant="row" title={language.imageSettings.useLegacyUc} description={language.help.naiLegacyUC}>{#snippet control()}<ShSwitch bind:checked={DBState.db.NAIImgConfig.legacy_uc}/>{/snippet}</SettingLayout>
            {/if}

            <SettingLayout variant="row" title={language.imageSettings.enableI2i} description={language.help.naiEnableI2I}>{#snippet control()}<ShSwitch bind:checked={DBState.db.NAII2I}/>{/snippet}</SettingLayout>

            {#if DBState.db.NAII2I}
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
                        DBState.db.NAIImgConfig.base64image = Buffer.from(img.data).toString('base64');
                        const saveId = await saveAsset(img.data)
                        DBState.db.NAIImgConfig.image = saveId
                    }}>
                        {#if !DBState.db.NAIImgConfig.image || DBState.db.NAIImgConfig.image === ''}
                            <div class="rounded-md h-20 w-20 shadow-lg bg-textcolor2 cursor-pointer hover:text-primary flex items-center justify-center">
                                <span class="text-sm">{language.imageSettings.uploadImage}</span>
                            </div>
                        {:else}
                            {#await getCharImage(DBState.db.NAIImgConfig.image, 'plain')}
                                <div class="rounded-md h-20 w-20 shadow-lg bg-textcolor2 cursor-pointer hover:text-primary flex items-center justify-center">
                                    <span class="text-sm">{language.imageSettings.uploadingImage}</span>
                                </div>
                            {:then im}
                                <img src={im} class="rounded-md h-40 shadow-lg bg-textcolor2 cursor-pointer hover:text-primary" alt={language.imageSettings.imagePreview}/>
                            {/await}
                        {/if}
                    </button>

                    {#if DBState.db.NAIImgConfig.image && DBState.db.NAIImgConfig.image !== ''}
                        <ShButton
                            variant="destructive"
                            size="sm"
                            onclick={() => {
                                DBState.db.NAIImgConfig.image = undefined;
                                DBState.db.NAIImgConfig.base64image = undefined;
                            }}
                            className="absolute top-2 right-2"
                        >
                            {language.remove}
                        </ShButton>
                    {/if}
                </div>
                </SettingLayout>
                <SettingLayout variant="row" title={language.imageSettings.strength}>{#snippet control()}<div class="w-48"><SliderInput min={0} max={0.99} step={0.01} fixed={2} bind:value={DBState.db.NAIImgConfig.strength}/></div>{/snippet}</SettingLayout>
                <SettingLayout variant="row" title={language.imageSettings.noise}>{#snippet control()}<div class="w-48"><SliderInput min={0} max={0.99} step={0.01} fixed={2} bind:value={DBState.db.NAIImgConfig.noise}/></div>{/snippet}</SettingLayout>


            {/if}
        {/if}



        {#if DBState.db.sdProvider === 'comfyui'}
            <SettingLayout variant="row" title={`ComfyUI ${language.providerURL}`} description={language.help.comfyUrl}>{#snippet control()}<TextInput className="w-48 text-sm" size="sm" placeholder="http://127.0.0.1:8188" bind:value={DBState.db.comfyUiUrl}/>{/snippet}</SettingLayout>
            <SettingLayout variant="row" title={language.imageSettings.workflow} description={language.help.comfyWorkflow}>{#snippet control()}<TextInput className="w-48 text-sm" size="sm" bind:value={DBState.db.comfyConfig.workflow}/>{/snippet}</SettingLayout>
            <SettingLayout variant="row" title={language.imageSettings.timeoutSeconds} description={language.help.comfyTimeout}>{#snippet control()}<NumberInput className="w-48 text-sm" size="sm" bind:value={DBState.db.comfyConfig.timeout} min={1} max={120}/>{/snippet}</SettingLayout>
        {/if}

      </div>
    </SettingLayout>
</div>
