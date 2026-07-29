<script lang="ts">
    import SettingPage from "src/lib/UI/GUI/SettingPage.svelte";
    import SettingTabs from "src/lib/UI/GUI/SettingTabs.svelte";
    import PresetHeader from "src/lib/UI/GUI/PresetHeader.svelte";
    import SettingLayout from "src/lib/Setting/Wrappers/SettingLayout.svelte";
    import SettingRenderer from "../SettingRenderer.svelte";
    import PromptTemplateBlock from "./PromptPreset/PromptTemplateBlock.svelte";
    import PromptRegexBlock from "./PromptPreset/PromptRegexBlock.svelte";
    import PromptLegacySettings from "./PromptPreset/PromptLegacySettings.svelte";
    import { language } from "src/lang";
    import { DBState, openPresetList } from "src/ts/stores.svelte";
    import {
        promptPresetPromptItems,
        promptPresetParameterItems,
    } from "src/ts/setting/promptPresetSettingsData.svelte";
    import type { SettingItem } from "src/ts/setting/types";
    import { selectSingleFile } from "src/ts/util";
    import ShButton from "src/lib/UI/GUI/ShButton.svelte";
    import { ImageIcon, XIcon } from "@lucide/svelte";

    let submenu = $state(0);
    const activeIndex = $derived(DBState.db.botPresetsId);
    const activePreset = $derived(DBState.db.botPresets[activeIndex]);
    const basicInfoItems: SettingItem[] = [{
        id: 'promptPreset.name',
        type: 'text',
        labelKey: 'name',
        bindPath: 'name',
        options: { defaultValue: '' },
    }];

    async function uploadIcon() {
        const selected = await selectSingleFile(['png', 'jpg', 'jpeg', 'webp']);
        if (!selected) return;
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        if (!context) return;
        const image = new Image();
        // @ts-expect-error Uint8Array buffer type is incompatible with BlobPart's ArrayBuffer
        image.src = URL.createObjectURL(new Blob([selected.data], { type: 'image/png' }));
        await image.decode();
        canvas.width = 48;
        canvas.height = 48;
        context.drawImage(image, 0, 0, 48, 48);
        DBState.db.botPresets[activeIndex].image = canvas.toDataURL('image/jpeg', 0.7);
    }
</script>

<SettingPage title={language.promptPresetMenu}>
    <PresetHeader
        label={language.currentPromptPreset}
        activeName={DBState.db.botPresets?.[DBState.db.botPresetsId]?.name ?? '—'}
        onManage={() => openPresetList.set(true)}
    />
    <SettingTabs
        tabs={[
            { label: language.presetGeneral, value: 0 },
            { label: language.prompt, value: 1 },
            { label: language.advancedSettings, value: 2 },
            { label: language.regexScript, value: 3 },
        ]}
        bind:selected={submenu}
    />

    {#if submenu === 0}
        <SettingLayout variant="section" title={language.basicInfo} first>
            <div class="[&>*:first-child]:border-t-0">
                {#if activePreset}
                    <SettingRenderer items={basicInfoItems} layout="row" target={activePreset} />
                {/if}
                <SettingLayout variant="row" title={language.icon}>
                    {#snippet control()}
                        <div class="flex items-center gap-2">
                            {#if DBState.db.botPresets[activeIndex]?.image}
                                <img src={DBState.db.botPresets[activeIndex].image} alt="" class="h-8 w-8 rounded object-cover border border-darkborderc" decoding="async" />
                            {/if}
                            <ShButton variant="outline" size="sm" onclick={uploadIcon}>
                                <ImageIcon />
                                {DBState.db.botPresets[activeIndex]?.image ? language.edit : language.select}
                            </ShButton>
                            {#if DBState.db.botPresets[activeIndex]?.image}
                                <ShButton variant="destructive" size="icon-sm" onclick={() => { DBState.db.botPresets[activeIndex].image = undefined; }} aria-label={language.iconRemove}>
                                    <XIcon />
                                </ShButton>
                            {/if}
                        </div>
                    {/snippet}
                </SettingLayout>
            </div>
        </SettingLayout>
        <SettingLayout variant="section" title={language.parameters}><SettingRenderer items={promptPresetParameterItems} layout="row" /></SettingLayout>
    {:else if submenu === 1}
        <SettingRenderer items={promptPresetPromptItems} />
    {:else if submenu === 2}
        <SettingLayout variant="section" title={language.presetPromptProcessing} first><PromptTemplateBlock /></SettingLayout>

        <div class="mt-4">
            <PromptLegacySettings />
        </div>
    {:else if submenu === 3}
        <PromptRegexBlock />
    {/if}
</SettingPage>
