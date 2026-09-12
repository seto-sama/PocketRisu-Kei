import { safeStructuredClone } from '../polyfill'
import { appendPresetItem, duplicatePresetItem, movePresetItem, removePresetItem } from '../preset/collection'
import { createEntityId } from '../id'

export type TTSProvider = 'fishspeech' | 'elevenlab' | 'gptsovits' | 'VOICEVOX' | 'webspeech'
export type TTSSupportedLanguage = 'auto' | 'auto_yue' | 'en' | 'zh' | 'ja' | 'yue' | 'ko' | 'all_zh' | 'all_ja' | 'all_yue' | 'all_ko'

export interface TTSPresetSettings {
    provider: TTSProvider
    apiKeyRefs: Partial<Record<'elevenlabs' | 'fishspeech', string>>
    elevenLabsKey: string
    fishAudioKey: string
    voicevoxUrl: string
    voice: string
    voicevox: { speaker: string; speedScale: number; pitchScale: number; intonationScale: number; volumeScale: number }
    gptSoVits: {
        url: string; useReferenceAudio: boolean; referenceAudioPath: string; referenceAudioScript: string
        referenceAudioLanguage: TTSSupportedLanguage
        textLanguage: TTSSupportedLanguage
        topP: number; temperature: number; speed: number; topK: number
        textSplitMethod: 'cut0' | 'cut1' | 'cut2' | 'cut3' | 'cut4' | 'cut5'
    }
    fishAudio: {
        engine: 's2.1-pro' | 's2.1-pro-free'
        model: { _id: string; title: string; description: string }
        chunkLength: number
        normalize: boolean
    }
}

export interface TTSPreset { id: string; name: string; settings: TTSPresetSettings }
export interface TTSPresetState { ttsPresets?: TTSPreset[]; ttsPresetId?: number }

function normalizeProvider(value: unknown): TTSProvider {
    return value === 'fishspeech' || value === 'elevenlab' || value === 'gptsovits'
        || value === 'VOICEVOX' || value === 'webspeech' ? value : 'fishspeech'
}

export function createDefaultTTSSettings(provider: TTSProvider = 'fishspeech'): TTSPresetSettings {
    return {
        provider,
        apiKeyRefs: {},
        elevenLabsKey: '',
        fishAudioKey: '',
        voicevoxUrl: '',
        voice: '',
        voicevox: { speaker: '', speedScale: 1, pitchScale: 0, intonationScale: 1, volumeScale: 1 },
        gptSoVits: {
            url: '', useReferenceAudio: false, referenceAudioPath: '', referenceAudioScript: '', referenceAudioLanguage: 'en',
            textLanguage: 'auto', topP: 1, temperature: 1, speed: 1, topK: 15,
            textSplitMethod: 'cut5',
        },
        fishAudio: {
            engine: 's2.1-pro', model: { _id: '', title: '', description: '' },
            chunkLength: 300, normalize: true,
        },
    }
}

function normalizeSettings(value: Partial<TTSPresetSettings> | undefined, legacyProvider?: unknown): TTSPresetSettings {
    const defaults = createDefaultTTSSettings(normalizeProvider(value?.provider ?? legacyProvider))
    return {
        ...defaults,
        ...safeStructuredClone(value ?? {}),
        provider: normalizeProvider(value?.provider ?? legacyProvider),
        apiKeyRefs: safeStructuredClone(value?.apiKeyRefs ?? {}),
        voicevox: { ...defaults.voicevox, ...safeStructuredClone(value?.voicevox ?? {}) },
        gptSoVits: { ...defaults.gptSoVits, ...safeStructuredClone(value?.gptSoVits ?? {}) },
        fishAudio: {
            ...defaults.fishAudio,
            ...safeStructuredClone(value?.fishAudio ?? {}),
            model: { ...defaults.fishAudio.model, ...safeStructuredClone(value?.fishAudio?.model ?? {}) },
        },
    }
}

export function createTTSPreset(name: string, settings: TTSPresetSettings): TTSPreset {
    return { id: createEntityId(), name, settings: safeStructuredClone(settings) }
}

export function normalizeTTSPresetState(state: TTSPresetState, labels: { defaultName: string; fallbackName: (index: number) => string }): void {
    if (!Array.isArray(state.ttsPresets) || state.ttsPresets.length === 0) {
        state.ttsPresets = [createTTSPreset(labels.defaultName, createDefaultTTSSettings())]
    } else {
        state.ttsPresets = state.ttsPresets.map((preset, index) => {
            const legacyProvider = (preset as TTSPreset & { provider?: unknown })?.provider
            return {
                id: typeof preset?.id === 'string' && preset.id ? preset.id : createEntityId(),
                name: typeof preset?.name === 'string' && preset.name ? preset.name : labels.fallbackName(index),
                settings: normalizeSettings(preset?.settings, legacyProvider),
            }
        })
    }
    const selectedIndex = Number.isInteger(state.ttsPresetId) ? state.ttsPresetId as number : 0
    state.ttsPresetId = Math.min(Math.max(selectedIndex, 0), state.ttsPresets.length - 1)
}

export function getActiveTTSPreset(state: TTSPresetState): TTSPreset | undefined {
    return state.ttsPresets?.[state.ttsPresetId ?? 0] ?? state.ttsPresets?.[0]
}

export function getBoundTTSPreset(state: TTSPresetState, presetId?: string): TTSPreset | undefined {
    if (!presetId) return undefined
    return state.ttsPresets?.find(preset => preset.id === presetId)
}

export function appendTTSPreset(state: TTSPresetState, preset: TTSPreset): number {
    const result = appendPresetItem(state.ttsPresets ?? [], preset)
    state.ttsPresets = result.items
    state.ttsPresetId = result.selectedIndex
    return state.ttsPresetId
}

export function duplicateTTSPreset(state: TTSPresetState, index: number, copyLabel: string): boolean {
    const result = duplicatePresetItem(
        state.ttsPresets ?? [],
        index,
        source => createTTSPreset(`${source.name} ${copyLabel}`, source.settings),
    )
    if (!result.changed) return false
    state.ttsPresets = result.items
    state.ttsPresetId = result.selectedIndex
    return result.changed
}

export function removeTTSPreset(state: TTSPresetState, index: number): boolean {
    const result = removePresetItem(state.ttsPresets ?? [], state.ttsPresetId ?? 0, index)
    if (!result.changed) return false
    state.ttsPresets = result.items
    state.ttsPresetId = result.selectedIndex
    return result.changed
}

export function moveTTSPreset(state: TTSPresetState, fromIndex: number, toIndex: number): boolean {
    const result = movePresetItem(state.ttsPresets ?? [], state.ttsPresetId ?? 0, fromIndex, toIndex)
    if (!result.changed) return false
    state.ttsPresets = result.items
    state.ttsPresetId = result.selectedIndex
    return result.changed
}
