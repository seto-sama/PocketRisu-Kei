'use strict';

const crypto = require('crypto');

const LEGACY_DATABASE_KEY = 'database/database.bin';
const LEGACY_DATABASE_MIGRATION_KEY = 'legacy-database-bin-to-app-data-v1';

class AppDataMigrationError extends Error {
    constructor(message, options = {}) {
        super(message, options.cause ? { cause: options.cause } : undefined);
        this.name = 'AppDataMigrationError';
        this.code = options.code;
    }
}

class AppDataMigrationVerificationError extends AppDataMigrationError {
    constructor(expectedHash, actualHash) {
        super('Relational app data did not match the decoded legacy projection', {
            code: 'APP_DATA_MIGRATION_VERIFICATION_FAILED',
        });
        this.name = 'AppDataMigrationVerificationError';
        this.expectedHash = expectedHash;
        this.actualHash = actualHash;
    }
}

class AppDataMigrationCleanupError extends AppDataMigrationError {
    constructor(cause, migrationResult) {
        super('Relational app data is installed, but the legacy database blob could not be removed', {
            cause,
            code: 'APP_DATA_MIGRATION_CLEANUP_PENDING',
        });
        this.name = 'AppDataMigrationCleanupError';
        this.migrationResult = migrationResult;
    }
}

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function asBuffer(value) {
    if (Buffer.isBuffer(value)) return Buffer.from(value);
    if (value instanceof ArrayBuffer) return Buffer.from(value);
    if (ArrayBuffer.isView(value)) {
        return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    }
    throw new TypeError('Legacy database storage must return a Buffer or Uint8Array');
}

function sortedJsonValue(value, ancestors = new Set()) {
    if (value === null || typeof value !== 'object') return value;
    if (ancestors.has(value)) {
        throw new TypeError('Database projection contains a circular reference');
    }

    ancestors.add(value);
    try {
        if (Array.isArray(value)) {
            return value.map(item => sortedJsonValue(item, ancestors));
        }
        const result = {};
        for (const key of Object.keys(value).sort()) {
            result[key] = sortedJsonValue(value[key], ancestors);
        }
        return result;
    } finally {
        ancestors.delete(value);
    }
}

/**
 * Hash the JSON meaning of a projection. Object insertion order is ignored;
 * array order and the distinction between missing, null, false, zero, and an
 * empty string are retained.
 */
function semanticProjectionHash(value) {
    const serialized = JSON.stringify(sortedJsonValue(value));
    if (serialized === undefined) {
        throw new TypeError('Database projection is not JSON serializable');
    }
    return sha256(Buffer.from(serialized));
}

function assertSyncNormalized(normalizeProjection, value) {
    const normalized = normalizeProjection(value);
    if (normalized && typeof normalized.then === 'function') {
        throw new TypeError('normalizeProjection must be synchronous');
    }
    if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) {
        throw new TypeError('normalizeProjection must return a database object');
    }
    return normalized;
}

/**
 * Create the one-time migration barrier between the legacy opaque database
 * blob and the relational app-data store.
 *
 * decodeLegacyBlob may be asynchronous. normalizeProjection deliberately may
 * not: it is also run against the installed projection while the SQLite
 * verification transaction is open. kv.get/delete must address the same
 * durable SQLite-backed storage as db so callers cannot accidentally point the
 * migration at a different database.
 */
