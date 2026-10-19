import { ensureDatabasePresetIds } from './entityIds.mjs'

function isDatabaseObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasSelectionFields(database) {
    return Object.hasOwn(database, 'activePromptPresetId') || Object.hasOwn(database, 'botPresetsId')
}

// Numeric selection is interpreted at import boundaries, never during runtime normalization.
export function normalizePromptPresetSelection(database) {
    if (!isDatabaseObject(database)) return database

    const hasPresets = Array.isArray(database.botPresets)
    if (!hasPresets && !hasSelectionFields(database)) return database

    const presets = hasPresets ? database.botPresets : []
    if (!Object.hasOwn(database, 'activePromptPresetId')) {
        database.activePromptPresetId = presets[0]?.id ?? ''
    } else if (
        typeof database.activePromptPresetId !== 'string'
        || (database.activePromptPresetId !== ''
            && !presets.some(preset => preset?.id === database.activePromptPresetId))
    ) {
        database.activePromptPresetId = ''
    }

    delete database.botPresetsId
    return database
}

export function importPromptPresetSelection(database) {
    if (!isDatabaseObject(database) || !hasSelectionFields(database)) return database

    if (Array.isArray(database.botPresets)) ensureDatabasePresetIds(database)

    if (!Object.hasOwn(database, 'activePromptPresetId')) {
        const legacyIndex = database.botPresetsId
        database.activePromptPresetId = Number.isInteger(legacyIndex)
            ? database.botPresets?.[legacyIndex]?.id ?? ''
            : ''
    }

    return normalizePromptPresetSelection(database)
}

export function exportPromptPresetSelection(database) {
    if (!isDatabaseObject(database) || !Object.hasOwn(database, 'activePromptPresetId')) return database

    const result = { ...database }
    const activeId = database.activePromptPresetId
    const index = typeof activeId === 'string' && activeId !== '' && Array.isArray(database.botPresets)
        ? database.botPresets.findIndex(preset => preset?.id === activeId)
        : -1
    delete result.activePromptPresetId
    result.botPresetsId = index
    return result
}
