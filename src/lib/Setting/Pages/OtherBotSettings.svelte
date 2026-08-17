<script lang="ts">
    import SettingPage from "src/lib/UI/GUI/SettingPage.svelte";
    import SettingTabs from "src/lib/UI/GUI/SettingTabs.svelte";
    import { language } from "src/lang";
    import { DBState, OtherBotsSubmenuIndex, selectedCharID } from "src/ts/stores.svelte";
    import { untrack } from "svelte";
    import { tokenizePreset } from "src/ts/process/prompt";
    import { getCharToken } from "src/ts/tokenizer";
    import HypaMemorySettings from "./HypaMemorySettings.svelte";
    import TTSSettings from "./TTSSettings.svelte";
    import ImageSettings from "./ImageSettings.svelte";

    $effect(() => {
        const settings = DBState.db.hypaV3Presets?.[DBState.db.hypaV3PresetId]?.settings;
        const currentValue = settings?.similarMemoryRatio;
        if (!currentValue) return;

        untrack(() => {
            const newValue = Math.min(currentValue, 1);
            settings.similarMemoryRatio = newValue;
            if (newValue + settings.recentMemoryRatio > 1) {
                settings.recentMemoryRatio = 1 - newValue;
            }
        });
    });

    $effect(() => {
        const settings = DBState.db.hypaV3Presets?.[DBState.db.hypaV3PresetId]?.settings;
        const currentValue = settings?.recentMemoryRatio;
        if (!currentValue) return;

        untrack(() => {
            const newValue = Math.min(currentValue, 1);
            settings.recentMemoryRatio = newValue;
            if (newValue + settings.similarMemoryRatio > 1) {
                settings.similarMemoryRatio = 1 - newValue;
            }
        });
    });

    async function getMaxMemoryRatio(): Promise<number> {
        const promptTemplateToken = await tokenizePreset(DBState.db.promptTemplate);
        const char = DBState.db.characters[$selectedCharID];
        const charToken = await getCharToken(char);
        const maxLoreToken = char.loreSettings?.tokenBudget ?? DBState.db.loreBookToken;
        const maxResponse = DBState.db.maxResponse;
        const requiredToken = promptTemplateToken + charToken.persistant + Math.min(charToken.dynamic, maxLoreToken) + maxResponse * 3;
        const maxContext = DBState.db.maxContext;
        if (maxContext === 0) return 0;
        return parseFloat(Math.max((maxContext - requiredToken) / maxContext, 0).toFixed(2));
    }
</script>

<SettingPage title={language.otherBots}>
    <SettingTabs tabs={[
        { label: language.longTermMemory, value: 0 },
        { label: 'TTS', value: 1 },
        { label: language.image, value: 2 },
    ]} bind:selected={$OtherBotsSubmenuIndex} />

    {#if $OtherBotsSubmenuIndex === 0}
        <HypaMemorySettings maxMemoryRatio={getMaxMemoryRatio()} />
    {:else if $OtherBotsSubmenuIndex === 1}
        <TTSSettings />
    {:else if $OtherBotsSubmenuIndex === 2}
        <ImageSettings />
    {/if}
</SettingPage>
