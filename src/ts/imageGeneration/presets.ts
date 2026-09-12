import type { Database, NAIImgConfig } from '../storage/database.svelte'
import { normalizePresetTagFields, normalizeTagIds, type PresetTagFields } from '../preset/tags'
import { appendPresetItem, duplicatePresetItem, movePresetItem, removePresetItem } from '../preset/collection'
import { createEntityId } from '../id'

export type NAIImageSizePreset = 'small' | 'normal' | 'large' | 'custom'
export type NAIImageOrientation = 'landscape' | 'portrait' | 'square'
export type ImageGenerationProvider = '' | 'novelai' | 'comfyui'

function normalizeImageGenerationProvider(value: unknown): ImageGenerationProvider {
    return value === 'novelai' || value === 'comfyui' ? value : ''
}

function normalizeNAIImageSizePreset(value: unknown): NAIImageSizePreset {
    return value === 'small' || value === 'normal' || value === 'large' || value === 'custom'
        ? value
        : 'custom'
}

function normalizeNAIImageOrientation(value: unknown): NAIImageOrientation {
    return value === 'landscape' || value === 'portrait' || value === 'square'
        ? value
        : 'landscape'
}

const NAI_IMAGE_SIZE_BASE = {
    small: { landscape: [768, 512], square: [640, 640] },
    normal: { landscape: [1216, 832], square: [1024, 1024] },
    large: { landscape: [1536, 1024], square: [1472, 1472] },
} as const

export function getNAIImageDimensions(
    size: Exclude<NAIImageSizePreset, 'custom'>,
    orientation: NAIImageOrientation,
): readonly [number, number] {
    if (orientation === 'square') return NAI_IMAGE_SIZE_BASE[size].square
    const [width, height] = NAI_IMAGE_SIZE_BASE[size].landscape
    return orientation === 'portrait' ? [height, width] : [width, height]
}

export interface ImageGenerationPresetSettings {
    sdProvider: ImageGenerationProvider
    NAIApiKey: string
    imageApiKeyRefs: Database['imageApiKeyRefs']
    NAIImgModel: string
    NAIImgConfig: NAIImgConfig
    NAIImgSizePreset: NAIImageSizePreset
    NAIImgOrientation: NAIImageOrientation
    NAII2I: boolean
    comfyUiUrl: string
    comfyConfig: Database['comfyConfig']
}

export interface NAIImageCoreSettings {
    NAIImgModel: string
    NAIImgSizePreset: NAIImageSizePreset
    NAIImgOrientation: NAIImageOrientation
    NAIImgConfig: Pick<
        NAIImgConfig,
        'width' | 'height' | 'sampler' | 'noise_schedule' | 'steps' | 'scale' | 'cfg_rescale'
    >
}

export function captureNAIImageCoreSettings(
    settings: ImageGenerationPresetSettings,
): NAIImageCoreSettings {
    const config = settings.NAIImgConfig
    return {
        NAIImgModel: settings.NAIImgModel,
        NAIImgSizePreset: settings.NAIImgSizePreset,
        NAIImgOrientation: settings.NAIImgOrientation,
        NAIImgConfig: {
            width: config.width,
            height: config.height,
            sampler: config.sampler,
            noise_schedule: config.noise_schedule,
            steps: config.steps,
            scale: config.scale,
            cfg_rescale: config.cfg_rescale,
        },
    }
}

export interface ImageGenerationPreset extends PresetTagFields {
    id: string
    name: string
    settings: ImageGenerationPresetSettings
}

interface ImageGenerationPresetLabels {
    defaultName: string
    fallbackName: (index: number) => string
}

type ImageGenerationPresetCollection = Pick<
    Database,
    'imageGenerationPresets' | 'imageGenerationPresetId'
>

export function appendImageGenerationPreset(
    db: ImageGenerationPresetCollection,
    preset: ImageGenerationPreset,
): number {
    const result = appendPresetItem(db.imageGenerationPresets, preset)
    db.imageGenerationPresets = result.items
    db.imageGenerationPresetId = result.selectedIndex
    return db.imageGenerationPresetId
}

export function duplicateImageGenerationPreset(
    db: ImageGenerationPresetCollection,
    index: number,
    copyLabel: string,
): ImageGenerationPreset | undefined {
    const result = duplicatePresetItem(db.imageGenerationPresets, index, source => {
        const preset = createImageGenerationPreset(`${source.name} ${copyLabel}`, source.settings)
        preset.tagIds = structuredClone(source.tagIds)
        return preset
    })
    if (!result.changed) return undefined
    db.imageGenerationPresets = result.items
    db.imageGenerationPresetId = result.selectedIndex
    return result.item
}

export function removeImageGenerationPreset(
    db: ImageGenerationPresetCollection,
    index: number,
): boolean {
    const result = removePresetItem(db.imageGenerationPresets, db.imageGenerationPresetId, index)
    if (!result.changed) return false
    db.imageGenerationPresets = result.items
    db.imageGenerationPresetId = result.selectedIndex
    return result.changed
}

export function moveImageGenerationPreset(
    db: ImageGenerationPresetCollection,
    fromIndex: number,
    toIndex: number,
): boolean {
    const result = movePresetItem(db.imageGenerationPresets, db.imageGenerationPresetId, fromIndex, toIndex)
    if (!result.changed) return false
    db.imageGenerationPresets = result.items
    db.imageGenerationPresetId = result.selectedIndex
    return result.changed
}

