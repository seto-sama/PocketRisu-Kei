import type { AdapterCredential } from '../adapter/types'
import type { ModelPreset } from '../types'

export function resolveModelPresetCredential(preset: ModelPreset, apiKeyPool?: Record<string, { key?: string }>): AdapterCredential | undefined {
    if (preset.apiKeyRef) {
        const entry = apiKeyPool?.[preset.apiKeyRef]
        if (entry?.key) return { apiKey: entry.key }
    }
    if (typeof preset.inlineCredential === 'string' && preset.inlineCredential.length > 0) {
        return { apiKey: preset.inlineCredential }
    }
    if (preset.inlineCredential && typeof preset.inlineCredential === 'object') {
        return preset.inlineCredential as AdapterCredential
    }
    for (const field of preset.profileSnapshot.schema) {
        if (field.mapsTo?.target !== 'auth') continue
        const value = preset.userValues?.[field.key]
        if (typeof value === 'string' && value.length > 0) {
            return { apiKey: value }
        }
    }
    return undefined
}
