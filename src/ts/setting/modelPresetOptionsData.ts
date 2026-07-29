// Data-driven items for the Model Preset page's "Settings" tab.
// Rendered with SettingRenderer layout="row" (see ui.md "Setting 행 레이아웃").

import type { SettingItem } from './types'

export const modelPresetOtherOptionsItems: SettingItem[] = [
    {
        id: 'modelPreset.promptPresetFirst',
        type: 'check',
        labelKey: 'modelPresetPromptPresetFirst',
        helpKey: 'modelPresetPromptPresetFirst',
        bindKey: 'modelPresetPromptPresetFirst',
    },
    {
        id: 'modelPreset.promptParamsFirst',
        type: 'check',
        labelKey: 'modelPresetPromptParamsFirst',
        helpKey: 'modelPresetPromptParamsFirst',
        bindKey: 'modelPresetPromptParamsFirst',
    },
    {
        id: 'modelPreset.defaultMaxContext',
        type: 'number',
        labelKey: 'modelPresetDefaultMaxContext',
        helpKey: 'modelPresetDefaultMaxContext',
        bindKey: 'modelPresetDefaultMaxContext',
        condition: (ctx) => !ctx.db.modelPresetPromptPresetFirst,
        options: { min: 1 },
    },
    {
        id: 'modelPreset.defaultMaxResponse',
        type: 'number',
        labelKey: 'modelPresetDefaultMaxResponse',
        helpKey: 'modelPresetDefaultMaxResponse',
        bindKey: 'modelPresetDefaultMaxResponse',
        condition: (ctx) => !ctx.db.modelPresetPromptPresetFirst,
        options: { min: 1 },
    },
]

export const modelPresetRegistryOptionsItems: SettingItem[] = [
    {
        id: 'modelPreset.registryRefresh',
        type: 'custom',
        componentId: 'ModelRegistryRefresh',
    },
    {
        id: 'modelPreset.providerFilter',
        type: 'custom',
        componentId: 'ModelProviderFilter',
    },
    {
        id: 'modelPreset.visibilityLevel',
        type: 'select',
        labelKey: 'profileVisibilityLevel',
        helpKey: 'profileVisibilityLevel',
        bindKey: 'modelProfileVisibilityLevel',
        options: {
            // First option is the convention default (see SettingSelect reset
            // fallback) — keep it aligned with dbDefaults' 'hideDeprecated'.
            selectOptions: [
                { value: 'hideDeprecated', labelKey: 'profileVisibilityHideDeprecated' },
                { value: 'all', labelKey: 'profileVisibilityAll' },
            ],
        },
    },
]
