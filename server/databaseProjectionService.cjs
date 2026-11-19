'use strict';

const { compare } = require('fast-json-patch');
const { applyDelta, DeltaConflictError, DeltaValidationError } = require('../shared/guardedDelta.mjs');
const { normalizeJSON } = require('./utils/json.cjs');
const { AppDataConflictError } = require('./appDataStore.cjs');
const { EntityIdValidationError } = require('../shared/entityIds.mjs');
const { findChatInternalFieldOps } = require('../shared/chatShape.mjs');
const { apiErrorMessage, codes } = require('./utils/apiErrors.cjs');
const {
    classifiedPluginOwner,
    installedV3Plugins,
} = require('./pluginStorageProjection.cjs');

const STARTUP_PROJECTION_OPTIONS = Object.freeze({ includeMessages: false });

class DatabaseProjectionServiceError extends Error {
    constructor(message, options = {}) {
        super(message, options.cause ? { cause: options.cause } : undefined);
        this.name = 'DatabaseProjectionServiceError';
        this.code = options.code ?? 'DATABASE_PROJECTION_ERROR';
        this.statusCode = options.statusCode ?? 500;
        // Express integrations commonly inspect either spelling.
        this.status = this.statusCode;
    }
}

class DatabaseProjectionValidationError extends DatabaseProjectionServiceError {
    constructor(message, options = {}) {
        super(message, {
            ...options,
            code: options.code ?? 'INVALID_DATABASE_PROJECTION_REQUEST',
            statusCode: 400,
        });
        this.name = 'DatabaseProjectionValidationError';
    }
}

class DatabaseProjectionConflictError extends DatabaseProjectionServiceError {
    constructor(message, options = {}) {
        super(message, {
            ...options,
            code: options.code ?? 'DATABASE_PROJECTION_CONFLICT',
            statusCode: 409,
        });
        this.name = 'DatabaseProjectionConflictError';
        this.currentEtag = options.currentEtag;
        this.currentRevision = options.currentRevision;
        this.conflicts = options.conflicts;
    }
}

class DatabaseProjectionApplyError extends DatabaseProjectionServiceError {
    constructor(message, options = {}) {
        super(message, {
            ...options,
            code: options.code ?? 'DATABASE_PATCH_APPLY_FAILED',
            statusCode: 400,
        });
        this.name = 'DatabaseProjectionApplyError';
    }
}

function identity(value) {
    return value;
}

