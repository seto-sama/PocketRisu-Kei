<script lang="ts">
    import { language } from "src/lang";
    import ShAccordion from "src/lib/UI/GUI/ShAccordion.svelte";
    import SettingRenderer from "../../SettingRenderer.svelte";
    import type { SettingItem } from "src/ts/setting/types";
    import { defaultAutoSuggestPrompt } from "src/ts/storage/defaultPrompts";

    const promptPresetLegacyItems: SettingItem[] = [
        { id: 'promptPreset.legacy.postEndInnerFormat', type: 'text', labelKey: 'postEndInnerFormat', bindPath: 'promptSettings.postEndInnerFormat' },
        { id: 'promptPreset.legacy.sendName', type: 'check', labelKey: 'formatGroupInSingle', bindPath: 'promptSettings.sendName' },
        {
            id: 'promptPreset.legacy.groupTemplate', type: 'textarea', labelKey: 'groupInnerFormat', helpKey: 'groupInnerFormat', bindKey: 'groupTemplate',
            options: { placeholder: `<{{char}}'s Message>\n{{slot}}\n</{{char}}'s Message>` },
        },
        { id: 'promptPreset.legacy.utilOverride', type: 'check', labelKey: 'utilOverride', bindPath: 'promptSettings.utilOverride' },
        { id: 'promptPreset.legacy.maxThoughtTagDepth', type: 'number', labelKey: 'maxThoughtTagDepth', bindPath: 'promptSettings.maxThoughtTagDepth' },
        {
            id: 'promptPreset.legacy.autoSuggestPrompt', type: 'textarea', labelKey: 'autoSuggest', helpKey: 'autoSuggest', bindKey: 'autoSuggestPrompt',
            options: { placeholder: defaultAutoSuggestPrompt },
        },
        { id: 'promptPreset.legacy.predictedOutput', type: 'textarea', labelKey: 'predictedOutput', bindKey: 'OAIPrediction' },
        { id: 'promptPreset.legacy.outputImageModal', type: 'check', labelKey: 'outputImageModal', bindKey: 'outputImageModal' },
    ];
</script>

<ShAccordion>
    {#snippet trigger()}
        <span>{language.presetLegacySettings}</span>
    {/snippet}

    <div class="[&>*:first-child]:border-t-0">
        <SettingRenderer items={promptPresetLegacyItems} layout="row" />
    </div>
</ShAccordion>
