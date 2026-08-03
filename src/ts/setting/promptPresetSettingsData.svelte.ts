/**
 * Prompt Preset Settings Data
 *
 * Data-driven definition for the new PromptPreset menu (SettingsMenuIndex 17).
 * Three tabs: general (basic info + parameters) / prompt / advanced settings.
 *
 * Values are stored in the active prompt preset through the database's existing
 * preset synchronization layer.
 */

import type { SettingItem } from './types';

export const promptPresetPromptItems: SettingItem[] = [
    {
        id: 'promptPreset.editor',
        type: 'custom',
        componentId: 'PromptEditorSection',
        keywords: ['mainPrompt', 'jailbreak', 'globalNote', 'formatingOrder', 'promptTemplate'],
    },
];

/** Parameters stored by a prompt preset and optionally applied to a ModelPreset. */
export const promptPresetParameterItems: SettingItem[] = [
    {
        id: 'promptPreset.params.maxContext',
        type: 'slider',
        labelKey: 'maxContextSize',
        helpKey: 'maxContextSize',
        bindKey: 'maxContext',
        options: { min: 1, max: 256000 },
        keywords: ['context', 'size', 'token', 'limit'],
    },
    {
        id: 'promptPreset.params.maxResponse',
        type: 'slider',
        labelKey: 'maxResponseSize',
        helpKey: 'maxResponseSize',
        bindKey: 'maxResponse',
        options: { min: 1, max: 25600 },
        keywords: ['response', 'size', 'output', 'length'],
    },
    {
        id: 'promptPreset.params.temperature',
        type: 'slider',
        labelKey: 'temperature',
        helpKey: 'tempature',
        bindKey: 'temperature',
        options: { min: 0, max: 200, multiple: 0.01, fixed: 2, disableable: true },
        keywords: ['temperature', 'creativity', 'randomness'],
    },
    {
        id: 'promptPreset.params.topK',
        type: 'slider',
        fallbackLabel: 'Top K',
        helpKey: 'topK',
        bindKey: 'top_k',
        options: { min: 0, max: 100, step: 1, disableable: true },
        keywords: ['top', 'k', 'sampling'],
    },
    {
        id: 'promptPreset.params.topP',
        type: 'slider',
        fallbackLabel: 'Top P',
        helpKey: 'topP',
        bindKey: 'top_p',
        options: { min: 0, max: 1, step: 0.01, fixed: 2, disableable: true },
        keywords: ['top', 'p', 'nucleus', 'sampling'],
    },
    {
        id: 'promptPreset.params.minP',
        type: 'slider',
        fallbackLabel: 'Min P',
        helpKey: 'minP',
        bindKey: 'min_p',
        options: { min: 0, max: 1, step: 0.01, fixed: 2, disableable: true },
        keywords: ['min', 'p', 'sampling'],
    },
    {
        id: 'promptPreset.params.topA',
        type: 'slider',
        fallbackLabel: 'Top A',
        helpKey: 'topA',
        bindKey: 'top_a',
        options: { min: 0, max: 1, step: 0.01, fixed: 2, disableable: true },
        keywords: ['top', 'a', 'sampling'],
    },
    {
        id: 'promptPreset.params.repetitionPenalty',
        type: 'slider',
        fallbackLabel: 'Repetition penalty',
        helpKey: 'repetitionPenalty',
        bindKey: 'repetition_penalty',
        options: { min: 0, max: 2, step: 0.01, fixed: 2, disableable: true },
        keywords: ['repetition', 'penalty'],
    },
    {
        id: 'promptPreset.params.frequencyPenalty',
        type: 'slider',
        labelKey: 'frequencyPenalty',
        helpKey: 'frequencyPenalty',
        bindKey: 'frequencyPenalty',
        options: { min: 0, max: 200, multiple: 0.01, fixed: 2, disableable: true },
        keywords: ['frequency', 'penalty', 'repetition'],
    },
    {
        id: 'promptPreset.params.presencePenalty',
        type: 'slider',
        labelKey: 'presensePenalty',
        helpKey: 'presensePenalty',
        bindKey: 'PresensePenalty',
        options: { min: 0, max: 200, multiple: 0.01, fixed: 2, disableable: true },
        keywords: ['presence', 'penalty'],
    },
];
