'use strict';

const { openDatabase, withTransaction } = require('./sqlite.cjs');
const path = require('path');
const fs = require('fs');
const { createChunkStore } = require('./chunkStore.cjs');

const saveDir = path.join(process.cwd(), 'save');
if (!fs.existsSync(saveDir)) {
    fs.mkdirSync(saveDir, { recursive: true });
}
const dbPath = path.join(saveDir, 'risuai.db');
// Keep SQLite spill files on persistent storage. Container /tmp is commonly a
// tmpfs and Termux may not provide it, either of which makes a large VACUUM
// unsafe before the connection is even opened.
if (!process.env.SQLITE_TMPDIR) {
    process.env.SQLITE_TMPDIR = saveDir;
}
const db = openDatabase(dbPath);

const VACUUM_DISK_SPACE_MULTIPLIER = 2.2;

db.exec(`
  -- WAL mode: better concurrent read performance, single-writer
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA cache_size = -64000;           -- 64 MB (default 2 MB): less disk I/O for large blobs
  PRAGMA temp_store = MEMORY;           -- keep temp tables in RAM
  PRAGMA mmap_size = 268435456;         -- 256 MB memory-mapped I/O for faster reads
  -- Cap WAL file size after a reset checkpoint. Without this, a one-time spike
  -- (backup import, VACUUM, large asset upload) leaves the -wal file permanently
  -- at its peak size since RESTART/TRUNCATE rewind the writer but never shrink
  -- the file unless this limit is set.
  PRAGMA journal_size_limit = 268435456;
`);

// ─── KV table (replaces /save/ hex files) ────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS kv (
    key        TEXT    PRIMARY KEY,
    value      BLOB    NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
  )
