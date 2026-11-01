'use strict';

const { openDatabase, withTransaction } = require('./sqlite.cjs');
const { isMainThread, parentPort, workerData } = require('worker_threads');
const { createAppDataStore } = require('./appDataStore.cjs');
const { createBookmarkStore } = require('./bookmarkStore.cjs');
const { createChunkStore, CHUNK_MARKER } = require('./chunkStore.cjs');
const { encodeRisuSaveLegacy } = require('./utils/risuSave.cjs');
const { exportPromptPresetSelection } = require('../shared/promptPresetSelection.mjs');

function createSnapshotKey(db, prefix) {
    const sql = db.createTagStore();
    let tick = Math.round(Date.now() / 100);
    while (sql.get`SELECT 1 FROM kv WHERE key = ${`${prefix}${tick}.bin`}`) tick += 1;
    return `${prefix}${tick}.bin`;
}

function trimSnapshots(db, chunkStore, prefix, maxCount, maxBytes) {
    const sql = db.createTagStore();
    const rows = sql.all`
      SELECT key, value = ${CHUNK_MARKER} AS chunked, LENGTH(value) AS row_bytes
      FROM kv WHERE key LIKE ${`${prefix}%`} ORDER BY key DESC
    `;
    const keptHashes = new Set();
    let keptCount = 0;
    let keptBytes = 0;
    const remove = [];

    for (const row of rows) {
        let addedBytes = Number(row.row_bytes ?? 0);
        const chunks = row.chunked ? sql.all`
          SELECT manifest.hash, LENGTH(chunk.data) AS bytes
          FROM manifest_chunks AS manifest
          JOIN chunks AS chunk ON chunk.hash = manifest.hash
          WHERE manifest.manifest_key = ${row.key}
        ` : [];
        // A manifest can list the same chunk more than once; it is stored once.
        const addedHashes = new Set();
        for (const chunk of chunks) {
            if (keptHashes.has(chunk.hash) || addedHashes.has(chunk.hash)) continue;
            addedHashes.add(chunk.hash);
            addedBytes += Number(chunk.bytes ?? 0);
        }
        const keep = keptCount === 0
            || (keptCount < maxCount && keptBytes + addedBytes <= maxBytes);
        if (!keep) {
            remove.push(row.key);
            continue;
        }
        keptCount += 1;
        keptBytes += addedBytes;
        for (const chunk of chunks) keptHashes.add(chunk.hash);
    }

    withTransaction(db, () => {
        for (const key of remove) {
            chunkStore.dropValue(key);
            sql.run`DELETE FROM bookmark_snapshots WHERE snapshot_key = ${key}`;
        }
    });
    return { kept: keptCount, removed: remove.length, bytes: keptBytes };
}

function createRelationalSnapshot(options) {
    const startedAt = Date.now();
    using db = openDatabase(options.dbPath);
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA cache_size = -64000;
      PRAGMA mmap_size = 268435456;
    `);

    const appDataStore = createAppDataStore(db);
    if (!appDataStore.getState().initialized) {
        throw new Error('Cannot create snapshot: relational database is missing');
    }
    const bookmarkStore = createBookmarkStore(db);
    const chunkStore = createChunkStore(db);
    const snapshot = withTransaction(db, () => {
        const projection = appDataStore.exportProjection({ includeMessages: true });
        bookmarkStore.projectDatabaseCompatibility(projection);
        return {
            value: Buffer.from(encodeRisuSaveLegacy(
                exportPromptPresetSelection(projection),
            )),
            bookmarkCatalog: bookmarkStore.catalog(),
        };
    });

    // Projection assembly, encoding, and content-defined hashing are the
    // expensive CPU work. Finish all of them before taking SQLite's single
    // writer lock so normal client writes only contend with the short row
    // installation phase.
    const prepared = chunkStore.prepareValue(snapshot.value);
    const key = withTransaction(db, () => {
        const snapshotKey = createSnapshotKey(db, options.prefix);
        chunkStore.putPreparedValue(snapshotKey, prepared);
        bookmarkStore.saveCatalogSnapshot(snapshotKey, snapshot.bookmarkCatalog);
        return snapshotKey;
    });
    const trim = trimSnapshots(db, chunkStore, options.prefix, options.maxCount, options.maxBytes);
    // Populate the persisted reachability cache off the request thread.
    // Dashboard reads are O(1) until the next chunk/manifest mutation.
    chunkStore.reclaimableBytes();
    return {
        key,
        logicalBytes: snapshot.value.length,
        elapsedMs: Date.now() - startedAt,
        trim,
    };
}

if (!isMainThread) {
    try {
        parentPort.postMessage({ ok: true, result: createRelationalSnapshot(workerData) });
    } catch (error) {
        parentPort.postMessage({
            ok: false,
            error: error instanceof Error ? error.stack ?? error.message : String(error),
        });
    }
}

module.exports = { createRelationalSnapshot, createSnapshotKey, trimSnapshots };
