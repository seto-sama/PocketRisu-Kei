<script lang="ts">
    import { Buffer } from "buffer";
    import { language } from "src/lang";
    import Help from "src/lib/Others/Help.svelte";
    import Accordion from "src/lib/UI/Accordion.svelte";
    import PresetPickerActions from "src/lib/UI/PresetPickerActions.svelte";
    import PresetPickerLayout from "src/lib/UI/PresetPickerLayout.svelte";
    import SettingLayout from "src/lib/Setting/Wrappers/SettingLayout.svelte";
    import ApiKeyModeControl, { getInitialApiKeyInputMode, type ApiKeyInputMode } from "src/lib/Setting/ApiKeyModeControl.svelte";
    import PresetHeader from "src/lib/UI/GUI/PresetHeader.svelte";
    import ShSlider from "src/lib/UI/GUI/ShSlider.svelte";
    import ShSwitch from "src/lib/UI/GUI/ShSwitch.svelte";
    import SelectInput from "src/lib/UI/GUI/SelectInput.svelte";
    import OptionInput from "src/lib/UI/GUI/OptionInput.svelte";
    import TextAreaInput from "src/lib/UI/GUI/TextAreaInput.svelte";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import { alertConfirm, alertError, notifyError, notifySuccess } from "src/ts/alert";
    import { downloadFile } from "src/ts/globalApi.svelte";
    import { listApiKeys } from "src/ts/preset/apiKeyPool";
    import { createHypaV3Preset } from "src/ts/process/memory/hypav3";
    import { DBState } from "src/ts/stores.svelte";
    import { selectSingleFile } from "src/ts/util";

    let { maxMemoryRatio }: { maxMemoryRatio: Promise<number> } = $props();

    let pickerOpen = $state(false);
    let editMode = $state(false);
    let selectedFolder = $state("all");
    let searchQuery = $state("");
    let visibleItemIndexes = $state<number[]>([]);
    let emptyMessage = $state("");
    const initialOpenAIKeyRef = listApiKeys("openai").find(entry => entry.key === DBState.db.supaMemoryKey)?.id ?? "";
    const initialVoyageKeyRef = listApiKeys("voyage").find(entry => entry.key === DBState.db.voyageApiKey)?.id ?? "";
    const initialCustomKeyRef = listApiKeys().find(entry => entry.key === DBState.db.hypaCustomSettings.key)?.id ?? "";
    let openAIKeyRef = $state(initialOpenAIKeyRef);
    let voyageKeyRef = $state(initialVoyageKeyRef);
    let customKeyRef = $state(initialCustomKeyRef);
    let openAIKeyMode = $state<ApiKeyInputMode>(getInitialApiKeyInputMode(initialOpenAIKeyRef, DBState.db.supaMemoryKey));
    let voyageKeyMode = $state<ApiKeyInputMode>(getInitialApiKeyInputMode(initialVoyageKeyRef, DBState.db.voyageApiKey));
    let customKeyMode = $state<ApiKeyInputMode>(getInitialApiKeyInputMode(initialCustomKeyRef, DBState.db.hypaCustomSettings.key));

    const folders = $derived(DBState.db.hypaV3PresetFolders ?? []);
    const preset = $derived(DBState.db.hypaV3Presets?.[DBState.db.hypaV3PresetId]);
    const settings = $derived(preset?.settings);
    const openAIKeys = $derived(listApiKeys("openai"));
    const voyageKeys = $derived(listApiKeys("voyage"));
    const allKeys = $derived(listApiKeys());
    const help = (key: string) => (language.help as Record<string, string>)[key] ?? "";
    const embeddingProvider = $derived.by(() => {
        if (["openai3small", "openai3large", "ada"].includes(DBState.db.hypaModel)) return "openai";
        if (["voyage4large", "voyageContext3", "voyageContext4"].includes(DBState.db.hypaModel)) return "voyage";
        if (DBState.db.hypaModel === "custom") return "custom";
        return "local";
    });

    function selectEmbeddingProvider(provider: string) {
        if (provider === "openai") DBState.db.hypaModel = "openai3small";
        else if (provider === "voyage") DBState.db.hypaModel = "voyage4large";
        else if (provider === "custom") DBState.db.hypaModel = "custom";
        else DBState.db.hypaModel = "MiniLM";
    }

    $effect(() => {
        for (const [ref, target] of [[openAIKeyRef, "openai"], [voyageKeyRef, "voyage"], [customKeyRef, "custom"]] as const) {
            if (!ref) continue;
            const entry = allKeys.find(key => key.id === ref);
            if (!entry) {
                if (target === "openai") {
                    openAIKeyRef = "";
                    openAIKeyMode = "direct";
                } else if (target === "voyage") {
                    voyageKeyRef = "";
                    voyageKeyMode = "direct";
                } else {
                    customKeyRef = "";
                    customKeyMode = "direct";
                }
                continue;
            }
            if (target === "openai") DBState.db.supaMemoryKey = entry.key;
            else if (target === "voyage") DBState.db.voyageApiKey = entry.key;
            else DBState.db.hypaCustomSettings.key = entry.key;
        }
    });

    function movePreset(fromIndex: number, toIndex: number) {
        const presets = DBState.db.hypaV3Presets;
        if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= presets.length || toIndex > presets.length) return;
        const next = [...presets];
        const [moved] = next.splice(fromIndex, 1);
        if (!moved) return;
        const adjustedToIndex = fromIndex < toIndex ? toIndex - 1 : toIndex;
        next.splice(adjustedToIndex, 0, moved);
        const current = DBState.db.hypaV3PresetId;
        if (current === fromIndex) DBState.db.hypaV3PresetId = adjustedToIndex;
        else if (fromIndex < current && adjustedToIndex >= current) DBState.db.hypaV3PresetId = current - 1;
        else if (fromIndex > current && adjustedToIndex <= current) DBState.db.hypaV3PresetId = current + 1;
        DBState.db.hypaV3Presets = next;
    }

    function selectPreset(index: number) {
        DBState.db.hypaV3PresetId = index;
        pickerOpen = false;
    }

    function addPreset() {
        const next = createHypaV3Preset();
        next.folderId = selectedFolder !== "all" && selectedFolder !== "uncategorized" ? selectedFolder : undefined;
        DBState.db.hypaV3Presets = [...DBState.db.hypaV3Presets, next];
        DBState.db.hypaV3PresetId = DBState.db.hypaV3Presets.length - 1;
    }

    function duplicatePreset(index: number) {
        const next = safeStructuredClone(DBState.db.hypaV3Presets[index]);
        next.name = `${next.name} Copy`;
        DBState.db.hypaV3Presets = [...DBState.db.hypaV3Presets, next];
        DBState.db.hypaV3PresetId = DBState.db.hypaV3Presets.length - 1;
        notifySuccess(language.presetDuplicated);
    }

    async function removePreset(index: number) {
        if (DBState.db.hypaV3Presets.length <= 1) return notifyError(language.hypaV3Settings.presetRequiredError);
        const target = DBState.db.hypaV3Presets[index];
        if (!await alertConfirm(`${language.removeConfirm}${target.name}`)) return;
        DBState.db.hypaV3Presets = DBState.db.hypaV3Presets.filter((_, i) => i !== index);
        DBState.db.hypaV3PresetId = Math.min(DBState.db.hypaV3PresetId, DBState.db.hypaV3Presets.length - 1);
    }

    async function exportPreset(index: number) {
        try {
            const target = DBState.db.hypaV3Presets[index];
            await downloadFile(`hypaV3_export_${target.name}.json`, Buffer.from(JSON.stringify({ type: "risu", ver: 1, data: target }), "utf-8"));
            notifySuccess(language.successExport);
        } catch (error) { alertError(`${error}`); }
    }

    async function importPreset() {
        try {
            const file = await selectSingleFile(["json"]);
            if (!file?.data) return;
            const obj = JSON.parse(Buffer.from(file.data).toString("utf-8"));
            if (obj.type !== "risu" || !obj.data) throw new Error(language.hypaV3Settings.invalidPresetError);
            const next = createHypaV3Preset(obj.data.name || "Imported Preset", obj.data.settings || {});
            next.folderId = selectedFolder !== "all" && selectedFolder !== "uncategorized" ? selectedFolder : obj.data.folderId;
            DBState.db.hypaV3Presets = [...DBState.db.hypaV3Presets, next];
            DBState.db.hypaV3PresetId = DBState.db.hypaV3Presets.length - 1;
            notifySuccess(language.successImport);
        } catch (error) { alertError(`${error}`); }
    }

    function useKey(id: string, target: "openai" | "custom" | "voyage") {
        if (target === "openai") openAIKeyRef = id;
        else if (target === "voyage") voyageKeyRef = id;
        else customKeyRef = id;
        if (!id) return;
        const key = allKeys.find(entry => entry.id === id)?.key;
        if (!key) return;
        if (target === "openai") DBState.db.supaMemoryKey = key;
        else if (target === "voyage") DBState.db.voyageApiKey = key;
        else DBState.db.hypaCustomSettings.key = key;
    }
