<script lang="ts">
    import { PlusIcon, TrashIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import ModelList from "src/lib/UI/ModelList.svelte";
    import ShAccordion from "src/lib/UI/GUI/ShAccordion.svelte";
    import ShButton from "src/lib/UI/GUI/ShButton.svelte";
    import { DBState } from "src/ts/stores.svelte";
    import SettingRenderer from "../../SettingRenderer.svelte";
    import type { SettingItem } from "src/ts/setting/types";
    import { defaultAutoSuggestPrompt } from "src/ts/storage/defaultPrompts";

    type FallbackMode = 'model' | 'memory' | 'translate' | 'emotion' | 'otherAx';

    const fallbackSections: { mode: FallbackMode; label: string }[] = [
        { mode: 'model', label: language.model },
        { mode: 'memory', label: 'Memory' },
        { mode: 'translate', label: 'Translations' },
        { mode: 'emotion', label: 'Emotion' },
        { mode: 'otherAx', label: 'OtherAx' },
    ];

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
        { id: 'promptPreset.legacy.fallbackWhenBlankResponse', type: 'check', labelKey: 'fallbackWhenBlankResponse', bindKey: 'fallbackWhenBlankResponse' },
        { id: 'promptPreset.legacy.doNotChangeFallbackModels', type: 'check', labelKey: 'doNotChangeFallbackModels', bindKey: 'doNotChangeFallbackModels' },
    ];

    function addFallback(mode: FallbackMode) {
        DBState.db.fallbackModels[mode] = [...(DBState.db.fallbackModels[mode] ?? []), ''];
    }

    function removeFallback(mode: FallbackMode) {
        DBState.db.fallbackModels[mode] = DBState.db.fallbackModels[mode].slice(0, -1);
    }
</script>

<ShAccordion>
    {#snippet trigger()}
        <span>{language.presetLegacySettings}</span>
    {/snippet}

    <div class="[&>*:first-child]:border-t-0">
        <SettingRenderer items={promptPresetLegacyItems} layout="row" />

        <div class="py-3 border-t border-darkborderc">
            <h4 class="text-sm font-semibold text-textcolor">{language.fallbackModel}</h4>
            {#each fallbackSections as section}
                <div class="mt-4 first:mt-2">
                    <div class="flex items-center justify-between gap-2 mb-2">
                        <span class="text-xs font-medium text-textcolor2">{section.label}</span>
                        <div class="flex items-center gap-1">
                            <ShButton variant="ghost" size="icon-sm" onclick={() => addFallback(section.mode)} aria-label={language.add}>
                                <PlusIcon />
                            </ShButton>
                            <ShButton
                                variant="ghost"
                                size="icon-sm"
                                disabled={DBState.db.fallbackModels[section.mode].length === 0}
                                onclick={() => removeFallback(section.mode)}
                                aria-label={language.remove}
                            >
                                <TrashIcon />
                            </ShButton>
                        </div>
                    </div>
                    <div class="flex flex-col gap-2">
                        {#each DBState.db.fallbackModels[section.mode] as _model, i}
                            <div class="flex items-center gap-2">
                                <span class="w-5 shrink-0 text-xs text-textcolor2 tabular-nums">{i + 1}</span>
                                <div class="min-w-0 grow">
                                    <ModelList bind:value={DBState.db.fallbackModels[section.mode][i]} blankable />
                                </div>
                            </div>
                        {/each}
                    </div>
                </div>
            {/each}
        </div>
    </div>
</ShAccordion>
