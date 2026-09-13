<script lang="ts">
    import { untrack } from "svelte";
    import { language } from "src/lang";
    import { DBState } from "src/ts/stores.svelte";
    import { getApiKey, listApiKeys } from "src/ts/preset/apiKeyPool";
    import { getElevenTTSVoices, getVOICEVOXVoices, getWebSpeechTTSVoices } from "src/ts/process/tts";
    import { alertConfirm, notifyError, notifySuccess } from "src/ts/alert";
    import {
        appendTTSPreset, createTTSPreset, duplicateTTSPreset, moveTTSPreset, removeTTSPreset,
    } from "src/ts/tts/presets";
    import ApiKeyModeControl, { getInitialApiKeyInputMode, type ApiKeyInputMode } from "../ApiKeyModeControl.svelte";
    import SettingLayout from "../Wrappers/SettingLayout.svelte";
    import Switch from "../../UI/components/Switch.svelte";
    import Input from "../../UI/components/Input.svelte";
    import NumberInput from "../../UI/components/NumberInput.svelte";
    import Textarea from "../../UI/components/Textarea.svelte";
    import Slider from "../../UI/components/Slider.svelte";
    import Select from "../../UI/components/Select.svelte";
    import SelectOption from "../../UI/components/SelectOption.svelte";
    import PresetHeader from "../../UI/components/PresetHeader.svelte";
    import PresetPickerLayout from "../../UI/PresetPickerLayout.svelte";
    import PresetPickerActions from "../../UI/PresetPickerActions.svelte";
    import InlineEditableName from "../../UI/components/InlineEditableName.svelte";

    let presetPickerOpen = $state(false);
    let visiblePresetIndexes = $state<number[]>([]);
    let elevenLabsKeyMode = $state<ApiKeyInputMode>('direct');
    let fishAudioKeyMode = $state<ApiKeyInputMode>('direct');
    const ttsPresets = $derived(DBState.db.ttsPresets ?? []);
    const ttsPreset = $derived(ttsPresets[DBState.db.ttsPresetId]);
    const settings = $derived(ttsPreset.settings);
    const allKeys = $derived.by(() => { DBState.db.apiKeyPool; return listApiKeys(); });
    const elevenLabsKeyRef = $derived(validKeyRef('elevenlabs'));
    const fishAudioKeyRef = $derived(validKeyRef('fishspeech'));
    const elevenLabsApiKey = $derived(resolveKey('elevenlabs'));
    const fishAudioApiKey = $derived(resolveKey('fishspeech'));
    const voicevoxStyles = $derived(parseVoicevoxStyles(settings.voicevox.speaker));

    let gptSoVitsLanguageOptions = $derived([
        ['auto', language.ttsLanguageMultiMixed], ['auto_yue', language.ttsLanguageMultiMixedCantonese],
        ['en', language.ttsLanguageEnglish], ['zh', language.ttsLanguageChineseEnglishMixed],
        ['ja', language.ttsLanguageJapaneseEnglishMixed], ['yue', language.ttsLanguageCantoneseEnglishMixed],
        ['ko', language.ttsLanguageKoreanEnglishMixed], ['all_zh', language.ttsLanguageChinese],
        ['all_ja', language.ttsLanguageJapanese], ['all_yue', language.ttsLanguageCantonese],
        ['all_ko', language.ttsLanguageKorean],
    ] as const);
    let gptSoVitsTextSplitOptions = $derived([
        ['cut0', `Cut 0 (${language.ttsSplitNone})`], ['cut1', `Cut 1 (${language.ttsSplitFourSentences})`],
        ['cut2', `Cut 2 (${language.ttsSplitFiftyCharacters})`], ['cut3', `Cut 3 (${language.ttsSplitChinesePeriods})`],
        ['cut4', `Cut 4 (${language.ttsSplitEnglishPeriods})`], ['cut5', `Cut 5 (${language.ttsSplitPunctuation})`],
    ] as const);

    function validKeyRef(provider: 'elevenlabs' | 'fishspeech') {
        const ref = settings.apiKeyRefs[provider] ?? '';
        return allKeys.some(key => key.id === ref) ? ref : '';
    }

    function parseVoicevoxStyles(value: string) {
        try {
            const styles = JSON.parse(value || '[]');
            return Array.isArray(styles)
                ? styles.filter(style => typeof style?.name === 'string' && Number.isFinite(Number(style?.id)))
                    .map(style => ({ name: style.name as string, id: String(style.id) }))
                : [];
        } catch {
            return [];
        }
    }

    function resolveKey(provider: 'elevenlabs' | 'fishspeech') {
        const direct = provider === 'elevenlabs' ? settings.elevenLabsKey : settings.fishAudioKey;
        return (getApiKey(settings.apiKeyRefs[provider])?.key ?? direct).trim();
    }

    function selectTTSKey(provider: 'elevenlabs' | 'fishspeech', value: string) {
        settings.apiKeyRefs = { ...settings.apiKeyRefs, [provider]: value || undefined };
    }

    $effect(() => {
        ttsPreset.id;
        const elevenRef = elevenLabsKeyRef;
        const fishRef = fishAudioKeyRef;
        untrack(() => {
            elevenLabsKeyMode = getInitialApiKeyInputMode(elevenRef, settings.elevenLabsKey);
            fishAudioKeyMode = getInitialApiKeyInputMode(fishRef, settings.fishAudioKey);
        });
    });

    function selectTTSPreset(index: number) {
        if (!ttsPresets[index]) return;
        DBState.db.ttsPresetId = index;
        presetPickerOpen = false;
    }

    function addTTSPreset() {
        appendTTSPreset(DBState.db, createTTSPreset(language.ttsPresetNew, settings));
    }

    function duplicatePreset(index: number) {
        if (duplicateTTSPreset(DBState.db, index, language.copy)) notifySuccess(language.presetDuplicated);
    }

    async function deletePreset(index: number) {
        if (ttsPresets.length <= 1) return notifyError(language.errors.onlyOnePreset);
        const preset = ttsPresets[index];
        if (!preset || !await alertConfirm(`${language.removeConfirm}${preset.name}`)) return;
        removeTTSPreset(DBState.db, index);
    }

    async function loadFishAudioModels(apiKey: string) {
        if (!apiKey) return [];
        const response = await fetch('https://api.fish.audio/model?self=true&page_size=100', {
            headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (!response.ok) throw new Error(language.ttsRequestFailed(language.ttsFishModelsTarget, response.status));
        const data = await response.json();
        if (!Array.isArray(data.items)) throw new Error(language.ttsInvalidResponse(language.ttsFishModelsTarget));
        return data.items.map(item => ({
            _id: item._id || '', title: item.title || '', description: item.description || '',
        }));
    }
</script>

<div class="flex flex-col w-full">
    <SettingLayout variant="section" title="TTS" first>
        <div class="[&>*:first-child]:border-t-0">
            <SettingLayout variant="row" title={language.ttsEnable} description={language.help.ttsEnable}>
                {#snippet control()}<Switch bind:checked={DBState.db.ttsEnabled}/>{/snippet}
            </SettingLayout>
            {#if DBState.db.ttsEnabled}
                <SettingLayout variant="row" title={language.ttsAutoSpeech} description={language.help.ttsAutoSpeech}>
                    {#snippet control()}<Switch bind:checked={DBState.db.ttsAutoSpeech}/>{/snippet}
                </SettingLayout>
                <SettingLayout variant="row" title={language.ttsReadOnlyQuoted} description={language.help.ttsReadOnlyQuoted}>
                    {#snippet control()}<Switch bind:checked={DBState.db.ttsReadOnlyQuoted}/>{/snippet}
                </SettingLayout>
            {/if}
        </div>
    </SettingLayout>

    {#if DBState.db.ttsEnabled}
        <SettingLayout variant="section" title={language.ttsSettings}>
            <div class="[&>*:first-child]:border-t-0">
                <SettingLayout variant="row" title={language.ttsPreset}>
                    {#snippet control()}<PresetHeader compact label={language.ttsPreset} activeName={ttsPreset.name} onManage={() => presetPickerOpen = true}/>{/snippet}
                </SettingLayout>
                <SettingLayout variant="row" title={language.ttsProvider}>
                    {#snippet control()}
                        <Select className="w-48 text-sm" size="sm" bind:value={settings.provider} onchange={() => { settings.voice = ''; settings.voicevox.speaker = ''; }}>
                            <SelectOption value="fishspeech">Fish Audio</SelectOption>
                            <SelectOption value="elevenlab">ElevenLabs</SelectOption>
                            <SelectOption value="gptsovits">GPT-SoVITS</SelectOption>
                            <SelectOption value="VOICEVOX">VOICEVOX</SelectOption>
                            <SelectOption value="webspeech">Web Speech</SelectOption>
                        </Select>
                    {/snippet}
                </SettingLayout>

                {#if settings.provider === 'fishspeech'}
                    <SettingLayout variant="row" title={language.ttsFishSpeechApiKey} description={language.help.ttsFishSpeechKey}>
                        {#snippet control()}<ApiKeyModeControl bind:mode={fishAudioKeyMode} entries={allKeys} selectedId={fishAudioKeyRef} bind:directValue={settings.fishAudioKey} onSelect={(id) => selectTTSKey('fishspeech', id)} showProvider/>{/snippet}
                    </SettingLayout>
                    {#if fishAudioApiKey}
                        <SettingLayout variant="row" title={language.ttsSynthesisModel}>
                            {#snippet control()}<Select className="w-48 text-sm" size="sm" bind:value={settings.fishAudio.engine}><SelectOption value="s2.1-pro">S2.1 Pro</SelectOption><SelectOption value="s2.1-pro-free">S2.1 Pro Free</SelectOption></Select>{/snippet}
                        </SettingLayout>
                        <SettingLayout variant="row" title={language.ttsVoiceModel}>
                            {#snippet control()}
                                <Select className="w-48 text-sm" size="sm" bind:value={settings.fishAudio.model._id}>
                                    {#await loadFishAudioModels(fishAudioApiKey)}<SelectOption value="">{language.loading}</SelectOption>
                                    {:then models}<SelectOption value="">{language.ttsNotSelected}</SelectOption>{#each models as model}<SelectOption value={model._id}>{model.title}</SelectOption>{/each}
                                    {:catch}<SelectOption value="">{language.ttsFishModelsLoadError}</SelectOption>{/await}
                                </Select>
                            {/snippet}
                        </SettingLayout>
                        <SettingLayout variant="row" title={language.ttsChunkLength}>{#snippet control()}<NumberInput className="w-48 text-sm" size="sm" bind:value={settings.fishAudio.chunkLength}/>{/snippet}</SettingLayout>
                        <SettingLayout variant="row" title={language.ttsNormalize}>{#snippet control()}<Switch bind:checked={settings.fishAudio.normalize}/>{/snippet}</SettingLayout>
                    {/if}
                {:else if settings.provider === 'elevenlab'}
                    <SettingLayout variant="row" title={language.ttsElevenLabsApiKey} description={language.help.ttsElevenLabsKey}>
                        {#snippet control()}<ApiKeyModeControl bind:mode={elevenLabsKeyMode} entries={allKeys} selectedId={elevenLabsKeyRef} bind:directValue={settings.elevenLabsKey} onSelect={(id) => selectTTSKey('elevenlabs', id)} showProvider/>{/snippet}
                    </SettingLayout>
                    {#if elevenLabsApiKey}
                        <SettingLayout variant="row" title={language.Speech}>
                            {#snippet control()}<Select className="w-48 text-sm" size="sm" bind:value={settings.voice}>{#await getElevenTTSVoices(elevenLabsApiKey)}<SelectOption value="">{language.loading}</SelectOption>{:then voices}<SelectOption value="">{language.ttsVoiceUnset}</SelectOption>{#each voices as voice}<SelectOption value={voice.voice_id}>{voice.name}</SelectOption>{/each}{:catch}<SelectOption value="">{language.ttsElevenLabsVoicesLoadError}</SelectOption>{/await}</Select>{/snippet}
                        </SettingLayout>
                    {/if}
                {:else if settings.provider === 'VOICEVOX'}
                    <SettingLayout variant="row" title={language.ttsVoicevoxUrl} description={language.help.ttsVoicevoxUrl}>
                        {#snippet control()}<Input commitMode="blur" className="w-48 text-sm" size="sm" bind:value={settings.voicevoxUrl}/>{/snippet}
                    </SettingLayout>
                    {#if settings.voicevoxUrl.trim()}
                        <SettingLayout variant="row" title={language.ttsSpeaker}>
                            {#snippet control()}<Select className="w-48 text-sm" size="sm" bind:value={settings.voicevox.speaker}>{#await getVOICEVOXVoices(settings.voicevoxUrl) then voices}{#each voices as voice}<SelectOption value={voice.list}>{voice.name}</SelectOption>{/each}{:catch}<SelectOption value="">{language.ttsVoicevoxLoadError}</SelectOption>{/await}</Select>{/snippet}
                        </SettingLayout>
                        <SettingLayout variant="row" title={language.ttsStyle}>
                            {#snippet control()}<Select className="w-48 text-sm" size="sm" bind:value={settings.voice}><SelectOption value="">{language.ttsNotSelected}</SelectOption>{#each voicevoxStyles as style}<SelectOption value={style.id}>{style.name}</SelectOption>{/each}</Select>{/snippet}
                        </SettingLayout>
                        <SettingLayout variant="row" title={language.ttsSpeedScale}>{#snippet control()}<NumberInput className="w-48 text-sm" size="sm" bind:value={settings.voicevox.speedScale}/>{/snippet}</SettingLayout>
                        <SettingLayout variant="row" title={language.ttsPitchScale}>{#snippet control()}<NumberInput className="w-48 text-sm" size="sm" bind:value={settings.voicevox.pitchScale}/>{/snippet}</SettingLayout>
                        <SettingLayout variant="row" title={language.ttsVolumeScale}>{#snippet control()}<NumberInput className="w-48 text-sm" size="sm" bind:value={settings.voicevox.volumeScale}/>{/snippet}</SettingLayout>
                        <SettingLayout variant="row" title={language.ttsIntonationScale}>{#snippet control()}<NumberInput className="w-48 text-sm" size="sm" bind:value={settings.voicevox.intonationScale}/>{/snippet}</SettingLayout>
                    {/if}
                {:else if settings.provider === 'gptsovits'}
                    <SettingLayout variant="row" title={language.ttsGptSoVitsServerUrl} description={language.ttsGptSoVitsServerUrlDescription}>{#snippet control()}<Input commitMode="blur" className="w-48 text-sm" size="sm" autocomplete="off" bind:value={settings.gptSoVits.url}/>{/snippet}</SettingLayout>
                    <SettingLayout variant="row" title={language.ttsUseReferenceAudio}>{#snippet control()}<Switch bind:checked={settings.gptSoVits.useReferenceAudio}/>{/snippet}</SettingLayout>
                    {#if settings.gptSoVits.useReferenceAudio}
                        <SettingLayout variant="row" title={language.ttsReferenceAudioPath} description={language.ttsGptSoVitsReferenceAudioPathDescription}>{#snippet control()}<Input commitMode="blur" className="w-48 text-sm" size="sm" autocomplete="off" bind:value={settings.gptSoVits.referenceAudioPath}/>{/snippet}</SettingLayout>
                        <SettingLayout variant="row" title={language.ttsReferenceAudioScript} stacked><Textarea height="20" bind:value={settings.gptSoVits.referenceAudioScript}/></SettingLayout>
                        <SettingLayout variant="row" title={language.ttsReferenceAudioLanguage}>{#snippet control()}<Select className="w-48 text-sm" size="sm" bind:value={settings.gptSoVits.referenceAudioLanguage}>{#each gptSoVitsLanguageOptions as [value, label]}<SelectOption {value}>{label}</SelectOption>{/each}</Select>{/snippet}</SettingLayout>
                    {/if}
                    <SettingLayout variant="row" title={language.ttsTextLanguage}>{#snippet control()}<Select className="w-48 text-sm" size="sm" bind:value={settings.gptSoVits.textLanguage}>{#each gptSoVitsLanguageOptions as [value, label]}<SelectOption {value}>{label}</SelectOption>{/each}</Select>{/snippet}</SettingLayout>
                    <SettingLayout variant="row" title={language.ttsTextSplitMethod}>{#snippet control()}<Select className="w-48 text-sm" size="sm" bind:value={settings.gptSoVits.textSplitMethod}>{#each gptSoVitsTextSplitOptions as [value, label]}<SelectOption {value}>{label}</SelectOption>{/each}</Select>{/snippet}</SettingLayout>
                    <SettingLayout variant="row" title={language.ttsTemperature}>{#snippet control()}<div class="w-48"><Slider min={0} max={1} step={0.05} fixed={2} inputWidth="w-16" bind:value={settings.gptSoVits.temperature}/></div>{/snippet}</SettingLayout>
                    <SettingLayout variant="row" title={language.ttsSpeed}>{#snippet control()}<div class="w-48"><Slider min={0.6} max={1.65} step={0.05} fixed={2} inputWidth="w-16" bind:value={settings.gptSoVits.speed}/></div>{/snippet}</SettingLayout>
                    <SettingLayout variant="row" title={language.ttsTopK}>{#snippet control()}<div class="w-48"><Slider min={1} max={100} step={1} inputWidth="w-16" bind:value={settings.gptSoVits.topK}/></div>{/snippet}</SettingLayout>
                    <SettingLayout variant="row" title={language.ttsTopP}>{#snippet control()}<div class="w-48"><Slider min={0} max={1} step={0.05} fixed={2} inputWidth="w-16" bind:value={settings.gptSoVits.topP}/></div>{/snippet}</SettingLayout>
                {:else if settings.provider === 'webspeech'}
                    <SettingLayout variant="row" title={language.Speech}>{#snippet control()}<Select className="w-48 text-sm" size="sm" bind:value={settings.voice}><SelectOption value="">{language.ttsVoiceAuto}</SelectOption>{#each getWebSpeechTTSVoices() as voice}<SelectOption value={voice}>{voice}</SelectOption>{/each}</Select>{/snippet}</SettingLayout>
                {/if}
            </div>
        </SettingLayout>
    {/if}
</div>

{#if presetPickerOpen}
    <PresetPickerLayout title={language.ttsPreset} folders={[]} itemFolderIds={ttsPresets.map(() => undefined)}
        itemNames={ttsPresets.map(preset => preset.name)} itemDragDataKey="ttsPresetIndex"
        showCreateFolder={false} showUncategorized={false} bind:visibleItemIndexes={visiblePresetIndexes}
        bind:open={presetPickerOpen} onFoldersChange={() => {}} onAssignItem={() => {}} onDeleteFolder={() => {}}
        selectedItemIndex={DBState.db.ttsPresetId} onMoveItem={(fromIndex, toIndex) => moveTTSPreset(DBState.db, fromIndex, toIndex)}
        onSelectItem={selectTTSPreset} onDuplicateItem={duplicatePreset} onDeleteItem={deletePreset} itemRenameable>
        {#snippet itemContent(index, renameController)}
            <InlineEditableName controller={renameController} bind:value={DBState.db.ttsPresets[index].name}
                size="default" editorLeadingInset="row" placeholder={language.ttsPresetNew} onActivate={() => selectTTSPreset(index)}/>
        {/snippet}
        <PresetPickerActions onCreate={addTTSPreset}/>
    </PresetPickerLayout>
{/if}
