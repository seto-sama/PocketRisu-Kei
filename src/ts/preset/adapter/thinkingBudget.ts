import type { ModelPreset } from '../types'
import { getEffectivePresetSemanticValue } from '../runtime/effectiveConfig'

export const MIN_THINKING_TOKENS = 1024
export const THINKING_TOKENS_KEY = 'thinking_tokens'

export function resolveThinkingBudget(
    preset: ModelPreset,
    reasoningKey: string,
): number | undefined {
    const effort = getEffectivePresetSemanticValue(
        preset,
        'reasoningEffort',
        [reasoningKey],
    )
    if (effort !== 'budget') return undefined
    const raw = getEffectivePresetSemanticValue(
        preset,
        'thinkingBudgetTokens',
        [THINKING_TOKENS_KEY],
    )
    const value = typeof raw === 'number' && Number.isFinite(raw)
        ? Math.trunc(raw)
        : MIN_THINKING_TOKENS
    return Math.max(MIN_THINKING_TOKENS, value)
}
