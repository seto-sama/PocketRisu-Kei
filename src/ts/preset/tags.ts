export interface PresetTag {
    id: string
    name: string
}

export interface PresetTagFields {
    tagIds?: string[]
}

type LegacyPresetTagFields = PresetTagFields & {
    folderId?: unknown
}

export function normalizeTagIds(value: unknown): string[] | undefined {
    const values = typeof value === 'string'
        ? [value]
        : Array.isArray(value)
            ? value
            : []
    const normalized = [...new Set(values.filter((id): id is string => typeof id === 'string' && id.length > 0))]
    return normalized.length > 0 ? normalized : undefined
}

/** Normalize legacy folder membership once when data enters the application. */
export function normalizePresetTagFields<T extends object>(value: T): T & PresetTagFields {
    const fields = value as T & LegacyPresetTagFields
    const tagIds = normalizeTagIds(fields.tagIds ?? fields.folderId)
    if (tagIds) fields.tagIds = tagIds
    else delete fields.tagIds
    delete fields.folderId
    return fields
}

export function addPresetTag(tagIds: string[] | undefined, tagId: string | undefined): string[] | undefined {
    if (!tagId) return undefined
    return normalizeTagIds([...(tagIds ?? []), tagId])
}

export function removePresetTag(tagIds: string[] | undefined, tagId: string): string[] | undefined {
    return normalizeTagIds((tagIds ?? []).filter(id => id !== tagId))
}

export function togglePresetTag(tagIds: string[] | undefined, tagId: string | undefined): string[] | undefined {
    if (!tagId) return undefined
    return tagIds?.includes(tagId)
        ? removePresetTag(tagIds, tagId)
        : addPresetTag(tagIds, tagId)
}

export function normalizePresetTagBindings(value: unknown): Record<string, string[]> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(
        Object.entries(value)
            .map(([id, tagIds]) => [id, normalizeTagIds(tagIds)] as const)
            .filter((entry): entry is readonly [string, string[]] => !!entry[1]),
    )
}

const LEGACY_TAG_COLLECTIONS = [
    ['promptPresetTags', 'promptPresetFolders'],
    ['themePresetTags', 'themePresetFolders'],
    ['imageGenerationPresetTags', 'imageGenerationPresetFolders'],
    ['imageStylePresetTags', 'imageStylePresetFolders'],
    ['translatorPresetTags', 'translatorPresetFolders'],
    ['hypaV3PresetTags', 'hypaV3PresetFolders'],
    ['modelPresetTags', 'modelPresetFolders'],
    ['personaTags', 'personaFolders'],
    ['moduleTags', 'moduleFolders'],
] as const

/** Convert legacy folder-shaped organization data at a database boundary. */
export function normalizePresetTagState(value: object): void {
    const target = value as Record<string, unknown>
    for (const [tagKey, folderKey] of LEGACY_TAG_COLLECTIONS) {
        const current = target[tagKey]
        const legacy = target[folderKey]
        target[tagKey] = Array.isArray(current) ? current : Array.isArray(legacy) ? legacy : []
        delete target[folderKey]
    }

    for (const key of [
        'botPresets',
        'themePresets',
        'imageGenerationPresets',
        'translatorPresets',
        'hypaV3Presets',
        'modelPresets',
        'personas',
        'modules',
    ]) {
        const collection = target[key]
        if (!Array.isArray(collection)) continue
        for (const item of collection) {
            if (item && typeof item === 'object') normalizePresetTagFields(item)
        }
    }

    target.imageStylePresetTagBindings = normalizePresetTagBindings(
        target.imageStylePresetTagBindings ?? target.imageStylePresetFolderBindings,
    )
    delete target.imageStylePresetFolderBindings
}
