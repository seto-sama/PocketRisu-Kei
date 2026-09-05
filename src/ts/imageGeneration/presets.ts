import { v4 as uuidv4 } from 'uuid'
import { safeStructuredClone } from '../polyfill'
import type { Database, NAIImgConfig } from '../storage/database.svelte'
import { normalizePresetTagFields, normalizeTagIds, type PresetTagFields } from '../preset/tags'

export type NAIImageSizePreset = 'small' | 'normal' | 'large' | 'custom'
export type NAIImageOrientation = 'landscape' | 'portrait' | 'square'

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
    sdProvider: string
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
    db.imageGenerationPresets = [...db.imageGenerationPresets, preset]
    db.imageGenerationPresetId = db.imageGenerationPresets.length - 1
    return db.imageGenerationPresetId
}

export function duplicateImageGenerationPreset(
    db: ImageGenerationPresetCollection,
    index: number,
    copyLabel: string,
): ImageGenerationPreset | undefined {
    const source = db.imageGenerationPresets[index]
    if (!source) return undefined
    const preset = createImageGenerationPreset(`${source.name} ${copyLabel}`, source.settings)
    preset.tagIds = safeStructuredClone(source.tagIds)
    appendImageGenerationPreset(db, preset)
    return preset
}

export function removeImageGenerationPreset(
    db: ImageGenerationPresetCollection,
    index: number,
): boolean {
    if (db.imageGenerationPresets.length <= 1 || !db.imageGenerationPresets[index]) return false
    const selectedId = db.imageGenerationPresets[db.imageGenerationPresetId]?.id
    db.imageGenerationPresets = db.imageGenerationPresets.filter((_, presetIndex) => presetIndex !== index)
    const selectedIndex = db.imageGenerationPresets.findIndex(preset => preset.id === selectedId)
    db.imageGenerationPresetId = selectedIndex >= 0
        ? selectedIndex
        : Math.min(index, db.imageGenerationPresets.length - 1)
    return true
}

export function moveImageGenerationPreset(
    db: ImageGenerationPresetCollection,
    fromIndex: number,
    toIndex: number,
): boolean {
    const presets = db.imageGenerationPresets
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= presets.length || toIndex > presets.length) return false
    const selectedId = presets[db.imageGenerationPresetId]?.id
    const next = [...presets]
    const [moved] = next.splice(fromIndex, 1)
    if (!moved) return false
    const adjustedIndex = fromIndex < toIndex ? toIndex - 1 : toIndex
    next.splice(adjustedIndex, 0, moved)
    db.imageGenerationPresets = next
    db.imageGenerationPresetId = Math.max(0, next.findIndex(preset => preset.id === selectedId))
    return true
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
        sdProvider: db.sdProvider,
        NAIApiKey: db.NAIApiKey,
        imageApiKeyRefs: safeStructuredClone(db.imageApiKeyRefs ?? {}),
        NAIImgModel: db.NAIImgModel,
        NAIImgConfig: safeStructuredClone(db.NAIImgConfig),
        NAIImgSizePreset: 'custom',
        NAIImgOrientation: 'landscape',
        NAII2I: db.NAII2I,
        comfyUiUrl: db.comfyUiUrl,
        comfyConfig: safeStructuredClone(db.comfyConfig),
    })
}

export function createImageGenerationPreset(
    name: string,
    settings: ImageGenerationPresetSettings,
): ImageGenerationPreset {
    return {
        id: uuidv4(),
        name,
        settings: removeEmbeddedReferenceImages(safeStructuredClone(settings)),
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
        ...safeStructuredClone(fallback),
        ...safeStructuredClone(value ?? {}),
        imageApiKeyRefs: safeStructuredClone(value?.imageApiKeyRefs ?? fallback.imageApiKeyRefs),
        NAIImgConfig: {
            ...safeStructuredClone(fallback.NAIImgConfig),
            ...safeStructuredClone(value?.NAIImgConfig ?? {}),
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
            id: typeof preset?.id === 'string' && preset.id ? preset.id : uuidv4(),
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
