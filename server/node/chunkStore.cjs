'use strict';

// Content-defined chunking for large kv values. Splits an opaque byte buffer
// into content-addressed chunks so a small logical change rewrites only the
// chunks that actually changed (dedup), and so no single SQLite value exceeds
// the BLOB bind limit. Operates purely on bytes — knows nothing about the DB
// schema. See .agent/notes/db-storage-chunking-plan.md.

const crypto = require('crypto');

// Gear table for the rolling hash (FastCDC-style). Deterministic so chunk
// boundaries depend only on content — identical content always cuts the same
// way, which is what makes dedup work across versions.
const GEAR = new Uint32Array(256);
for (let i = 0; i < 256; i++) GEAR[i] = Math.imul(i + 1, 2654435761) >>> 0;

const MIN_SIZE = 4096;        // no boundary checked before this — bounds chunk count
const MAX_SIZE = 65536;       // forced cut here — bounds worst-case chunk size
const MASK = 0x3fff;          // ~16KB average chunk (14 one-bits)

// Split a buffer into ordered content-addressed chunks. Reassembling
// chunks[].data in order reproduces the input exactly.
function cdcSplit(buf) {
    const chunks = [];
    const len = buf.length;
    let start = 0;
    while (start < len) {
        const end = Math.min(start + MAX_SIZE, len);
        let cut = end;
        let h = 0;
        for (let i = Math.min(start + MIN_SIZE, len); i < end; i++) {
            h = ((h << 1) + GEAR[buf[i]]) >>> 0;
            if ((h & MASK) === 0) { cut = i + 1; break; }
        }
        const data = buf.subarray(start, cut);
        const hash = crypto.createHash('sha256').update(data).digest('hex');
        chunks.push({ hash, data });
        start = cut;
    }
    return chunks;
}

// Sentinel stored in kv.value for a chunked key. kv.value is NOT NULL, so a
// chunked row holds this marker instead of an empty value; the real bytes live
// in the chunks table, ordered by manifest_chunks. A legacy raw value never
// equals this 13-byte sentinel, so reads stay backward-compatible.
const CHUNK_MARKER = Buffer.from('\x00RISUCHUNKED\x00', 'binary');
const DEFAULT_THRESHOLD = 16 * 1024 * 1024; // values larger than this get chunked

