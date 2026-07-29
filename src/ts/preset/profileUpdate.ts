import { resolveSnapshot } from './registry/snapshot'
import { migrateUserValues } from './customProfiles'
import type {
    ModelPreset,
    ModelPresetSourceProfile,
    ModelProfile,
    OrphanedUserValue,
    ProfileSnapshotUpdateResult,
    RegistryAuth,
    RegistryCache,
    RegistryEndpoint,
    RegistryFieldSchema,
    RegistryUiField,
    RegistryUiSchema,
    ResolvedModelProfileSnapshot,
    SnapshotDiff,
    SnapshotSchemaFieldChange,
    SnapshotUiFieldChange,
    SnapshotUiGroupChange,
} from './types'

export interface ProfileUpdateOptions {
    now?: () => number
}

export type ModelPresetAbilityDefaults = Partial<Pick<
    ModelPreset,
    'foldSystemPrompt'
    | 'keepFirstSystemPrompt'
    | 'alternateRole'
    | 'startWithUserInput'
>>

export interface ProfileSnapshotUpdateOptions extends ProfileUpdateOptions {
    sourceProfile?: ModelPresetSourceProfile
}

export interface ModelPresetProfileTarget {
    registry: RegistryCache
    registryId: string
    profileId: string
    /** Transient profiles (currently Plugin API 3.0) remain self-contained. */
    transient?: boolean
}

/** Compatibility name retained for the existing bulk-refresh caller. */
export type ModelPresetProfileRefreshTarget = ModelPresetProfileTarget

export interface ModelPresetProfileRefreshResult {
    preset: ModelPreset
    droppedKeys: string[]
}

export interface CreateModelPresetFromProfileOptions extends ProfileUpdateOptions {
    id: string
    name?: string
    apiKeyRef?: string
    abilityDefaults?: ModelPresetAbilityDefaults
}

export interface ReplaceModelPresetProfileOptions extends ProfileUpdateOptions {
    abilityDefaults?: ModelPresetAbilityDefaults
}

interface ResolvedProfileTarget {
    profile: ModelProfile
    snapshot: ResolvedModelProfileSnapshot
}

/**
 * A persisted preset must be self-contained enough to render its form and
 * dispatch a request without consulting the source registry again.
 */
export function isUsableModelProfileSnapshot(
    snapshot: ResolvedModelProfileSnapshot | null | undefined,
): boolean {
    return !!snapshot
        && !!snapshot.auth
        && !!snapshot.endpoint
        && Array.isArray(snapshot.schema)
        && Array.isArray(snapshot.uiSchema?.groups)
        && Array.isArray(snapshot.uiSchema?.fields)
}

/**
 * Create a self-contained preset from a registry profile. Registry metadata is
 * retained only as an optional update pointer; transient plugin profiles stay
 * snapshot-only.
 */
export function createModelPresetFromProfile(
    target: ModelPresetProfileTarget,
    options: CreateModelPresetFromProfileOptions,
): ModelPreset | undefined {
    const resolved = resolveProfileTarget(target)
    if (!resolved || !isUsableModelProfileSnapshot(resolved.snapshot)) return undefined

    const updatedAt = (options.now ?? Date.now)()
    const { values } = migrateUserValues(undefined, resolved.snapshot.schema)

    return {
        ...options.abilityDefaults,
        id: options.id,
        name: options.name ?? resolved.profile.displayName,
        profileSnapshot: resolved.snapshot,
        sourceProfile: buildSourceProfile(target, resolved, updatedAt),
        userValues: values,
        apiKeyRef: options.apiKeyRef,
        createdAt: updatedAt,
        updatedAt,
    }
}

/**
 * Replace or refresh a preset profile through the same migration path. The
 * caller decides whether to ask for confirmation before committing the pure
 * result.
 */