`);

// Entity tables (characters, chats, settings, presets, modules) were used in
// a previous version. The tables are no longer created or used, but existing
// databases may still contain them. They are left in place (orphaned) to avoid
// destructive DDL on upgrade. clearEntities() handles cleanup during import.

// ─── Migration: /save/ hex files → kv table ──────────────────────────────────
const savePath = path.join(process.cwd(), 'save');
const migrationMarker = path.join(process.cwd(), 'save', '.migrated_to_sqlite');

function migrateFromSaveDir() {
    if (!fs.existsSync(savePath)) return;
    if (fs.existsSync(migrationMarker)) return;

    const hexRegex = /^[0-9a-fA-F]+$/;
    let files;
    try {
        files = fs.readdirSync(savePath);
    } catch {
        return;
    }

    const hexFiles = files.filter(f => hexRegex.test(f));
    if (hexFiles.length === 0) return;

    console.log(`[DB] Migrating ${hexFiles.length} file(s) from /save/ to SQLite...`);

    const insert = db.prepare(
        `INSERT OR IGNORE INTO kv (key, value, updated_at) VALUES (?, ?, ?)`
    );
    const now = Date.now();

    withTransaction(db, () => {
        for (let i = 0; i < hexFiles.length; i++) {
            if (i % 100 === 0 || i === hexFiles.length - 1) {
                console.log(`[DB] Migrating... ${i + 1}/${hexFiles.length}`);
            }
            const key = Buffer.from(hexFiles[i], 'hex').toString('utf-8');
            const value = fs.readFileSync(path.join(savePath, hexFiles[i]));
            // Route the DB blob through chunking so an oversized legacy
            // database.bin migrates instead of hitting the BLOB bind limit.
            if (key === DB_BLOB_KEY) chunkStore.putValue(key, value);
            else insert.run(key, value, now);
        }
    });

    fs.writeFileSync(migrationMarker, new Date().toISOString(), 'utf-8');
    console.log(`[DB] Migration complete. ${hexFiles.length} files preserved in /save/.`);
    console.log('[DB] After verifying the migration, archive or remove the original hex-named files manually if desired.');
}

// Chunk-aware store for the full DB blob. The blob is split into
// content-addressed chunks so a small change rewrites only the chunks that
// changed (dedup) and no single value hits the SQLite BLOB limit. Scoped to the
// DB blob: assets are already one row each, so chunking them would add overhead
// with no benefit. Creates its own chunks/manifest tables (kv stays as-is).
// Built before migrateFromSaveDir so legacy blob migration can chunk too.
const DB_BLOB_KEY = 'database/database.bin';
const chunkStore = createChunkStore(db);

migrateFromSaveDir();

// ─── KV operations ────────────────────────────────────────────────────────────
// kv reads/writes for the DB blob route through chunkStore (get/put/size);
// the statements below serve the remaining direct-row keys.
const stmtKvSet = db.prepare(`INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)`);
const stmtKvUpdatedAt = db.prepare(`SELECT updated_at FROM kv WHERE key = ?`);
const queryKvList = prepareKvPrefixQuery('SELECT key FROM kv', 'all');
const queryKvCount = prepareKvPrefixQuery('SELECT COUNT(*) AS total FROM kv', 'get');
const queryKvRecent = prepareKvPrefixQuery(
    'SELECT key FROM kv', 'all', ' ORDER BY updated_at DESC, rowid DESC LIMIT ? OFFSET ?'
);
const queryKvSizes = prepareKvPrefixQuery('SELECT key, LENGTH(value) AS size FROM kv', 'all');
const queryKvDelete = prepareKvPrefixQuery('DELETE FROM kv', 'run');

function prepareKvPrefixQuery(sql, method, suffix = '') {
    const all = db.prepare(sql + suffix);
    const range = db.prepare(`${sql} WHERE key >= ? AND key < ?${suffix}`);
    const like = db.prepare(`${sql} WHERE key LIKE ? ESCAPE '\\'${suffix}`);

    return (prefix, ...args) => {
        if (!prefix) return all[method](...args);

        // An ASCII suffix can be incremented to form a BINARY index upper bound.
        const last = prefix.charCodeAt(prefix.length - 1);
        if (last >= 0x20 && last <= 0x7e) {
            const upper = prefix.slice(0, -1) + String.fromCharCode(last + 1);
            return range[method](prefix, upper, ...args);
        }
        const escaped = prefix.replace(/[\\%_]/g, '\\$&');
        return like[method](`${escaped}%`, ...args);
    };
}

function kvGet(key) {
    // Reassembles chunked values; returns raw value for everything else.
    return chunkStore.getValue(key);
}

function kvSet(key, value) {
    // Only the DB blob is chunked; all other keys keep the exact prior path.
    if (key === DB_BLOB_KEY) {
        chunkStore.putValue(key, value);
    } else {
        stmtKvSet.run(key, value, Date.now());
    }
}

// Explicit large-value path for compatibility projections such as rotated
// snapshots. The live application database no longer uses this opaque store,
// but export artifacts can still exceed SQLite's single-value comfort zone.
function kvSetChunked(key, value) {
    chunkStore.putValue(key, value);
}

function kvDel(key) {
    // Route through the chunk store so a chunked key (the DB blob or a chunked
    // snapshot, e.g. a rotated dbbackup-*) also drops its manifest — otherwise
    // its chunks stay referenced and GC can never reclaim them. For non-chunked
    // keys the manifest delete is a no-op, so this is safe and atomic for all.
    chunkStore.dropValue(key);
}

function kvSize(key) {
    // Logical (reassembled) size for chunked values; raw length otherwise.
    return chunkStore.sizeValue(key);
}

function kvGetUpdatedAt(key) {
    const row = stmtKvUpdatedAt.get(key);
    return row ? row.updated_at : null;
}

function kvDelPrefix(prefix) {
    queryKvDelete(prefix);
}

function kvList(prefix, options = {}) {
    const limit = Number.isSafeInteger(options.limit) && options.limit > 0
        ? Math.min(options.limit, 5000)
        : null;
    const offset = Number.isSafeInteger(options.offset) && options.offset > 0
        ? options.offset
        : 0;
    const rows = options.order === 'updated-desc' && limit !== null
        ? queryKvRecent(prefix, limit, offset)
        : queryKvList(prefix);
    return rows.map(r => r.key);
}

function kvCount(prefix) {
    return queryKvCount(prefix).total;
}

function kvListWithSizes(prefix) {
    return queryKvSizes(prefix);
}

function checkpointWal(mode = 'TRUNCATE') {
    return db.prepare(`PRAGMA wal_checkpoint(${mode})`).get();
}

function estimateVacuumRequiredBytes(databaseBytes) {
    return Math.ceil(Math.max(0, databaseBytes) * VACUUM_DISK_SPACE_MULTIPLIER);
}

function vacuumDatabase() {
    const previousTempStore = db.prepare('PRAGMA temp_store').get().temp_store;
    db.exec('PRAGMA temp_store = FILE');
    try {
        db.exec('VACUUM');
    } finally {
        // Preserve the connection policy instead of assuming MEMORY forever.
        db.exec(`PRAGMA temp_store = ${previousTempStore}`);
    }
}

// Reclaim chunks no longer referenced by any manifest (live blob + snapshots).
// Returns the number deleted. Caller should run it serialized with saves (e.g.
// inside the storage queue) and before VACUUM so freed pages get compacted.
function gcChunks() {
    return chunkStore.gc();
}

// Bytes the next gc() would reclaim (true orphans + chunks held only by stale
// manifests). Drives the Optimize button so self-healable leaks can be cleared.
function reclaimableChunkBytes() {
    return chunkStore.reclaimableBytes();
}

function chunkStorageStats() {
    return chunkStore.stats();
}

// Whether the live DB blob is actually stored chunked right now (marker-backed),
// not merely that a manifest row exists.
function isDbBlobChunked() {
    return chunkStore.isChunkedKey(DB_BLOB_KEY);
}

// Count shared chunks once across the snapshot set, plus each key's stored value.
function snapshotSetFootprint(keys) {
    return chunkStore.keySetPhysicalCost(keys);
}

function clearEntities() {
    // Entity tables may still exist from previous versions — clear them during backup import
    try {
        db.exec(`DELETE FROM characters; DELETE FROM chats; DELETE FROM settings; DELETE FROM presets; DELETE FROM modules`);
    } catch {
        // Tables may not exist — ignore
    }
}

module.exports = {
    db,
    chunkStore,
    // KV
    kvGet, kvSet, kvSetChunked, kvDel, kvList, kvCount, kvDelPrefix, kvListWithSizes, kvSize, kvGetUpdatedAt,
    clearEntities,
    checkpointWal,
    estimateVacuumRequiredBytes,
    vacuumDatabase,
    gcChunks,
    reclaimableChunkBytes,
    chunkStorageStats,
    isDbBlobChunked,
    snapshotSetFootprint,
};