// Bind chunk-aware get/put to a specific better-sqlite3 instance. db.cjs wires
// the real DB; tests wire a :memory: DB. The kv table must already exist (it is
// db.cjs's schema); this creates only the chunk/manifest tables.
function createChunkStore(db, opts = {}) {
    const threshold = opts.threshold ?? DEFAULT_THRESHOLD;

    db.exec(`
        CREATE TABLE IF NOT EXISTS chunks (
            hash TEXT PRIMARY KEY,
            data BLOB NOT NULL
        );
        CREATE TABLE IF NOT EXISTS manifest_chunks (
            manifest_key TEXT NOT NULL,
            seq          INTEGER NOT NULL,
            hash         TEXT NOT NULL,
            PRIMARY KEY (manifest_key, seq)
        );
        CREATE INDEX IF NOT EXISTS idx_manifest_hash ON manifest_chunks(hash);
        CREATE TABLE IF NOT EXISTS chunk_value_sizes (
            manifest_key TEXT PRIMARY KEY,
            logical_bytes INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS chunk_store_stats (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            chunk_count INTEGER NOT NULL,
            chunk_bytes INTEGER NOT NULL,
            reclaimable_bytes INTEGER NOT NULL,
            reclaimable_dirty INTEGER NOT NULL
        );
        INSERT OR IGNORE INTO chunk_store_stats(
            id, chunk_count, chunk_bytes, reclaimable_bytes, reclaimable_dirty
        ) SELECT
            1, COUNT(*), COALESCE(SUM(LENGTH(data)), 0), 0, 1
        FROM chunks;
    `);

    const insChunk = db.prepare('INSERT OR IGNORE INTO chunks (hash, data) VALUES (?, ?)');
    const delManifest = db.prepare('DELETE FROM manifest_chunks WHERE manifest_key = ?');
    const insManifest = db.prepare('INSERT INTO manifest_chunks (manifest_key, seq, hash) VALUES (?, ?, ?)');
    const selManifest = db.prepare('SELECT hash FROM manifest_chunks WHERE manifest_key = ? ORDER BY seq');
    const selChunk = db.prepare('SELECT data FROM chunks WHERE hash = ?');
    const selPhysicalRow = db.prepare('SELECT value, LENGTH(value) AS n FROM kv WHERE key = ?');
    const selManifestChunkSizes = db.prepare(
        `SELECT m.hash, LENGTH(c.data) AS n
         FROM manifest_chunks m
         JOIN chunks c ON c.hash = m.hash
         WHERE m.manifest_key = ?`,
    );
    const selSize = db.prepare(
        'SELECT SUM(LENGTH(c.data)) AS n FROM manifest_chunks m JOIN chunks c ON c.hash = m.hash WHERE m.manifest_key = ?',
    );
    const selectCachedSize = db.prepare(
        'SELECT logical_bytes AS n FROM chunk_value_sizes WHERE manifest_key = ?',
    );
    const upsertCachedSize = db.prepare(`
      INSERT INTO chunk_value_sizes(manifest_key, logical_bytes) VALUES (?, ?)
      ON CONFLICT(manifest_key) DO UPDATE SET logical_bytes = excluded.logical_bytes
    `);
    const deleteCachedSize = db.prepare(
        'DELETE FROM chunk_value_sizes WHERE manifest_key = ?',
    );
    const deleteStaleCachedSizes = db.prepare(`
      DELETE FROM chunk_value_sizes WHERE NOT EXISTS (
        SELECT 1 FROM kv WHERE kv.key = chunk_value_sizes.manifest_key
          AND kv.value = ?
      )
    `);
    const selectChunkStats = db.prepare(`
      SELECT chunk_count AS count, chunk_bytes AS bytes,
             reclaimable_bytes AS reclaimableBytes,
             reclaimable_dirty AS reclaimableDirty
      FROM chunk_store_stats WHERE id = 1
    `);
    const addChunkStats = db.prepare(`
      UPDATE chunk_store_stats
      SET chunk_count = chunk_count + 1, chunk_bytes = chunk_bytes + ?
      WHERE id = 1
    `);
    const replaceChunkStats = db.prepare(`
      UPDATE chunk_store_stats
      SET chunk_count = ?, chunk_bytes = ?,
          reclaimable_bytes = ?, reclaimable_dirty = ?
      WHERE id = 1
    `);
    const markReclaimableDirty = db.prepare(
        'UPDATE chunk_store_stats SET reclaimable_dirty = 1 WHERE id = 1',
    );
    const updateReclaimable = db.prepare(`
      UPDATE chunk_store_stats
      SET reclaimable_bytes = ?, reclaimable_dirty = 0 WHERE id = 1
    `);
    // Bytes of chunks referenced by `key` but NOT by `baseKey` — i.e. what `key`
    // uniquely keeps alive beyond the base. Used to size snapshots for the disk
    // limit by their real marginal cost, not their (shared) logical size.
    const selMarginal = db.prepare(
        `SELECT COALESCE(SUM(LENGTH(c.data)), 0) AS n FROM chunks c
         WHERE c.hash IN (SELECT hash FROM manifest_chunks WHERE manifest_key = ?)
           AND c.hash NOT IN (SELECT hash FROM manifest_chunks WHERE manifest_key = ?)`,
    );
    const copyManifest = db.prepare(
        'INSERT INTO manifest_chunks (manifest_key, seq, hash) SELECT ?, seq, hash FROM manifest_chunks WHERE manifest_key = ?',
    );
    const kvSet = db.prepare('INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)');
    const kvGet = db.prepare('SELECT value FROM kv WHERE key = ?');
    const kvDel = db.prepare('DELETE FROM kv WHERE key = ?');
    // Defensive self-heal: drop any manifest that is not backed by a live chunked
    // kv row — i.e. the key is gone OR its value is no longer the marker (some
    // path wrote a raw value over it). Either way the manifest is stale and would
    // pin its chunks forever; sweeping these first lets the damage be reclaimed.
    const gcStaleManifests = db.prepare(
        `DELETE FROM manifest_chunks WHERE NOT EXISTS (
             SELECT 1 FROM kv WHERE kv.key = manifest_chunks.manifest_key AND kv.value = ?)`,
    );
    // Mark-sweep: the set of all hashes referenced by ANY manifest (live + every
    // snapshot/backup) is the live set; anything else is unreachable. Recomputed
    // from manifest_chunks each run — stateless, self-healing, can't over-delete.
    const gcSweep = db.prepare('DELETE FROM chunks WHERE hash NOT IN (SELECT hash FROM manifest_chunks)');
    // Bytes gc would reclaim right now: chunks referenced by no marker-backed
    // (live) manifest. Counts true orphans + chunks held only by stale manifests.
    // The kv check is correlated on key (PK lookup per manifest key, ~6 keys), NOT
    // `value IN (SELECT … WHERE value = ?)` which full-scans every kv blob (seconds
    // on a DB with thousands of assets, blocking the synchronous event loop).
    const selReclaimable = db.prepare(
        `SELECT COALESCE(SUM(LENGTH(data)), 0) AS b FROM chunks WHERE hash NOT IN
         (SELECT hash FROM manifest_chunks mc
          WHERE EXISTS (SELECT 1 FROM kv WHERE kv.key = mc.manifest_key AND kv.value = ?))`,
    );

    const isChunked = (value) => Buffer.isBuffer(value) && value.equals(CHUNK_MARKER);

    // Atomic: clearing the old manifest, inserting new chunks, and writing the
    // marker all commit together. Orphaned chunks from a prior version are left
    // for GC (a later layer) — never deleted here.
    function prepareValue(value) {
        const buffer = Buffer.from(value);
        return buffer.length <= threshold
            ? { raw: buffer, chunks: null, logicalSize: buffer.length }
            : { raw: null, chunks: cdcSplit(buffer), logicalSize: buffer.length };
    }

    const putPreparedValue = db.transaction((key, prepared) => {
        delManifest.run(key);
        if (prepared.raw) {
            deleteCachedSize.run(key);
            kvSet.run(key, prepared.raw, Date.now());
            markReclaimableDirty.run();
            return;
        }
        const chunks = prepared.chunks;
        for (const c of chunks) {
            if (insChunk.run(c.hash, c.data).changes > 0) addChunkStats.run(c.data.length);
        }
        for (let i = 0; i < chunks.length; i++) insManifest.run(key, i, chunks[i].hash);
        kvSet.run(key, CHUNK_MARKER, Date.now());
        upsertCachedSize.run(key, prepared.logicalSize);
        markReclaimableDirty.run();
    });

    function putValue(key, value) {
        return putPreparedValue(key, prepareValue(value));
    }

    function getValue(key) {
        const row = kvGet.get(key);
        if (!row) return null;
        if (isChunked(row.value)) {
            const rows = selManifest.all(key);
            // A real chunked key always has manifest rows. If a non-chunked value
            // happens to equal the marker byte-for-byte (astronomically unlikely),
            // there are none — return it raw instead of an empty buffer. No extra
            // cost for real chunked keys: they need this manifest lookup anyway.
            if (rows.length === 0) return row.value;
            return Buffer.concat(rows.map((r) => selChunk.get(r.hash).data));
        }
        return row.value;
    }

    function sizeValue(key) {
        const row = kvGet.get(key);
        if (!row) return null;
        if (isChunked(row.value)) {
            const cached = selectCachedSize.get(key)?.n;
            if (cached !== undefined) return cached;
            const size = Number(selSize.get(key).n ?? 0);
            upsertCachedSize.run(key, size);
            return size;
        }
        return row.value.length;
    }

    // Marginal disk cost of a (snapshot) key relative to baseKey (the live blob):
    // raw value → its full length; chunked → bytes of chunks not shared with base.
    // A snapshot identical to base costs ~0; a divergent one costs its real delta.
    function snapshotCost(key, baseKey) {
        const row = kvGet.get(key);
        if (!row) return 0;
        if (!isChunked(row.value)) return row.value.length;
        return selMarginal.get(key, baseKey).n;
    }

    // Physical value bytes retained by a set of keys. Every existing kv row is
    // counted once (a raw value in full, or CHUNK_MARKER for a chunked value),
    // then every distinct chunk payload referenced by those live marker-backed
    // manifests is counted once. This is the quota measure for a collection of
    // snapshots: shared chunks must not be charged once per snapshot.
    //
    // SQLite page/index/key overhead is intentionally outside this measure; it
    // is the exact sum of the persisted value payloads represented by the rows.
    function keySetPhysicalCost(keys) {
        if (!Array.isArray(keys)) throw new TypeError('keys must be an array');

        let bytes = 0;
        const chunkSizes = new Map();
        for (const key of new Set(keys)) {
            const row = selPhysicalRow.get(key);
            if (!row) continue;
            bytes += row.n;
            if (!isChunked(row.value)) continue;
            for (const chunk of selManifestChunkSizes.all(key)) {
                chunkSizes.set(chunk.hash, chunk.n);
            }
        }
        for (const size of chunkSizes.values()) bytes += size;
        return bytes;
    }

    // Copy src's value to dst. For a chunked src, only the manifest (list of
    // chunk hashes) is copied — chunks stay shared, so a snapshot costs ~nothing
    // and never duplicates bytes. Mirrors kvCopyValue: missing src is a no-op.
    const snapshotValue = db.transaction((srcKey, dstKey) => {
        const row = kvGet.get(srcKey);
        if (!row) return;
        delManifest.run(dstKey);
        if (isChunked(row.value)) {
            copyManifest.run(dstKey, srcKey);
            kvSet.run(dstKey, CHUNK_MARKER, Date.now());
            const logicalSize = selectCachedSize.get(srcKey)?.n
                ?? Number(selSize.get(srcKey).n ?? 0);
            upsertCachedSize.run(srcKey, logicalSize);
            upsertCachedSize.run(dstKey, logicalSize);
        } else {
            deleteCachedSize.run(dstKey);
            kvSet.run(dstKey, row.value, Date.now());
        }
        markReclaimableDirty.run();
    });

    // Remove a key entirely (its manifest + kv row). Chunks it referenced
    // become orphans, reclaimed by the next gc(). Used for snapshot rotation.
    const dropValue = db.transaction((key) => {
        delManifest.run(key);
        deleteCachedSize.run(key);
        kvDel.run(key);
        markReclaimableDirty.run();
    });

    // Reclaim unreferenced chunks. Returns the number deleted. Run opportunistically
    // (e.g. Optimize / periodic) — never on the hot save path.
    function gc() {
        gcStaleManifests.run(CHUNK_MARKER);
        deleteStaleCachedSizes.run(CHUNK_MARKER);
        const changes = gcSweep.run().changes;
        const totals = db.prepare(`
          SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(data)), 0) AS bytes
          FROM chunks
        `).get();
        replaceChunkStats.run(totals.count, totals.bytes, 0, 0);
        return changes;
    }

    function reclaimableBytes() {
        const stats = selectChunkStats.get();
        if (!stats.reclaimableDirty) return stats.reclaimableBytes;
        const bytes = Number(selReclaimable.get(CHUNK_MARKER).b ?? 0);
        updateReclaimable.run(bytes);
        return bytes;
    }

    function stats() {
        const row = selectChunkStats.get();
        return { count: row.count, bytes: row.bytes };
    }

    // True only when the key is actually stored chunked right now (its kv value
    // is the marker) — not merely when a manifest exists. A raw value that
    // overwrote the marker (manifest not yet swept) reads as not-chunked.
    function isChunkedKey(key) {
        const row = kvGet.get(key);
        return !!row && isChunked(row.value);
    }

    return {
        putValue,
        prepareValue,
        putPreparedValue,
        getValue,
        sizeValue,
        snapshotCost,
        keySetPhysicalCost,
        snapshotValue,
        dropValue,
        gc,
        reclaimableBytes,
        stats,
        isChunkedKey,
    };
}

module.exports = { cdcSplit, createChunkStore, CHUNK_MARKER };