function createAppDataMigration(options) {
    const {
        db,
        appDataStore,
        kv,
        decodeLegacyBlob,
        normalizeProjection = value => value,
        legacyKey = LEGACY_DATABASE_KEY,
        migrationKey = LEGACY_DATABASE_MIGRATION_KEY,
        now = () => Date.now(),
    } = options ?? {};

    if (!db || typeof db.prepare !== 'function' || typeof db.transaction !== 'function') {
        throw new TypeError('createAppDataMigration requires a better-sqlite3 database');
    }
    if (!appDataStore
        || typeof appDataStore.getState !== 'function'
        || typeof appDataStore.replaceFromProjection !== 'function'
        || typeof appDataStore.exportProjection !== 'function') {
        throw new TypeError('createAppDataMigration requires an appDataStore');
    }
    if (!kv || typeof kv.get !== 'function' || typeof kv.delete !== 'function') {
        throw new TypeError('createAppDataMigration requires synchronous kv.get/delete hooks');
    }
    if (typeof decodeLegacyBlob !== 'function') {
        throw new TypeError('createAppDataMigration requires decodeLegacyBlob');
    }
    if (typeof normalizeProjection !== 'function') {
        throw new TypeError('normalizeProjection must be a function');
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS app_data_migrations (
        migration_key    TEXT PRIMARY KEY,
        source_sha256    TEXT,
        projection_sha256 TEXT NOT NULL,
        disposition      TEXT NOT NULL,
        completed_at     INTEGER NOT NULL
      )
    `);

    const selectMarker = db.prepare(`
      SELECT migration_key, source_sha256, projection_sha256,
             disposition, completed_at
      FROM app_data_migrations WHERE migration_key = ?
    `);
    const upsertMarker = db.prepare(`
      INSERT INTO app_data_migrations
        (migration_key, source_sha256, projection_sha256, disposition, completed_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(migration_key) DO UPDATE SET
        source_sha256 = excluded.source_sha256,
        projection_sha256 = excluded.projection_sha256,
        disposition = excluded.disposition,
        completed_at = excluded.completed_at
    `);
    const selectCanonicalRows = db.prepare(`
      SELECT EXISTS(SELECT 1 FROM app_root_fields LIMIT 1) AS found
    `);

    function markerFromRow(row) {
        if (!row) return undefined;
        return {
            migrationKey: row.migration_key,
            sourceHash: row.source_sha256,
            projectionHash: row.projection_sha256,
            disposition: row.disposition,
            completedAt: row.completed_at,
        };
    }

    function getMarker() {
        return markerFromRow(selectMarker.get(migrationKey));
    }

    function hasCanonicalRows() {
        return selectCanonicalRows.get().found === 1;
    }

    function readLegacyBlob() {
        const value = kv.get(legacyKey);
        return value === null || value === undefined ? undefined : asBuffer(value);
    }

    function projectionHashFromStore() {
        const projection = appDataStore.exportProjection({ includeMessages: true });
        return semanticProjectionHash(
            assertSyncNormalized(normalizeProjection, projection),
        );
    }

    function writeMarker(sourceHash, projectionHash, disposition) {
        upsertMarker.run(
            migrationKey,
            sourceHash ?? null,
            projectionHash,
            disposition,
            now(),
        );
        return getMarker();
    }

    // Adopt an already-initialized relational store. A leftover blob is stale
    // by definition here: overwriting canonical rows would discard writes made
    // after the cutover.
    const adoptCanonicalTransaction = db.transaction(() => {
        const existingMarker = getMarker();
        if (!hasCanonicalRows()) return undefined;

        if (existingMarker) {
            return {
                status: 'already-migrated',
                marker: existingMarker,
                revision: appDataStore.getState().revision,
            };
        }

        const legacyBlob = readLegacyBlob();
        const marker = writeMarker(
            legacyBlob ? sha256(legacyBlob) : null,
            projectionHashFromStore(),
            legacyBlob ? 'canonical-kept' : 'canonical-existing',
        );
        return {
            status: 'canonical-kept',
            marker,
            revision: appDataStore.getState().revision,
        };
    });

    const installTransaction = db.transaction((projection, expectedProjectionHash, expectedSourceHash) => {
        // Another initializer may have won while the legacy blob was decoded.
        // Never replace rows once they are canonical; adopt them instead.
        const adopted = adoptCanonicalTransaction();
        if (adopted) return adopted;

        const currentBlob = readLegacyBlob();
        if (!currentBlob || sha256(currentBlob) !== expectedSourceHash) {
            throw new AppDataMigrationError(
                'Legacy database blob changed while it was being decoded',
                { code: 'APP_DATA_MIGRATION_SOURCE_CHANGED' },
            );
        }

        const state = appDataStore.getState();
        const committed = appDataStore.replaceFromProjection(projection, {
            expectedRevision: state.revision,
        });
        const actualProjectionHash = projectionHashFromStore();
        if (actualProjectionHash !== expectedProjectionHash) {
            throw new AppDataMigrationVerificationError(
                expectedProjectionHash,
                actualProjectionHash,
            );
        }
        if (!hasCanonicalRows() || !appDataStore.getState().initialized) {
            throw new AppDataMigrationError(
                'Relational app data did not become canonical after installation',
                { code: 'APP_DATA_MIGRATION_NOT_INITIALIZED' },
            );
        }

        const marker = writeMarker(
            expectedSourceHash,
            actualProjectionHash,
            'legacy-import',
        );
        return {
            status: 'migrated',
            marker,
            revision: committed.revision,
        };
    });

    function cleanupLegacyBlob(result) {
        try {
            // Re-read after the transaction so a stale writer racing with the
            // migration cannot make the preflight presence check authoritative.
            if (!readLegacyBlob()) {
                return { ...result, legacyBlobRemoved: false };
            }
            // Cleanup deliberately happens after the verified install commits.
            // A crash or failure here leaves marker + rows + stale blob; the
            // next run takes the canonical-wins path and retries this delete.
            kv.delete(legacyKey);
            if (readLegacyBlob()) {
                throw new Error('kv.delete returned without removing the legacy blob');
            }
        } catch (cause) {
            throw new AppDataMigrationCleanupError(cause, {
                ...result,
                legacyBlobRemoved: false,
            });
        }
        return { ...result, legacyBlobRemoved: true };
    }

    async function run() {
        const marker = getMarker();
        const rowsExist = hasCanonicalRows();
        const legacyBlob = readLegacyBlob();

        if (rowsExist) {
            const result = marker
                ? {
                    status: 'already-migrated',
                    marker,
                    revision: appDataStore.getState().revision,
                }
                : adoptCanonicalTransaction();
            return cleanupLegacyBlob(result);
        }

        if (!legacyBlob) {
            const state = appDataStore.getState();
            if (marker || state.initialized) {
                throw new AppDataMigrationError(
                    'Migration marker or initialized state exists without canonical rows or a legacy blob',
                    { code: 'APP_DATA_MIGRATION_INCONSISTENT_STATE' },
                );
            }
            return {
                status: 'no-source',
                marker: undefined,
                revision: state.revision,
                legacyBlobRemoved: false,
            };
        }

        const sourceHash = sha256(legacyBlob);
        const decoded = await decodeLegacyBlob(new Uint8Array(legacyBlob));
        const projection = assertSyncNormalized(normalizeProjection, decoded);
        const expectedProjectionHash = semanticProjectionHash(projection);
        const result = installTransaction(
            projection,
            expectedProjectionHash,
            sourceHash,
        );
        return cleanupLegacyBlob(result);
    }

    return { getMarker, run };
}

module.exports = {
    AppDataMigrationCleanupError,
    AppDataMigrationError,
    AppDataMigrationVerificationError,
    LEGACY_DATABASE_KEY,
    LEGACY_DATABASE_MIGRATION_KEY,
    createAppDataMigration,
    semanticProjectionHash,
};
