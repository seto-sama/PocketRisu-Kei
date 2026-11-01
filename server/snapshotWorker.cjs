'use strict';

const { openDatabase, withTransaction } = require('./sqlite.cjs');
const { isMainThread, parentPort, workerData } = require('worker_threads');
const { createAppDataStore } = require('./appDataStore.cjs');
const { createBookmarkStore } = require('./bookmarkStore.cjs');
const { createChunkStore, CHUNK_MARKER } = require('./chunkStore.cjs');
const { encodeRisuSaveLegacy } = require('./utils/risuSave.cjs');
const { exportPromptPresetSelection } = require('../shared/promptPresetSelection.mjs');

function createSnapshotKey(db, prefix) {
    const exists = db.prepare('SELECT 1 FROM kv WHERE key = ?');
    let tick = Math.round(Date.now() / 100);
    let key = `${prefix}${tick}.bin`;
    while (exists.get(key)) {
        tick += 1;
        key = `${prefix}${tick}.bin`;
    }
    return key;
}

function trimSnapshots(db, chunkStore, prefix, maxCount, maxBytes) {
    const rows = db.prepare(`
      SELECT key, value = ? AS chunked, LENGTH(value) AS row_bytes
      FROM kv WHERE key LIKE ? ORDER BY key DESC
    `).all(CHUNK_MARKER, `${prefix}%`);
    const selectChunks = db.prepare(`
      SELECT manifest.hash, LENGTH(chunk.data) AS bytes
      FROM manifest_chunks AS manifest
      JOIN chunks AS chunk ON chunk.hash = manifest.hash
      WHERE manifest.manifest_key = ?
    `);
    const deleteBookmarkSnapshot = db.prepare(
        'DELETE FROM bookmark_snapshots WHERE snapshot_key = ?',
    );
    const keptHashes = new Set();
    let keptCount = 0;
    let keptBytes = 0;
    const remove = [];

    for (const row of rows) {
        let addedBytes = Number(row.row_bytes ?? 0);
        const chunks = row.chunked ? selectChunks.all(row.key) : [];
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
            deleteBookmarkSnapshot.run(key);
        }
    });
    return { kept: keptCount, removed: remove.length, bytes: keptBytes };
}

function createRelationalSnapshot(options) {
    const startedAt = Date.now();
    const db = openDatabase(options.dbPath);
    try {
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
        const insertBookmarkSnapshot = db.prepare(`
          INSERT INTO bookmark_snapshots(snapshot_key, catalog_json) VALUES (?, ?)
          ON CONFLICT(snapshot_key) DO UPDATE SET catalog_json = excluded.catalog_json
        `);
        let key;
        withTransaction(db, () => {
            key = createSnapshotKey(db, options.prefix);
            chunkStore.putPreparedValue(key, prepared);
            insertBookmarkSnapshot.run(key, JSON.stringify(snapshot.bookmarkCatalog));
        });
        const trim = trimSnapshots(
            db,
            chunkStore,
            options.prefix,
            options.maxCount,
            options.maxBytes,
        );
        // Populate the persisted reachability cache off the request thread.
        // Dashboard reads are O(1) until the next chunk/manifest mutation.
        chunkStore.reclaimableBytes();
        return {
            key,
            logicalBytes: snapshot.value.length,
            elapsedMs: Date.now() - startedAt,
            trim,
        };
    } finally {
        db.close();
    }
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