function isObjectProjection(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeProjection(value) {
    const normalized = normalizeJSON(value);
    if (!isObjectProjection(normalized)) {
        throw new DatabaseProjectionValidationError(
            'Database projection must be an object',
        );
    }
    return normalized;
}

function pluginStorageExclusion(database, requestOptions = {}) {
    const names = requestOptions.excludedPluginNames ?? [];
    if (!requestOptions.excludeAllPluginStorage
        && !requestOptions.excludeUnclassifiedPluginStorage && names.length === 0) {
        return null;
    }
    return {
        all: requestOptions.excludeAllPluginStorage === true,
        unclassified: requestOptions.excludeUnclassifiedPluginStorage === true,
        names: new Set(names),
        knownV3Names: installedV3Plugins(database?.plugins),
    };
}

function pluginStorageKeyIsExcluded(database, key, exclusion) {
    if (exclusion.all) return true;
    const owner = classifiedPluginOwner(database?.pluginStorageMeta, key, exclusion.knownV3Names);
    if (owner === null) return exclusion.unclassified;
    return exclusion.names.has(owner);
}

const PLUGIN_STORAGE_FIELDS = ['pluginCustomStorage', 'pluginStorageMeta'];

function filterPluginStorage(database, requestOptions = {}) {
    const exclusion = pluginStorageExclusion(database, requestOptions);
    if (!exclusion) return database;
    const filtered = { ...database };
    for (const field of PLUGIN_STORAGE_FIELDS) {
        filtered[field] = Object.fromEntries(Object.entries(database?.[field] ?? {})
            .filter(([key]) => !pluginStorageKeyIsExcluded(database, key, exclusion)));
    }
    return filtered;
}

function restoreExcludedPluginStorage(incoming, canonical, requestOptions = {}) {
    const exclusion = pluginStorageExclusion(canonical, requestOptions);
    if (!exclusion) return incoming;
    const restored = { ...incoming };
    for (const field of PLUGIN_STORAGE_FIELDS) {
        restored[field] = {
            ...(incoming?.[field] ?? {}),
            ...Object.fromEntries(Object.entries(canonical?.[field] ?? {})
                .filter(([key]) => pluginStorageKeyIsExcluded(canonical, key, exclusion))),
        };
    }
    return restored;
}

function createDatabaseProjectionService(options = {}) {
    const { appDataStore } = options;
    if (!appDataStore
        || typeof appDataStore.exportProjection !== 'function'
        || typeof appDataStore.getState !== 'function'
        || typeof appDataStore.replaceFromProjection !== 'function'
        || typeof appDataStore.syncStartupProjection !== 'function') {
        throw new TypeError('createDatabaseProjectionService requires an appDataStore');
    }

    const filterHiddenFolders = options.filterHiddenFolders ?? identity;
    const guardHiddenDelta = options.guardHiddenDelta ?? ((_database, changes) => changes);
    const restoreServerOwnedMetadata = options.restoreServerOwnedMetadata ?? identity;
    for (const [name, callback] of [
        ['filterHiddenFolders', filterHiddenFolders],
        ['guardHiddenDelta', guardHiddenDelta],
        ['restoreServerOwnedMetadata', restoreServerOwnedMetadata],
    ]) {
        if (typeof callback !== 'function') {
            throw new TypeError(`${name} must be a function`);
        }
    }

    function canonicalSnapshot() {
        // Reads, conflict recovery, and the storage CAS must share the same
        // durable pre-image. A process cache can miss independent chat commits
        // and otherwise keep returning a baseline that can never be saved.
        const database = appDataStore.exportProjection(STARTUP_PROJECTION_OPTIONS);
        const state = appDataStore.getState();
        return {
            database,
            etag: state.projectionEtag,
            revision: state.revision,
            initialized: state.initialized,
            updatedAt: state.updatedAt,
        };
    }

    function visibleDatabase(snapshot, hideFolders) {
        if (!hideFolders) return snapshot.database;
        return filterHiddenFolders(snapshot.database);
    }

    function projectionVisibleToRequest(snapshot, requestOptions = {}) {
        return filterPluginStorage(
            visibleDatabase(snapshot, requestOptions.hideFolders === true),
            requestOptions,
        );
    }

    function wrapStoreConflict(error, message = 'Database projection changed') {
        if (error instanceof EntityIdValidationError) {
            throw new DatabaseProjectionValidationError(error.message, { cause: error });
        }
        if (!(error instanceof AppDataConflictError)
            && error?.name !== 'AppDataConflictError') {
            throw error;
        }
        const state = appDataStore.getState();
        throw new DatabaseProjectionConflictError(message, {
            code: 'DATABASE_PROJECTION_CHANGED',
            currentEtag: state.projectionEtag,
            currentRevision: state.revision,
            cause: error,
        });
    }

    function getStartupProjection(requestOptions = {}) {
        const snapshot = canonicalSnapshot();
        return {
            database: snapshot.initialized
                ? projectionVisibleToRequest(snapshot, requestOptions)
                : null,
            etag: snapshot.etag,
            revision: snapshot.revision,
            initialized: snapshot.initialized,
            updatedAt: snapshot.updatedAt,
        };
    }

    // A second PUT is a conflict even when its body matches the first initialization.
    function initializeDatabase(database, requestOptions = {}) {
        const expectedRevision = requestOptions.expectedRevision ?? 0;
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
            throw new DatabaseProjectionValidationError(
                'expectedRevision must be a non-negative safe integer',
            );
        }

        const snapshot = canonicalSnapshot();
        if (snapshot.initialized || snapshot.revision !== expectedRevision) {
            throw new DatabaseProjectionConflictError(
                'Database is already initialized or its revision changed',
                {
                    code: snapshot.initialized
                        ? 'DATABASE_ALREADY_INITIALIZED'
                        : 'DATABASE_PROJECTION_CHANGED',
                    currentEtag: snapshot.etag,
                    currentRevision: snapshot.revision,
                },
            );
        }

        // A pristine store has no server-owned state to merge into.
        const incoming = normalizeProjection(database);

        let result;
        try {
            // Initialization is the only projection write that may legitimately
            // contain hydrated chats. A metadata sync would create empty bodies
            // for new rows and silently discard those messages, so install the
            // complete projection at this pristine-store boundary.
            appDataStore.replaceFromProjection(incoming, { expectedRevision });
            const state = appDataStore.getState();
            result = {
                changed: true,
                revision: state.revision,
                updatedAt: state.updatedAt,
                etag: state.projectionEtag,
            };
        } catch (error) {
            wrapStoreConflict(error, 'Database changed during initialization');
        }

        return {
            success: true,
            changed: result.changed,
            etag: result.etag,
            revision: result.revision,
            updatedAt: result.updatedAt,
        };
    }

    function patchDatabase(request, requestOptions = {}) {
        if (!request || typeof request !== 'object' || Array.isArray(request)) {
            throw new DatabaseProjectionValidationError('Patch request must be an object');
        }
        const { changes } = request;
        if (!Array.isArray(changes)) {
            throw new DatabaseProjectionValidationError('changes must be an array');
        }

        const hideFolders = requestOptions.hideFolders === true;
        const snapshot = canonicalSnapshot();

        if (changes.length === 0) {
            return {
                success: true,
                changed: false,
                appliedOperations: 0,
                etag: snapshot.etag,
                revision: snapshot.revision,
                updatedAt: snapshot.updatedAt,
            };
        }

        // A delta addresses array items by ID, so it applies to the unfiltered projection and
        // leaves hidden entries in place.
        const base = filterPluginStorage(snapshot.database, requestOptions);
        let incoming;
        try {
            const result = applyDelta(base, hideFolders ? guardHiddenDelta(snapshot.database, changes) : changes);
            if (findChatInternalFieldOps(compare(base, result)).length > 0) {
                throw new DatabaseProjectionConflictError(apiErrorMessage(codes.CHAT_GUARD_REJECTED), {
                    code: codes.CHAT_GUARD_REJECTED, currentEtag: snapshot.etag,
                    currentRevision: snapshot.revision,
                });
            }
            incoming = normalizeProjection(result);
            incoming = restoreExcludedPluginStorage(incoming, snapshot.database, requestOptions);
            incoming = normalizeProjection(
                restoreServerOwnedMetadata(incoming, snapshot.database),
            );
        } catch (error) {
            if (error instanceof DeltaConflictError) {
                throw new DatabaseProjectionConflictError('Database fields changed concurrently', {
                    currentEtag: snapshot.etag, currentRevision: snapshot.revision,
                    conflicts: error.conflicts.map(item => item.change.path),
                });
            }
            if (error instanceof DeltaValidationError) {
                throw new DatabaseProjectionValidationError(error.message);
            }
            if (error instanceof DatabaseProjectionServiceError) throw error;
            throw new DatabaseProjectionApplyError(
                `Patch application failed: ${error?.message ?? error}`,
                { cause: error },
            );
        }

        let result;
        try {
            result = appDataStore.syncStartupProjection(incoming, {
                expectedEtag: snapshot.etag,
            });
        } catch (error) {
            wrapStoreConflict(error);
        }

        return {
            success: true,
            changed: result.changed,
            appliedOperations: changes.length,
            etag: result.etag,
            revision: result.revision,
            updatedAt: result.updatedAt,
        };
    }

    return {
        getStartupProjection,
        initializeDatabase,
        patchDatabase,
    };
}

module.exports = {
    DatabaseProjectionConflictError,
    DatabaseProjectionServiceError,
    DatabaseProjectionValidationError,
    createDatabaseProjectionService,
};
