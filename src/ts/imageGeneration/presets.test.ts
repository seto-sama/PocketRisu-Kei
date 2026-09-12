import { describe, expect, it } from 'vitest'
import {
    captureNAIImageCoreSettings,
    createImageGenerationPreset,
    decodeImageGenerationPresetFile,
    duplicateImageGenerationPreset,
    getNAIImageDimensions,
    getCurrentImageGenerationPreset,
    normalizeImageGenerationPresetState,
} from './presets'

function legacyImageState() {
    return {
        sdProvider: 'novelai',
        NAIApiKey: 'secret',
        imageApiKeyRefs: { novelai: 'key-ref' },
        NAIImgModel: 'nai-diffusion-4-5-full',
        NAIImgConfig: {
            width: 1024,
            height: 1024,
            sampler: 'k_euler_ancestral',
            noise_schedule: 'karras',
            steps: 28,
            scale: 5,
            cfg_rescale: 0,
            sm: true,
            sm_dyn: false,
            noise: 0.2,
            strength: 0.65,
            image: 'assets/i2i.png',
            base64image: 'i2i-base64',
            InfoExtracted: 1,
            autoSmea: false,
            use_coords: false,
            legacy_uc: false,
            v4_prompt: { caption: { base_caption: '', char_captions: [] }, use_coords: false, use_order: true },
            v4_negative_prompt: { caption: { base_caption: '', char_captions: [] }, legacy_uc: false },
            variety_plus: false,
            decrisp: false,
            reference_mode: '',
            character_image: '',
            character_base64image: '',
            style_aware: false,
            reference_type: 'character',
            reference_strength: 1,
            reference_fidelity: 1,
        },
        NAII2I: true,
        comfyUiUrl: 'http://localhost:8188',
        comfyConfig: {
            workflow: '',
            timeout: 30,
        },
        imageGenerationPresets: undefined,
        imageGenerationPresetTags: undefined,
        imageGenerationPresetId: undefined,
    }
}

describe('image generation presets', () => {
    it('migrates legacy globals while keeping only asset IDs for reference images', () => {
        const state = legacyImageState()

        normalizeImageGenerationPresetState(state as never)

        const preset = state.imageGenerationPresets![0]
        expect(preset.settings.NAII2I).toBe(true)
        expect(preset.settings.NAIImgConfig).toMatchObject({
            image: 'assets/i2i.png',
            strength: 0.65,
            noise: 0.2,
        })
        expect(preset.settings.NAIImgConfig.base64image).toBeUndefined()
        expect(state.NAIImgConfig.base64image).toBeUndefined()
        expect(preset.settings.NAIImgSizePreset).toBe('custom')
        expect(preset.settings.NAIImgConfig).toMatchObject({ width: 1024, height: 1024 })
    })

    it('uses the selected preset as the source without copying it back to globals', () => {
        const state = legacyImageState()
        normalizeImageGenerationPresetState(state as never)
        const comfySettings = {
            ...state.imageGenerationPresets![0].settings,
            sdProvider: 'comfyui',
        }
        state.imageGenerationPresets!.push(createImageGenerationPreset('Comfy', comfySettings))
        state.imageGenerationPresetId = 1

        expect(getCurrentImageGenerationPreset(state as never).settings.sdProvider).toBe('comfyui')
        expect(state.sdProvider).toBe('novelai')
    })

    it('maps official NovelAI size presets across all orientations', () => {
        expect(getNAIImageDimensions('small', 'landscape')).toEqual([768, 512])
        expect(getNAIImageDimensions('small', 'portrait')).toEqual([512, 768])
        expect(getNAIImageDimensions('small', 'square')).toEqual([640, 640])
        expect(getNAIImageDimensions('normal', 'landscape')).toEqual([1216, 832])
        expect(getNAIImageDimensions('normal', 'portrait')).toEqual([832, 1216])
        expect(getNAIImageDimensions('normal', 'square')).toEqual([1024, 1024])
        expect(getNAIImageDimensions('large', 'landscape')).toEqual([1536, 1024])
        expect(getNAIImageDimensions('large', 'portrait')).toEqual([1024, 1536])
        expect(getNAIImageDimensions('large', 'square')).toEqual([1472, 1472])
    })

    it('duplicates domain settings and tags with a fresh stable id', () => {
        const state = legacyImageState()
        normalizeImageGenerationPresetState(state as never)
        const first = state.imageGenerationPresets![0]
        first.tagIds = ['tag-a']

        const duplicate = duplicateImageGenerationPreset(state as never, 0, 'Copy')

        expect(state.imageGenerationPresetId).toBe(1)
        expect(duplicate?.name).toBe(`${first.name} Copy`)
        expect(duplicate?.id).not.toBe(first.id)
        expect(duplicate?.settings).not.toBe(first.settings)
        expect(duplicate?.tagIds).toEqual(['tag-a'])
        expect(duplicate?.tagIds).not.toBe(first.tagIds)
    })

    it('captures only lightweight fields for the quick editor', () => {
        const state = legacyImageState()
        normalizeImageGenerationPresetState(state as never)

        const draft = captureNAIImageCoreSettings(state.imageGenerationPresets![0].settings)

        expect(draft).not.toHaveProperty('NAIApiKey')
        expect(draft.NAIImgConfig).toEqual({
            width: 1024,
            height: 1024,
            sampler: 'k_euler_ancestral',
            noise_schedule: 'karras',
            steps: 28,
            scale: 5,
            cfg_rescale: 0,
        })
    })

    it('decodes imported presets and normalizes legacy tag fields', () => {
        const state = legacyImageState()
        normalizeImageGenerationPresetState(state as never)
        const fallback = state.imageGenerationPresets![0].settings
        const data = new TextEncoder().encode(JSON.stringify({
            type: 'risu-image-generation-preset',
            data: {
                name: 'Imported',
                folderId: 'legacy-tag',
                settings: {
                    ...fallback,
                    sdProvider: 'comfyui',
                },
            },
        }))

        const preset = decodeImageGenerationPresetFile(data, fallback)

        expect(preset.name).toBe('Imported')
        expect(preset.settings.sdProvider).toBe('comfyui')
        expect(preset.tagIds).toEqual(['legacy-tag'])
    })

    it('rejects invalid imported preset containers with the caller message', () => {
        const state = legacyImageState()
        normalizeImageGenerationPresetState(state as never)
        const data = new TextEncoder().encode(JSON.stringify({ type: 'other' }))

        expect(() => decodeImageGenerationPresetFile(
            data,
            state.imageGenerationPresets![0].settings,
            'Invalid preset file',
        )).toThrow('Invalid preset file')
    })
})