export function replaceModelPresetProfile(
    preset: ModelPreset,
    target: ModelPresetProfileTarget,
    options: ReplaceModelPresetProfileOptions = {},
): ModelPresetProfileRefreshResult | undefined {
    const resolved = resolveProfileTarget(target)
    if (!resolved || !isUsableModelProfileSnapshot(resolved.snapshot)) return undefined

    const { values, droppedKeys } = migrateUserValues(
        preset.userValues,
        resolved.snapshot.schema,
        {
            currentSchema: Array.isArray(preset.profileSnapshot?.schema)
                ? preset.profileSnapshot.schema.filter(Boolean)
                : [],
        },
    )
    const updatedAt = (options.now ?? Date.now)()
    const orphanValues = preserveDroppedUserValues(preset, droppedKeys)

    return {
        preset: {
            ...preset,
            ...options.abilityDefaults,
            profileSnapshot: resolved.snapshot,
            sourceProfile: buildSourceProfile(target, resolved, updatedAt),
            userValues: values,
            orphanValues,
            updatedAt,
        },
        droppedKeys,
    }
}

export function diffProfileSnapshot(
    current: ResolvedModelProfileSnapshot | null | undefined,
    latest: ResolvedModelProfileSnapshot,
): SnapshotDiff {
    const currentSchema = Array.isArray(current?.schema)
        ? current.schema.filter(Boolean)
        : []
    const currentUiSchema: RegistryUiSchema = {
        groups: Array.isArray(current?.uiSchema?.groups)
            ? current.uiSchema.groups.filter(Boolean)
            : [],
        fields: Array.isArray(current?.uiSchema?.fields)
            ? current.uiSchema.fields.filter(Boolean)
            : [],
    }
    return {
        profileId: latest.profileId,
        providerBaseChanged: current?.providerBaseId !== latest.providerBaseId,
        adapterKindChanged: current?.adapterKind !== latest.adapterKind,
        modelIdChanged: current?.modelId !== latest.modelId,
        endpointChanged: !endpointEqual(current?.endpoint, latest.endpoint),
        authChanged: !authEqual(current?.auth, latest.auth),
        capabilitiesChanged: !arrayEqual(current?.capabilities, latest.capabilities),
        defaultsChanged: !deepEqual(current?.defaults, latest.defaults),
        bodyTemplateChanged: !deepEqual(current?.bodyTemplate, latest.bodyTemplate),
        headerTemplateChanged: !deepEqual(current?.headerTemplate, latest.headerTemplate),
        schemaChanges: diffSchemaFields(currentSchema, latest.schema),
        uiSchemaFieldChanges: diffUiFields(currentUiSchema, latest.uiSchema),
        uiSchemaGroupChanges: diffUiGroups(currentUiSchema, latest.uiSchema),
    }
}

export function applyProfileSnapshotUpdate(
    preset: ModelPreset,
    latestSnapshot: ResolvedModelProfileSnapshot,
    options: ProfileSnapshotUpdateOptions = {},
): ProfileSnapshotUpdateResult {
    const now = options.now ?? Date.now
    const updatedAt = now()
    const diff = diffProfileSnapshot(preset.profileSnapshot, latestSnapshot)

    const currentSchema = Array.isArray(preset.profileSnapshot?.schema)
        ? preset.profileSnapshot.schema.filter(Boolean)
        : []
    const currentSchemaByKey = new Map(currentSchema.map((f) => [f.key, f]))
    const latestSchemaByKey = new Map(latestSnapshot.schema.map((f) => [f.key, f]))
    const { values: nextUserValues, droppedKeys } = migrateUserValues(
        preset.userValues,
        latestSnapshot.schema,
        {
            currentSchema,
            // Snapshot updates preserve the historical behaviour of exposing
            // new fields without materialising their defaults into userValues.
            seedDefaults: false,
        },
    )
    const droppedKeySet = new Set(droppedKeys)
    const movedToOrphan: OrphanedUserValue[] = []

    for (const [key, value] of Object.entries(preset.userValues ?? {})) {
        if (!droppedKeySet.has(key)) continue
        const latestField = latestSchemaByKey.get(key)
        if (!latestField) {
            movedToOrphan.push({ key, value, reason: 'removed' })
            continue
        }
        movedToOrphan.push({ key, value, reason: 'type-changed' })
    }

    const newFieldKeys: string[] = []
    for (const key of latestSchemaByKey.keys()) {
        if (!currentSchemaByKey.has(key)) newFieldKeys.push(key)
    }

    const orphanValues = preserveDroppedUserValues(preset, droppedKeys)

    let sourceProfile: ModelPresetSourceProfile | undefined
    if (options.sourceProfile) {
        sourceProfile = options.sourceProfile
    } else if (preset.sourceProfile && preset.sourceProfile.profileId === latestSnapshot.profileId) {
        sourceProfile = {
            ...preset.sourceProfile,
            fetchedAt: updatedAt,
        }
    }

    const nextPreset: ModelPreset = {
        ...preset,
        profileSnapshot: latestSnapshot,
        sourceProfile,
        userValues: nextUserValues,
        orphanValues,
        updatedAt,
    }

    return {
        preset: nextPreset,
        diff,
        movedToOrphan,
        newFieldKeys,
    }
}

