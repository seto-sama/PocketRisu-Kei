'use strict';

const { applyPatch: applyJsonPatch } = require('fast-json-patch');
const { calculateHash, normalizeJSON } = require('./utils.cjs');
const { AppDataConflictError } = require('./appDataStore.cjs');
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
        this.currentHash = options.currentHash;
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

function replaceVisibleProjection(_current, incoming) {
    return incoming;
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

function compositionalHash(value) {
    return calculateHash(value).toString(16);
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

function filterPluginStorage(database, requestOptions = {}) {
    const exclusion = pluginStorageExclusion(database, requestOptions);
    if (!exclusion) {
        return database;
    }
    const filteredStorage = {};
    for (const [key, value] of Object.entries(database?.pluginCustomStorage ?? {})) {
        if (!pluginStorageKeyIsExcluded(database, key, exclusion)) {
            filteredStorage[key] = value;
        }
    }
    const filteredMeta = {};
    for (const [key, value] of Object.entries(database?.pluginStorageMeta ?? {})) {
        if (!pluginStorageKeyIsExcluded(database, key, exclusion)) filteredMeta[key] = value;
    }
    return {
        ...database,
        pluginCustomStorage: filteredStorage,
        pluginStorageMeta: filteredMeta,
    };
}

function restoreExcludedPluginStorage(incoming, canonical, requestOptions = {}) {
    const exclusion = pluginStorageExclusion(canonical, requestOptions);
    if (!exclusion) {
        return incoming;
    }
    const storage = { ...(incoming?.pluginCustomStorage ?? {}) };
    for (const [key, value] of Object.entries(canonical?.pluginCustomStorage ?? {})) {
        if (pluginStorageKeyIsExcluded(canonical, key, exclusion)) storage[key] = value;
    }
    const meta = { ...(incoming?.pluginStorageMeta ?? {}) };
    for (const [key, value] of Object.entries(canonical?.pluginStorageMeta ?? {})) {
        if (pluginStorageKeyIsExcluded(canonical, key, exclusion)) meta[key] = value;
    }
    return { ...incoming, pluginCustomStorage: storage, pluginStorageMeta: meta };
}

function createDatabaseProjectionService(options = {}) {
    const appDataStore = options.appDataStore ?? options.store;
    if (!appDataStore
        || typeof appDataStore.exportProjection !== 'function'
        || typeof appDataStore.getState !== 'function'
        || typeof appDataStore.projectionEtag !== 'function'
        || typeof appDataStore.replaceFromProjection !== 'function'
        || typeof appDataStore.syncStartupProjection !== 'function') {
        throw new TypeError('createDatabaseProjectionService requires an appDataStore');
    }

    const filterRemoteProjection = options.filterRemoteProjection
        ?? options.filterRemoteOnlyFolders
        ?? identity;
    const mergeRemoteProjection = options.mergeRemoteProjection
        ?? options.mergeRemoteFilteredDatabase
        ?? replaceVisibleProjection;
    const restoreServerOwnedMetadata = options.restoreServerOwnedMetadata
        ?? options.restoreGenerationOwnedMetadata
        ?? identity;
    for (const [name, callback] of [
        ['filterRemoteProjection', filterRemoteProjection],
        ['mergeRemoteProjection', mergeRemoteProjection],
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
            etag: typeof appDataStore.projectionEtagFor === 'function'
                ? appDataStore.projectionEtagFor(database)
                : appDataStore.projectionEtag(STARTUP_PROJECTION_OPTIONS),
            revision: state.revision,
            initialized: state.initialized,
            updatedAt: state.updatedAt,
        };
    }

    function visibleDatabase(snapshot, remote) {
        if (!remote) return snapshot.database;
        return normalizeProjection(filterRemoteProjection(snapshot.database));
    }

    function projectionVisibleToRequest(snapshot, requestOptions = {}) {
        return filterPluginStorage(
            visibleDatabase(snapshot, requestOptions.remote === true),
            requestOptions,
        );
    }

    function currentConflictDetails(requestOptions = {}) {
        const snapshot = canonicalSnapshot();
        const visible = projectionVisibleToRequest(snapshot, requestOptions);
        return {
            currentEtag: snapshot.etag,
            currentRevision: snapshot.revision,
            currentHash: compositionalHash(visible),
        };
    }

    function wrapStoreConflict(error, requestOptions, message = 'Database projection changed') {
        if (!(error instanceof AppDataConflictError)
            && error?.name !== 'AppDataConflictError') {
            throw error;
        }
        throw new DatabaseProjectionConflictError(message, {
            code: 'DATABASE_PROJECTION_CHANGED',
            ...currentConflictDetails(requestOptions),
            cause: error,
        });
    }

    /** Return the lightweight, chat-stub-only browser startup projection. */
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

    /**
     * Initialize only a pristine relational store. A second PUT is a conflict,
     * even when its body happens to match the first initialization.
     */
    function initializeDatabase(database, requestOptions = {}) {
        const remote = requestOptions.remote === true;
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
                    currentHash: compositionalHash(visibleDatabase(snapshot, remote)),
                },
            );
        }

        let incoming = normalizeProjection(database);
        try {
            if (remote && snapshot.initialized) {
                incoming = normalizeProjection(
                    mergeRemoteProjection(snapshot.database, incoming),
                );
            }
            if (snapshot.initialized) {
                incoming = normalizeProjection(
                    restoreServerOwnedMetadata(incoming, snapshot.database),
                );
            }
        } catch (error) {
            if (error instanceof DatabaseProjectionServiceError) throw error;
            throw new DatabaseProjectionApplyError(
                `Database initialization transform failed: ${error?.message ?? error}`,
                { code: 'DATABASE_INITIALIZATION_TRANSFORM_FAILED', cause: error },
            );
        }

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
                etag: appDataStore.projectionEtag(STARTUP_PROJECTION_OPTIONS),
            };
        } catch (error) {
            wrapStoreConflict(error, { remote }, 'Database changed during initialization');
        }

        return {
            success: true,
            changed: result.changed,
            etag: result.etag,
            revision: result.revision,
            updatedAt: result.updatedAt,
        };
    }

    /** Apply one optimistic JSON Patch commit to the startup projection. */
    function patchDatabase(request, requestOptions = {}) {
        if (!request || typeof request !== 'object' || Array.isArray(request)) {
            throw new DatabaseProjectionValidationError('Patch request must be an object');
        }
        const { patch, expectedHash } = request;
        if (!Array.isArray(patch)) {
            throw new DatabaseProjectionValidationError('patch must be an array');
        }
        if (typeof expectedHash !== 'string' || expectedHash.length === 0) {
            throw new DatabaseProjectionValidationError('expectedHash is required');
        }

        const remote = requestOptions.remote === true;
        const snapshot = canonicalSnapshot();
        const visible = projectionVisibleToRequest(snapshot, requestOptions);
        const currentHash = compositionalHash(visible);

        // JSON Patch identity has no write intent. In particular, a stale
        // expectedHash must not conflict with an unrelated server-owned write.
        if (patch.length === 0) {
            return {
                success: true,
                changed: false,
                appliedOperations: 0,
                etag: snapshot.etag,
                revision: snapshot.revision,
                updatedAt: snapshot.updatedAt,
            };
        }

        if (expectedHash !== currentHash) {
            throw new DatabaseProjectionConflictError(
                'Hash mismatch - data out of sync',
                {
                    code: 'DATABASE_HASH_MISMATCH',
                    currentEtag: snapshot.etag,
                    currentRevision: snapshot.revision,
                    currentHash,
                },
            );
        }

        let incoming;
        let appliedOperations;
        try {
            const patchTarget = structuredClone(visible);
            const result = applyJsonPatch(patchTarget, patch, true);
            appliedOperations = result.length;
            incoming = normalizeProjection(result.newDocument);
            if (remote) {
                incoming = normalizeProjection(
                    mergeRemoteProjection(snapshot.database, incoming),
                );
            }
            incoming = restoreExcludedPluginStorage(incoming, snapshot.database, requestOptions);
            incoming = normalizeProjection(
                restoreServerOwnedMetadata(incoming, snapshot.database),
            );
        } catch (error) {
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
            wrapStoreConflict(error, requestOptions);
        }

        return {
            success: true,
            changed: result.changed,
            appliedOperations,
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
    DatabaseProjectionApplyError,
    DatabaseProjectionConflictError,
    DatabaseProjectionServiceError,
    DatabaseProjectionValidationError,
    createDatabaseProjectionService,
};