</script>

<div class="flex flex-col w-full">
    <SettingLayout variant="section" title={language.HypaMemory} first>
        <div class="[&>*:first-child]:border-t-0">
        <SettingLayout variant="row" title={`${language.HypaMemory} V3`} description={language.help.hypaV3Description}>
            {#snippet control()}<ShSwitch bind:checked={DBState.db.hypaV3} onCheckedChange={(on) => DBState.db.memoryAlgorithmType = on ? "hypaMemoryV3" : "none"}/>{/snippet}
        </SettingLayout>

        {#if DBState.db.hypaV3}
            <SettingLayout variant="row" title={language.presets} description={language.help.hypaV3Preset}>
                {#snippet control()}
                    <PresetHeader
                        compact
                        label={language.presets}
                        activeName={preset?.name ?? "Default"}
                        onManage={() => pickerOpen = true}
                    />
                {/snippet}
            </SettingLayout>

            {#if settings}
                <SettingLayout variant="row" title={language.summarizationPrompt} description={help("summarizationPrompt")} stacked>
                    <TextAreaInput bind:value={settings.summarizationPrompt} placeholder={language.hypaV3Settings.supaMemoryPromptPlaceHolder}/>
                </SettingLayout>
                <SettingLayout variant="row" title={language.reSummarizationPrompt} description={help("reSummarizationPrompt")} stacked>
                    <TextAreaInput bind:value={settings.reSummarizationPrompt} placeholder={language.hypaV3Settings.supaMemoryPromptPlaceHolder}/>
                </SettingLayout>

                <h3 class="text-base font-bold mt-8 mb-1">{language.hypaV3Settings.memoryConfigurationLabel}</h3>
                <div class="[&>*:first-child]:border-t-0">
                <SettingLayout variant="row" title={language.hypaV3Settings.maxMemoryTokensRatioLabel}>{#snippet control()}<div class="w-48">{#await maxMemoryRatio then ratio}<ShSlider min={0} max={1} step={0.01} fixed={2} disabled value={ratio}/>{:catch}<span class="text-sm text-red-400">{language.hypaV3Settings.maxMemoryTokensRatioError}</span>{/await}</div>{/snippet}</SettingLayout>
                <SettingLayout variant="row" title={language.hypaV3Settings.memoryTokensRatioLabel} description={help("hypaV3MemoryTokensRatio")}>{#snippet control()}<div class="w-48"><ShSlider min={0} max={1} step={0.01} fixed={2} bind:value={settings.memoryTokensRatio}/></div>{/snippet}</SettingLayout>
                <SettingLayout variant="row" title={language.hypaV3Settings.extraSummarizationRatioLabel} description={help("hypaV3ExtraSummarizationRatio")}>{#snippet control()}<div class="w-48"><ShSlider min={0} max={1 - settings.memoryTokensRatio} step={0.01} fixed={2} bind:value={settings.extraSummarizationRatio}/></div>{/snippet}</SettingLayout>
                <SettingLayout variant="row" title={language.hypaV3Settings.recentMemoryRatioLabel} description={help("hypaV3RecentMemoryRatio")}>{#snippet control()}<div class="w-48"><ShSlider min={0} max={1} step={0.01} fixed={2} bind:value={settings.recentMemoryRatio}/></div>{/snippet}</SettingLayout>
                <SettingLayout variant="row" title={language.hypaV3Settings.similarMemoryRatioLabel} description={help("hypaV3SimilarMemoryRatio")}>{#snippet control()}<div class="w-48"><ShSlider min={0} max={1 - settings.recentMemoryRatio} step={0.01} fixed={2} bind:value={settings.similarMemoryRatio}/></div>{/snippet}</SettingLayout>
                <SettingLayout variant="row" title={language.hypaV3Settings.randomMemoryRatioLabel} description={help("hypaV3RandomMemoryRatio")}>{#snippet control()}<div class="w-48"><ShSlider min={0} max={1} step={0.01} fixed={2} disabled value={Math.max(0, 1 - settings.recentMemoryRatio - settings.similarMemoryRatio)}/></div>{/snippet}</SettingLayout>
                <SettingLayout variant="row" title={language.hypaV3Settings.maxChatsPerSummaryLabel} description={help("hypaV3MaxChatsPerSummary")}>{#snippet control()}<div class="w-48"><ShSlider min={1} max={12} step={1} bind:value={settings.maxChatsPerSummary}/></div>{/snippet}</SettingLayout>
                <SettingLayout variant="row" title={language.hypaV3Settings.queryChatCountLabel} description={help("hypaV3QueryChatCount")}>{#snippet control()}<div class="w-48"><ShSlider min={1} max={12} step={1} bind:value={settings.queryChatCount}/></div>{/snippet}</SettingLayout>
                <SettingLayout variant="row" title={language.hypaV3Settings.summaryChunkSeparatorLabel} description={help("hypaV3SummaryChunkSeparator")}>{#snippet control()}<TextInput className="w-48 text-sm" size="sm" bind:value={settings.summaryChunkSeparator}/>{/snippet}</SettingLayout>

                <SettingLayout variant="row" title={language.hypaV3Settings.preserveOrphanedMemoryLabel} description={help("hypaV3PreserveOrphanedMemory")}>{#snippet control()}<ShSwitch bind:checked={settings.preserveOrphanedMemory}/>{/snippet}</SettingLayout>
                <SettingLayout variant="row" title={language.hypaV3Settings.applyRegexScriptWhenRerollingLabel} description={help("hypaV3ProcessRegexScript")}>{#snippet control()}<ShSwitch bind:checked={settings.processRegexScript}/>{/snippet}</SettingLayout>
                <SettingLayout variant="row" title={language.hypaV3Settings.doNotSummarizeUserMessageLabel} description={help("hypaV3DoNotSummarizeUserMessage")}>{#snippet control()}<ShSwitch bind:checked={settings.doNotSummarizeUserMessage}/>{/snippet}</SettingLayout>
                </div>

                <Accordion name={language.hypaV3Settings.advancedSettingsLabel} styled>
                    <div class="[&>*:first-child]:border-t-0">
                    <SettingLayout variant="row" title={language.hypaV3Settings.useExperimentalImplLabel} description={help("hypaV3UseExperimentalImpl")}>{#snippet control()}<ShSwitch bind:checked={settings.useExperimentalImpl}/>{/snippet}</SettingLayout>
                    <SettingLayout variant="row" title={language.hypaV3Settings.alwaysToggleOnLabel} description={help("hypaV3AlwaysToggleOn")}>{#snippet control()}<ShSwitch bind:checked={settings.alwaysToggleOn}/>{/snippet}</SettingLayout>
                    {#if settings.useExperimentalImpl}
                        <SettingLayout variant="row" title={language.hypaV3Settings.summarizationRequestsPerMinuteLabel} description={help("hypaV3SummarizationRequestsPerMinute")}>{#snippet control()}<div class="w-48"><ShSlider min={1} max={100} step={1} bind:value={settings.summarizationRequestsPerMinute}/></div>{/snippet}</SettingLayout>
                        <SettingLayout variant="row" title={language.hypaV3Settings.summarizationMaxConcurrentLabel} description={help("hypaV3SummarizationMaxConcurrent")}>{#snippet control()}<div class="w-48"><ShSlider min={1} max={12} step={1} bind:value={settings.summarizationMaxConcurrent}/></div>{/snippet}</SettingLayout>
                        <SettingLayout variant="row" title={language.hypaV3Settings.embeddingRequestsPerMinuteLabel} description={help("hypaV3EmbeddingRequestsPerMinute")}>{#snippet control()}<div class="w-48"><ShSlider min={1} max={100} step={1} bind:value={settings.embeddingRequestsPerMinute}/></div>{/snippet}</SettingLayout>
                        <SettingLayout variant="row" title={language.hypaV3Settings.embeddingMaxConcurrentLabel} description={help("hypaV3EmbeddingMaxConcurrent")}>{#snippet control()}<div class="w-48"><ShSlider min={1} max={12} step={1} bind:value={settings.embeddingMaxConcurrent}/></div>{/snippet}</SettingLayout>
                    {:else}
                        <SettingLayout variant="row" title={language.hypaV3Settings.enableSimilarityCorrectionLabel} description={help("hypaV3EnableSimilarityCorrection")}>{#snippet control()}<ShSwitch bind:checked={settings.enableSimilarityCorrection}/>{/snippet}</SettingLayout>
                    {/if}
                    </div>
                </Accordion>
            {/if}
        {/if}
        </div>
    </SettingLayout>

    <SettingLayout variant="section" title={language.embedding}>
        <div class="[&>*:first-child]:border-t-0">
        <SettingLayout variant="row" title={language.hypaV3Settings.embeddingProviderLabel} description={help("embedding")}>
            {#snippet control()}<SelectInput className="w-48 text-sm" size="sm" value={embeddingProvider} onchange={(e) => selectEmbeddingProvider(e.currentTarget.value)}>
                <OptionInput value="local">CPU & GPU</OptionInput>
                <OptionInput value="openai">OpenAI</OptionInput>
                <OptionInput value="voyage">Voyage</OptionInput>
                <OptionInput value="custom">Custom (OpenAI-Compatible)</OptionInput>
            </SelectInput>{/snippet}
        </SettingLayout>
        {#if embeddingProvider !== "custom"}<SettingLayout variant="row" title={language.hypaV3Settings.embeddingModelLabel} description={language.help.hypaV3EmbeddingModel}>
            {#snippet control()}<SelectInput className="w-48 text-sm" size="sm" bind:value={DBState.db.hypaModel}>
                {#if embeddingProvider === "local"}
                    {#if "gpu" in navigator}
                        <OptionInput value="MiniLMGPU">MiniLM L6 v2 (GPU)</OptionInput>
                        <OptionInput value="nomicGPU">Nomic Embed Text v1.5 (GPU)</OptionInput>
                        <OptionInput value="bgeSmallEnGPU">BGE Small English (GPU)</OptionInput>
                        <OptionInput value="bgem3GPU">BGE Medium 3 (GPU)</OptionInput>
                        <OptionInput value="multiMiniLMGPU">Multilingual MiniLM L12 v2 (GPU)</OptionInput>
                        <OptionInput value="bgeM3KoGPU">BGE Medium 3 Korean (GPU)</OptionInput>
                    {/if}
                    <OptionInput value="MiniLM">MiniLM L6 v2 (CPU)</OptionInput>
                    <OptionInput value="nomic">Nomic Embed Text v1.5 (CPU)</OptionInput>
                    <OptionInput value="bgeSmallEn">BGE Small English (CPU)</OptionInput>
                    <OptionInput value="bgem3">BGE Medium 3 (CPU)</OptionInput>
                    <OptionInput value="multiMiniLM">Multilingual MiniLM L12 v2 (CPU)</OptionInput>
                    <OptionInput value="bgeM3Ko">BGE Medium 3 Korean (CPU)</OptionInput>
                {:else if embeddingProvider === "openai"}
                    <OptionInput value="openai3small">text-embedding-3-small</OptionInput>
                    <OptionInput value="openai3large">text-embedding-3-large</OptionInput>
                    <OptionInput value="ada">Ada (text-embedding-ada-002)</OptionInput>
                {:else if embeddingProvider === "voyage"}
                    <OptionInput value="voyage4large">voyage-4-large</OptionInput>
                    <OptionInput value="voyageContext3">voyage-context-3</OptionInput>
                    <OptionInput value="voyageContext4">voyage-context-4</OptionInput>
                {/if}
            </SelectInput>{/snippet}
        </SettingLayout>{/if}
        {#if embeddingProvider === "openai"}
            <SettingLayout variant="row" title={language.hypaV3Settings.openAIAPIKeyLabel} description={help("embeddingOpenAIKey")}>
                {#snippet control()}<ApiKeyModeControl bind:mode={openAIKeyMode} entries={openAIKeys} selectedId={openAIKeyRef} bind:directValue={DBState.db.supaMemoryKey} onSelect={(id) => useKey(id, "openai")} />{/snippet}
            </SettingLayout>
        {:else if embeddingProvider === "voyage"}
            <SettingLayout variant="row" title={language.hypaV3Settings.voyageAPIKeyLabel} description={help("embeddingVoyageKey")}>
                {#snippet control()}<ApiKeyModeControl bind:mode={voyageKeyMode} entries={voyageKeys} selectedId={voyageKeyRef} bind:directValue={DBState.db.voyageApiKey} onSelect={(id) => useKey(id, "voyage")} />{/snippet}
            </SettingLayout>
        {:else if embeddingProvider === "custom"}
            <SettingLayout variant="row" title={language.hypaV3Settings.urlLabel} description={help("embeddingCustomURL")}>{#snippet control()}<TextInput className="w-48 text-sm" size="sm" bind:value={DBState.db.hypaCustomSettings.url}/>{/snippet}</SettingLayout>
            <SettingLayout variant="row" title={language.hypaV3Settings.requestModelLabel} description={help("embeddingCustomModel")}>{#snippet control()}<TextInput className="w-48 text-sm" size="sm" bind:value={DBState.db.hypaCustomSettings.model}/>{/snippet}</SettingLayout>
            <SettingLayout variant="row" title={language.hypaV3Settings.keyPasswordLabel} description={help("embeddingCustomKey")}>
                {#snippet control()}<ApiKeyModeControl bind:mode={customKeyMode} entries={allKeys} selectedId={customKeyRef} bind:directValue={DBState.db.hypaCustomSettings.key} onSelect={(id) => useKey(id, "custom")} showProvider />{/snippet}
            </SettingLayout>
        {/if}
        </div>
    </SettingLayout>
</div>

{#if pickerOpen}
    <PresetPickerLayout
        title={`${language.HypaMemory} ${language.presets}`}
        {folders}
        itemFolderIds={DBState.db.hypaV3Presets.map(item => item.folderId)}
        itemNames={DBState.db.hypaV3Presets.map(item => item.name)}
        itemDragDataKey="hypaPresetIndex"
        bind:selectedFolder bind:searchQuery bind:visibleItemIndexes bind:emptyMessage
        close={() => pickerOpen = false}
        onFoldersChange={(next) => DBState.db.hypaV3PresetFolders = next}
        onAssignItem={(index, folderId) => {
            DBState.db.hypaV3Presets[index].folderId = folderId;
            DBState.db.hypaV3Presets = [...DBState.db.hypaV3Presets];
        }}
        onDeleteFolder={(folderId) => DBState.db.hypaV3Presets = DBState.db.hypaV3Presets.map(item =>
            item.folderId === folderId ? { ...item, folderId: undefined } : item)}
        selectedItemIndex={DBState.db.hypaV3PresetId}
        itemEditMode={editMode}
        onMoveItem={movePreset}
        onSelectItem={selectPreset}
        onDuplicateItem={duplicatePreset}
        onExportItem={exportPreset}
        onDeleteItem={removePreset}
    >
        {#snippet itemContent(index)}
                {@const item = DBState.db.hypaV3Presets[index]}
                {#if editMode}
                    <div class="grow min-w-0"><TextInput bind:value={DBState.db.hypaV3Presets[index].name} placeholder="string" padding={false} fullwidth className="h-8 min-w-0 px-2"/></div>
                {:else}
                    <span class="grow min-w-0 truncate">{item.name}</span>
                {/if}
        {/snippet}
        <PresetPickerActions onCreate={addPreset} onImport={importPreset} onRename={() => editMode = !editMode}/>
    </PresetPickerLayout>
{/if}
