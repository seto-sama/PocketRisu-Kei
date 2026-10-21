import type { ModelProfile, RegistryFieldSchema } from './types'

/** Helpers for profile update status and schema-aware user-value migration. */
export type ProfileUpdateStatus = 'none' | 'updatable' | 'missing'

/** Compare the saved profile revision with the current registry revision. */
export function getProfileUpdateStatus(
    current: ModelProfile | undefined,
    recordedUpdatedAt: number | undefined,
): ProfileUpdateStatus {
    if (!current) return 'missing'
    if (
        recordedUpdatedAt !== undefined
        && current.updatedAt !== undefined
        && current.updatedAt > recordedUpdatedAt
    ) {
        return 'updatable'
    }
    return 'none'
}

export interface MigrateUserValuesOptions {
    /** When supplied, values whose field type changed are dropped as incompatible. */
    currentSchema?: RegistryFieldSchema[]
    /** Profile replacement seeds defaults; snapshot repair/update leaves them implicit. */
    seedDefaults?: boolean
}

/** Keep compatible user values and optionally seed defaults for new fields. */
export function migrateUserValues(
    oldValues: Record<string, unknown> | undefined,
    newSchema: RegistryFieldSchema[],
    options: MigrateUserValuesOptions = {},
): { values: Record<string, unknown>; droppedKeys: string[] } {
    const newByKey = new Map(newSchema.map((f) => [f.key, f]))
    const currentByKey = new Map((options.currentSchema ?? []).map((f) => [f.key, f]))
    const values: Record<string, unknown> = {}
    const droppedKeys: string[] = []
    for (const [k, v] of Object.entries(oldValues ?? {})) {
        const nextField = newByKey.get(k)
        const currentField = currentByKey.get(k)
        if (!nextField || (currentField && currentField.type !== nextField.type)) {
            droppedKeys.push(k)
            continue
        }
        values[k] = v
    }
    if (options.seedDefaults !== false) {
        for (const f of newSchema) {
            if (f.default !== undefined && !(f.key in values)) values[f.key] = f.default
        }
    }
    return { values, droppedKeys }
}