/**
 * Re-resolve a preset from its current registry profile without comparing
 * profile/base versions first. This is deliberately a force-refresh path:
 * presentation-only schema changes may ship without a version bump.
 */
export function refreshModelPresetProfile(
    preset: ModelPreset,
    target: ModelPresetProfileRefreshTarget,
    options: ProfileUpdateOptions = {},
): ModelPresetProfileRefreshResult | undefined {
    return replaceModelPresetProfile(preset, target, options)
}

function resolveProfileTarget(
    target: ModelPresetProfileTarget,
): ResolvedProfileTarget | undefined {
    const entry = target.registry.registries[target.registryId]
    const profile = entry?.profiles?.[target.profileId]
    if (!entry || !profile) return undefined

    return {
        profile,
        snapshot: resolveSnapshot({
            schemaVersion: target.registry.schemaVersion,
            registries: { [target.registryId]: entry },
        }, target.profileId),
    }
}

function buildSourceProfile(
    target: ModelPresetProfileTarget,
    resolved: ResolvedProfileTarget,
    fetchedAt: number,
): ModelPresetSourceProfile | undefined {
    if (target.transient) return undefined
    return {
        registryId: target.registryId,
        profileId: resolved.snapshot.profileId,
        fetchedAt,
        profileUpdatedAt: resolved.profile.updatedAt,
    }
}

function preserveDroppedUserValues(
    preset: ModelPreset,
    droppedKeys: readonly string[],
): Record<string, unknown> | undefined {
    const orphanValues = { ...(preset.orphanValues ?? {}) }
    for (const key of droppedKeys) {
        if (Object.prototype.hasOwnProperty.call(preset.userValues ?? {}, key)) {
            orphanValues[key] = preset.userValues[key]
        }
    }
    return Object.keys(orphanValues).length > 0 ? orphanValues : undefined
}

function diffSchemaFields(
    current: RegistryFieldSchema[],
    latest: RegistryFieldSchema[],
): SnapshotSchemaFieldChange[] {
    const currentByKey = new Map(current.map((f) => [f.key, f]))
    const latestByKey = new Map(latest.map((f) => [f.key, f]))
    const changes: SnapshotSchemaFieldChange[] = []

    for (const field of latest) {
        if (!currentByKey.has(field.key)) {
            changes.push({ key: field.key, changeKind: 'added' })
        }
    }
    for (const field of current) {
        if (!latestByKey.has(field.key)) {
            changes.push({ key: field.key, changeKind: 'removed' })
        }
    }
    for (const [key, latestField] of latestByKey) {
        const currentField = currentByKey.get(key)
        if (!currentField) continue
        const change = compareSchemaField(currentField, latestField)
        if (change) changes.push(change)
    }
    return changes
}

function compareSchemaField(
    a: RegistryFieldSchema,
    b: RegistryFieldSchema,
): SnapshotSchemaFieldChange | null {
    const modified: string[] = []
    const typeChanged = a.type !== b.type
    if (typeChanged) modified.push('type')
    if (a.label !== b.label) modified.push('label')
    if (a.description !== b.description) modified.push('description')
    if (!deepEqual(a.default, b.default)) modified.push('default')
    if (!deepEqual(a.enum, b.enum)) modified.push('enum')
    if (a.min !== b.min) modified.push('min')
    if (a.max !== b.max) modified.push('max')
    if (a.step !== b.step) modified.push('step')
    if ((a.required ?? false) !== (b.required ?? false)) modified.push('required')
    if ((a.secret ?? false) !== (b.secret ?? false)) modified.push('secret')
    if (a.semantic !== b.semantic) modified.push('semantic')
    if (!deepEqual(a.mapsTo, b.mapsTo)) modified.push('mapsTo')
    if (modified.length === 0) return null
    return {
        key: a.key,
        changeKind: 'modified',
        fromType: typeChanged ? a.type : undefined,
        toType: typeChanged ? b.type : undefined,
        modifiedAttributes: modified,
    }
}

