import { v4 as uuidv4 } from 'uuid'

export class EntityIdValidationError extends Error {
    constructor(message) {
        super(message)
        this.name = 'EntityIdValidationError'
    }
}

export function createEntityId() {
    return uuidv4()
}

function collectIds(items, key, allowMissing) {
    if (!Array.isArray(items)) throw new EntityIdValidationError('Expected an entity array')
    const ids = new Set()
    for (const item of items) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            throw new EntityIdValidationError('Expected an entity object')
        }
        const id = item[key]
        if (allowMissing && (id == null || id === '')) continue
        if (typeof id !== 'string' || !id) {
            throw new EntityIdValidationError(`Entity ${key} must be a non-empty string`)
        }
        if (ids.has(id)) throw new EntityIdValidationError(`Duplicate entity ID: ${id}`)
        ids.add(id)
    }
    return ids
}

export function assertUniqueEntityIds(items, key = 'id') {
    collectIds(items, key, false)
}

export function ensureUniqueEntityIds(items, createId = createEntityId, key = 'id') {
    const ids = collectIds(items, key, true)
    for (const item of items) {
        if (item[key]) continue
        let id = createId()
        while (ids.has(id)) id = createId()
        item[key] = id
        ids.add(id)
    }
}

const presetCollections = [
    'botPresets', 'themePresets', 'imageGenerationPresets', 'translatorPresets',
    'hypaV3Presets', 'modelPresets', 'ttsPresets', 'personas',
]

export function ensureDatabasePresetIds(database) {
    for (const field of presetCollections) {
        if (database?.[field] == null) continue
        try {
            ensureUniqueEntityIds(database[field])
        } catch (error) {
            if (error instanceof EntityIdValidationError) error.message = `${field}: ${error.message}`
            throw error
        }
    }
    return database
}
