import { describe, expect, it } from 'vitest'
import {
    createDefaultTTSSettings,
    createTTSPreset,
    duplicateTTSPreset,
    getBoundTTSPreset,
    normalizeTTSPresetState,
    type TTSPresetState,
} from './presets'

const labels = {
    defaultName: 'Default',
    fallbackName: (index: number) => `Preset ${index + 1}`,
}

describe('TTS presets', () => {
    it('creates a blank default Fish Audio preset without migrating legacy credentials', () => {
        const state: TTSPresetState = {}
        normalizeTTSPresetState(state, labels)
        expect(state.ttsPresets).toHaveLength(1)
        expect(state.ttsPresets?.[0].settings.provider).toBe('fishspeech')
        expect(state.ttsPresets?.[0].settings.fishAudioKey).toBe('')
        expect(state.ttsPresetId).toBe(0)
    })

    it('normalizes invalid presets and selection indexes', () => {
        const state = {
            ttsPresets: [{ id: '', name: '', provider: 'removed' }],
            ttsPresetId: 99,
        } as unknown as TTSPresetState
        normalizeTTSPresetState(state, labels)
        expect(state.ttsPresets?.[0].id).not.toBe('')
        expect(state.ttsPresets?.[0].name).toBe('Preset 1')
        expect(state.ttsPresets?.[0].settings.provider).toBe('fishspeech')
        expect(state.ttsPresetId).toBe(0)
    })

    it('copies nested provider settings and resolves bindings by stable id', () => {
        const settings = createDefaultTTSSettings('gptsovits')
        settings.gptSoVits.temperature = 0.4
        const state: TTSPresetState = {
            ttsPresets: [createTTSPreset('Voice', settings)],
            ttsPresetId: 0,
        }
        duplicateTTSPreset(state, 0, 'Copy')
        state.ttsPresets![1].settings.gptSoVits.temperature = 0.8
        expect(state.ttsPresets![0].settings.gptSoVits.temperature).toBe(0.4)
        expect(getBoundTTSPreset(state, state.ttsPresets![0].id)?.name).toBe('Voice')
        expect(getBoundTTSPreset(state, 'missing')).toBeUndefined()
    })
})