function diffUiFields(
    current: RegistryUiSchema,
    latest: RegistryUiSchema,
): SnapshotUiFieldChange[] {
    const currentByKey = new Map(current.fields.map((f) => [f.key, f]))
    const latestByKey = new Map(latest.fields.map((f) => [f.key, f]))
    const changes: SnapshotUiFieldChange[] = []

    for (const field of latest.fields) {
        if (!currentByKey.has(field.key)) {
            changes.push({ key: field.key, changeKind: 'added' })
        }
    }
    for (const field of current.fields) {
        if (!latestByKey.has(field.key)) {
            changes.push({ key: field.key, changeKind: 'removed' })
        }
    }
    for (const [key, latestField] of latestByKey) {
        const currentField = currentByKey.get(key)
        if (!currentField) continue
        const change = compareUiField(currentField, latestField)
        if (change) changes.push(change)
    }
    return changes
}

function compareUiField(
    a: RegistryUiField,
    b: RegistryUiField,
): SnapshotUiFieldChange | null {
    const modified: string[] = []
    if (a.widget !== b.widget) modified.push('widget')
    if (a.visibility !== b.visibility) modified.push('visibility')
    if (a.group !== b.group) modified.push('group')
    if (a.order !== b.order) modified.push('order')
    if (a.placeholder !== b.placeholder) modified.push('placeholder')
    if (a.help !== b.help) modified.push('help')
    if (!deepEqual(a.showIf, b.showIf)) modified.push('showIf')
    if (modified.length === 0) return null
    return { key: a.key, changeKind: 'modified', modifiedAttributes: modified }
}

function diffUiGroups(
    current: RegistryUiSchema,
    latest: RegistryUiSchema,
): SnapshotUiGroupChange[] {
    const currentById = new Map(current.groups.map((g) => [g.id, g]))
    const latestById = new Map(latest.groups.map((g) => [g.id, g]))
    const changes: SnapshotUiGroupChange[] = []

    for (const group of latest.groups) {
        if (!currentById.has(group.id)) {
            changes.push({ id: group.id, changeKind: 'added' })
        }
    }
    for (const group of current.groups) {
        if (!latestById.has(group.id)) {
            changes.push({ id: group.id, changeKind: 'removed' })
        }
    }
    for (const [id, latestGroup] of latestById) {
        const currentGroup = currentById.get(id)
        if (!currentGroup) continue
        if (currentGroup.label !== latestGroup.label || currentGroup.order !== latestGroup.order) {
            changes.push({ id, changeKind: 'modified' })
        }
    }
    return changes
}

function endpointEqual(
    a: RegistryEndpoint | null | undefined,
    b: RegistryEndpoint | null | undefined,
): boolean {
    if (!a || !b) return a === b
    return a.kind === b.kind && a.url === b.url && a.path === b.path
}

function authEqual(
    a: RegistryAuth | null | undefined,
    b: RegistryAuth | null | undefined,
): boolean {
    if (!a || !b) return a === b
    if (a.kind !== b.kind) return false
    return arrayEqual(a.fields, b.fields)
}

function arrayEqual(a: readonly unknown[] | undefined, b: readonly unknown[] | undefined): boolean {
    if (a === b) return true
    if (!a || !b) return false
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
        if (!deepEqual(a[i], b[i])) return false
    }
    return true
}

function deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true
    if (a === undefined || b === undefined) return a === b
    if (a === null || b === null) return a === b
    if (typeof a !== typeof b) return false
    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b)) return false
        return arrayEqual(a, b)
    }
    if (typeof a === 'object' && typeof b === 'object') {
        const aKeys = Object.keys(a as Record<string, unknown>)
        const bKeys = Object.keys(b as Record<string, unknown>)
        if (aKeys.length !== bKeys.length) return false
        for (const key of aKeys) {
            if (!Object.prototype.hasOwnProperty.call(b, key)) return false
            if (!deepEqual(
                (a as Record<string, unknown>)[key],
                (b as Record<string, unknown>)[key],
            )) return false
        }
        return true
    }
    return false
}
