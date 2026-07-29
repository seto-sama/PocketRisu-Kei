/**
 * Prompt Preset Settings Data
 *
 * Data-driven definition for the new PromptPreset menu (SettingsMenuIndex 17).
 * Three tabs: general (basic info + parameters) / prompt / advanced settings.
 *
 * Data layer is shared with BotSettings (db.botPresets, db.mainPrompt etc.).
 * Edits in either menu reflect immediately in the other — the new menu is a
 * different view of the same active preset.
 */

import type { SettingItem } from './types';
import { allBasicParameterItems } from './botSettingsParamsData';

export const promptPresetPromptItems: SettingItem[] = [
    {
        id: 'promptPreset.editor',
        type: 'custom',
        componentId: 'PromptEditorSection',
        keywords: ['mainPrompt', 'jailbreak', 'globalNote', 'formatingOrder', 'promptTemplate'],
    },
];

/**
 * Parameters tab — the preset's own parameter data, shown WITHOUT the
 * model-gating conditions BotSettings uses (`ctx.modelInfo.parameters`):
 * this page edits the prompt preset standalone, independent of whichever
 * classic model happens to be selected. Items are reused from
 * botSettingsParamsData so ranges/help/bindKeys stay single-sourced.
 *
 * Scope (matches applyPromptPresetParams): the sampling set the per-chat
 * "Use Prompt Parameters" override can inject, plus maxContext/maxResponse
 * which are preset data used by the classic path. Model-specific extras
 * (seed, thinking, reasoning effort, verbosity) stay BotSettings-only —
 * they never apply through the override and depend on the active model.
 */
const PROMPT_PARAM_SOURCE_IDS = [
    'params.maxContext',
    'params.maxResponse',
    'params.temperature',
    'params.topK',
    'params.minP',
    'params.topA',
    'params.repetitionPenalty',
    'params.topP',
    'params.frequencyPenalty',
    'params.presencePenalty',
];

export const promptPresetParameterItems: SettingItem[] = allBasicParameterItems
    .filter((item) => PROMPT_PARAM_SOURCE_IDS.includes(item.id))
    .map(({ condition: _condition, ...item }) => ({
        ...item,
        id: item.id.replace('params.', 'promptPreset.params.'),
        type: item.id === 'params.maxContext' || item.id === 'params.maxResponse'
            ? 'slider' as const
            : item.type,
        options: item.id === 'params.maxContext'
            ? { ...item.options, min: 1, max: 256000 }
            : item.id === 'params.maxResponse'
                ? { ...item.options, min: 1, max: 25600 }
                : item.options,
    }));
