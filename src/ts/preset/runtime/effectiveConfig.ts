import type {
    ModelPreset,
    RegistryFieldSchema,
    RegistryFieldSemantic,
    RegistryMappingTarget,
} from '../types'

/**
 * Canonical value lookup for a snapshotted preset field.
 *
 * A present-but-undefined user value means "use the snapshotted default"; every
 * other present value (including false, 0, null, and an empty string) is kept.
 * Keeping this rule in one pure module prevents the editor, budget calculator,
 * and wire adapters from gradually acquiring different precedence rules.
 */
export function getEffectivePresetValue(
    preset: Pick<ModelPreset, 'profileSnapshot' | 'userValues'>,
    key: string,
): unknown {
    if (Object.prototype.hasOwnProperty.call(preset.userValues ?? {}, key)) {
        const value = preset.userValues?.[key]
        if (value !== undefined) return value
    }
    return preset.profileSnapshot.schema.find((field) => field.key === key)?.default
}

export function getEffectiveMappedValue(
    preset: Pick<ModelPreset, 'profileSnapshot' | 'userValues'>,
    target: RegistryMappingTarget,
    path: string,
): unknown {
    const field = preset.profileSnapshot.schema.find(
        (candidate) =>
            candidate.mapsTo?.target === target
            && candidate.mapsTo.path === path,
    )
    return field ? getEffectivePresetValue(preset, field.key) : undefined
}

/**
 * Resolve a field by its provider-independent meaning. The key fallback is
 * intentionally limited to fields without semantic metadata: once a profile
 * declares a semantic, that declaration is authoritative.
 */
export function findPresetFieldBySemantic(
    preset: Pick<ModelPreset, 'profileSnapshot'>,
    semantic: RegistryFieldSemantic,
    legacyKeys: readonly string[] = [],
): RegistryFieldSchema | undefined {
    const schema = preset.profileSnapshot.schema ?? []
    return schema.find((field) => field.semantic === semantic)
        ?? schema.find(
            (field) =>
                field.semantic === undefined
                && legacyKeys.includes(field.key),
        )
}

export function getEffectivePresetSemanticValue(
    preset: Pick<ModelPreset, 'profileSnapshot' | 'userValues'>,
    semantic: RegistryFieldSemantic,
    legacyKeys: readonly string[] = [],
): unknown {
    const field = findPresetFieldBySemantic(preset, semantic, legacyKeys)
    return field ? getEffectivePresetValue(preset, field.key) : undefined
}

export const OUTPUT_TOKEN_FIELD_KEYS = [
    'max_tokens',
    'maxTokens',
    'maxOutputTokens',
    'max_output_tokens',
    'max_completion_tokens',
] as const

export function isOutputTokenField(
    fieldOrKey: RegistryFieldSchema | string,
    mappedPath?: string,
): boolean {
    if (typeof fieldOrKey !== 'string' && fieldOrKey.semantic !== undefined) {
        return fieldOrKey.semantic === 'maxOutputTokens'
    }
    const key = typeof fieldOrKey === 'string' ? fieldOrKey : fieldOrKey.key
    const path = typeof fieldOrKey === 'string'
        ? mappedPath
        : fieldOrKey.mapsTo?.path
    return OUTPUT_TOKEN_FIELD_KEYS.some(
        (candidate) =>
            key === candidate
            || path === candidate
            || path?.endsWith(`.${candidate}`) === true,
    )
}

/**
 * Resolve the semantic output-token cap from the current snapshot shape.
 *
 * The snapshot is deliberately self-contained, so this function never consults
 * the live profile registry. New profiles declare the field's semantic
 * explicitly; wire-shaped legacy/custom snapshots continue to use the key/path
 * fallback.
 */
export function getPresetMaxOutputTokens(
    preset: Pick<ModelPreset, 'profileSnapshot' | 'userValues'>,
    defaultValue?: number,
): number | undefined {
    const schema = preset.profileSnapshot.schema ?? []
    const semanticFields = schema.filter(
        (field) => field.semantic === 'maxOutputTokens',
    )
    const semanticallyClaimedLegacyPaths = new Set(
        schema.flatMap((field) =>
            field.semantic !== undefined && field.semantic !== 'maxOutputTokens'
                ? [field.key, field.mapsTo?.path].filter(
                    (path): path is string => typeof path === 'string',
                )
                : [],
        ),
    )
    const outputPaths = new Set<string>(
        semanticFields.length > 0
            ? []
            : OUTPUT_TOKEN_FIELD_KEYS.filter(
                (path) => !semanticallyClaimedLegacyPaths.has(path),
            ),
    )
    const outputFields = semanticFields.length > 0
        ? semanticFields
        : schema.filter((field) => isOutputTokenField(field))

    for (const field of outputFields) {
        if (field.mapsTo?.path) outputPaths.add(field.mapsTo.path)

        const raw = Object.prototype.hasOwnProperty.call(preset.userValues ?? {}, field.key)
            ? preset.userValues?.[field.key]
            : (isPositiveNumber(defaultValue) ? defaultValue : field.default)
        if (isPositiveNumber(raw)) return raw
    }

    const defaults = preset.profileSnapshot.defaults
    if (defaults && typeof defaults === 'object') {
        for (const path of outputPaths) {
            const raw = getNestedValue(defaults, path)
            if (isPositiveNumber(raw)) return raw
        }
    }
    return undefined
}

export function getPresetModelIdValue(
    preset: Pick<ModelPreset, 'profileSnapshot' | 'userValues'>,
): unknown {
    const modelField = findPresetFieldBySemantic(
        preset,
        'modelId',
        ['modelId'],
    )
    if (modelField) {
        if (Object.prototype.hasOwnProperty.call(preset.userValues ?? {}, modelField.key)) {
            const userValue = preset.userValues?.[modelField.key]
            if (userValue !== undefined) return userValue
        }
        if (modelField.default !== undefined) return modelField.default
    }
    return preset.profileSnapshot.modelId
}

export function getNestedValue(
    source: Record<string, unknown>,
    path: string,
): unknown {
    if (!path.includes('.')) return source[path]
    let current: unknown = source
    for (const part of path.split('.')) {
        if (typeof current !== 'object' || current === null) return undefined
        current = (current as Record<string, unknown>)[part]
    }
    return current
}

export function isPositiveNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
}