function removeEmbeddedReferenceImages(
    settings: ImageGenerationPresetSettings,
): ImageGenerationPresetSettings {
    delete settings.NAIImgConfig.base64image
    delete settings.NAIImgConfig.character_base64image
    return settings
}

type ImageGenerationDatabase = Pick<
    Database,
    | 'sdProvider'
    | 'NAIApiKey'
    | 'imageApiKeyRefs'
    | 'NAIImgModel'
    | 'NAIImgConfig'
    | 'NAII2I'
    | 'comfyUiUrl'
    | 'comfyConfig'
    | 'imageGenerationPresets'
    | 'imageGenerationPresetTags'
    | 'imageGenerationPresetId'
>

export function captureImageGenerationPresetSettings(
    db: ImageGenerationDatabase,
): ImageGenerationPresetSettings {
    return removeEmbeddedReferenceImages({
        sdProvider: normalizeImageGenerationProvider(db.sdProvider),
        NAIApiKey: db.NAIApiKey,
        imageApiKeyRefs: structuredClone(db.imageApiKeyRefs ?? {}),
        NAIImgModel: db.NAIImgModel,
        NAIImgConfig: structuredClone(db.NAIImgConfig),
        NAIImgSizePreset: 'custom',
        NAIImgOrientation: 'landscape',
        NAII2I: db.NAII2I,
        comfyUiUrl: db.comfyUiUrl,
        comfyConfig: structuredClone(db.comfyConfig),
    })
}

export function createImageGenerationPreset(
    name: string,
    settings: ImageGenerationPresetSettings,
): ImageGenerationPreset {
    return {
        id: createEntityId(),
        name,
        settings: removeEmbeddedReferenceImages(structuredClone(settings)),
    }
}

export function decodeImageGenerationPresetFile(
    data: Uint8Array,
    fallback: ImageGenerationPresetSettings,
    invalidMessage = 'Invalid image generation preset',
): ImageGenerationPreset {
    const container = JSON.parse(new TextDecoder().decode(data))
    const imported = container?.data
    if (container?.type !== 'risu-image-generation-preset'
        || typeof imported?.name !== 'string'
        || typeof imported?.settings?.sdProvider !== 'string'
        || typeof imported?.settings?.NAIImgConfig !== 'object'
        || typeof imported?.settings?.comfyConfig !== 'object') {
        throw new Error(invalidMessage)
    }
    const preset = createImageGenerationPreset(
        imported.name,
        normalizeImageGenerationPresetSettings(
            imported.settings as Partial<ImageGenerationPresetSettings>,
            fallback,
        ),
    )
    preset.tagIds = normalizeTagIds(imported.tagIds ?? imported.folderId)
    return preset
}

export function normalizeImageGenerationPresetSettings(
    value: Partial<ImageGenerationPresetSettings> | undefined,
    fallback: ImageGenerationPresetSettings,
): ImageGenerationPresetSettings {
    const normalized = {
        ...structuredClone(fallback),
        ...structuredClone(value ?? {}),
        sdProvider: normalizeImageGenerationProvider(value?.sdProvider),
        imageApiKeyRefs: structuredClone(value?.imageApiKeyRefs ?? fallback.imageApiKeyRefs),
        NAIImgConfig: {
            ...structuredClone(fallback.NAIImgConfig),
            ...structuredClone(value?.NAIImgConfig ?? {}),
        },
        NAIImgSizePreset: normalizeNAIImageSizePreset(value?.NAIImgSizePreset),
        NAIImgOrientation: normalizeNAIImageOrientation(value?.NAIImgOrientation),
        comfyConfig: {
            workflow: value?.comfyConfig?.workflow ?? fallback.comfyConfig.workflow,
            timeout: value?.comfyConfig?.timeout ?? fallback.comfyConfig.timeout,
        },
    }
    return removeEmbeddedReferenceImages(normalized)
}

export function normalizeImageGenerationPresetState(
    db: ImageGenerationDatabase,
    labels: ImageGenerationPresetLabels = {
        defaultName: 'Default',
        fallbackName: index => `Preset ${index + 1}`,
    },
): void {
    const currentSettings = captureImageGenerationPresetSettings(db)
    if (!Array.isArray(db.imageGenerationPresets) || db.imageGenerationPresets.length === 0) {
        db.imageGenerationPresets = [
            createImageGenerationPreset(labels.defaultName, currentSettings),
        ]
    } else {
        db.imageGenerationPresets = db.imageGenerationPresets.map((preset, index) => normalizePresetTagFields({
            ...preset,
            id: typeof preset?.id === 'string' && preset.id ? preset.id : createEntityId(),
            name: typeof preset?.name === 'string' && preset.name
                ? preset.name
                : labels.fallbackName(index),
            settings: normalizeImageGenerationPresetSettings(preset?.settings, currentSettings),
        }))
    }

    db.imageGenerationPresetTags ??= []
    const selectedIndex = Number.isInteger(db.imageGenerationPresetId)
        ? db.imageGenerationPresetId
        : 0
    db.imageGenerationPresetId = Math.min(
        Math.max(selectedIndex, 0),
        db.imageGenerationPresets.length - 1,
    )
    delete db.NAIImgConfig.base64image
    delete db.NAIImgConfig.character_base64image
}

export function getCurrentImageGenerationPreset(
    db: Pick<Database, 'imageGenerationPresets' | 'imageGenerationPresetId'>,
): ImageGenerationPreset {
    return db.imageGenerationPresets[db.imageGenerationPresetId]
        ?? db.imageGenerationPresets[0]
}
