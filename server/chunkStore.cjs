'use strict';

const { toBuffer, withTransaction } = require('./sqlite.cjs');
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

// Bind chunk-aware get/put to a specific synchronous SQLite connection. db.cjs wires
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

    const sql = db.createTagStore();
    const markReclaimableDirty = () => sql.run`UPDATE chunk_store_stats SET reclaimable_dirty = 1 WHERE id = 1`;
    const cacheSize = (key, bytes) => sql.run`
      INSERT INTO chunk_value_sizes(manifest_key, logical_bytes) VALUES (${key}, ${bytes})
      ON CONFLICT(manifest_key) DO UPDATE SET logical_bytes = excluded.logical_bytes
    `;
    // Row facts without loading the stored bytes.
    const rowInfo = key => sql.get`
      SELECT value = ${CHUNK_MARKER} AS chunked, LENGTH(value) AS bytes FROM kv WHERE key = ${key}
    `;

    // Atomic: clearing the old manifest, inserting new chunks, and writing the
    // marker all commit together. Orphaned chunks from a prior version are left
    // for GC (a later layer) — never deleted here.
    function prepareValue(value) {
        const buffer = Buffer.from(value);
        return buffer.length <= threshold
            ? { raw: buffer, chunks: null, logicalSize: buffer.length }
            : { raw: null, chunks: cdcSplit(buffer), logicalSize: buffer.length };
    }

    function putPreparedValue(key, prepared) {
        withTransaction(db, () => {
            sql.run`DELETE FROM manifest_chunks WHERE manifest_key = ${key}`;
            if (prepared.raw) {
                sql.run`DELETE FROM chunk_value_sizes WHERE manifest_key = ${key}`;
            } else {
                prepared.chunks.forEach(({ hash, data }, seq) => {
                    if (sql.run`INSERT OR IGNORE INTO chunks (hash, data) VALUES (${hash}, ${data})`.changes > 0) {
                        sql.run`UPDATE chunk_store_stats
                          SET chunk_count = chunk_count + 1, chunk_bytes = chunk_bytes + ${data.length} WHERE id = 1`;
                    }
                    sql.run`INSERT INTO manifest_chunks (manifest_key, seq, hash) VALUES (${key}, ${seq}, ${hash})`;
                });
                cacheSize(key, prepared.logicalSize);
            }
            sql.run`INSERT OR REPLACE INTO kv (key, value, updated_at)
              VALUES (${key}, ${prepared.raw ?? CHUNK_MARKER}, ${Date.now()})`;
            markReclaimableDirty();
        });
    }

    function putValue(key, value) {
        putPreparedValue(key, prepareValue(value));
    }

    function getValue(key) {
        const row = sql.get`SELECT value FROM kv WHERE key = ${key}`;
        if (!row) return null;
        if (!(row.value instanceof Uint8Array && CHUNK_MARKER.equals(row.value))) return toBuffer(row.value);
        const chunks = sql.all`
          SELECT c.data FROM manifest_chunks m LEFT JOIN chunks c ON c.hash = m.hash
          WHERE m.manifest_key = ${key} ORDER BY m.seq
        `;
        // A real chunked key always has manifest rows. If a non-chunked value
        // happens to equal the marker byte-for-byte (astronomically unlikely),
        // there are none — return it raw instead of an empty buffer.
        if (chunks.length === 0) return toBuffer(row.value);
        if (chunks.some(chunk => chunk.data === null)) throw new Error(`Chunked value ${key} is missing chunk data`);
        return Buffer.concat(chunks.map(chunk => chunk.data));
    }

    function sizeValue(key) {
        const row = rowInfo(key);
        if (!row) return null;
        if (!row.chunked) return row.bytes;
        const cached = sql.get`SELECT logical_bytes AS n FROM chunk_value_sizes WHERE manifest_key = ${key}`;
        if (cached) return cached.n;
        const size = Number(sql.get`
          SELECT SUM(LENGTH(c.data)) AS n FROM manifest_chunks m JOIN chunks c ON c.hash = m.hash
          WHERE m.manifest_key = ${key}
        `.n ?? 0);
        cacheSize(key, size);
        return size;
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
            const row = rowInfo(key);
            if (!row) continue;
            bytes += row.bytes;
            if (!row.chunked) continue;
            for (const chunk of sql.iterate`
              SELECT m.hash, LENGTH(c.data) AS n FROM manifest_chunks m JOIN chunks c ON c.hash = m.hash
              WHERE m.manifest_key = ${key}
            `) chunkSizes.set(chunk.hash, chunk.n);
        }
        for (const size of chunkSizes.values()) bytes += size;
        return bytes;
    }

    // Remove a key entirely (its manifest + kv row). Chunks it referenced
    // become orphans, reclaimed by the next gc(). Used for snapshot rotation.
    function dropValue(key) {
        withTransaction(db, () => {
            sql.run`DELETE FROM manifest_chunks WHERE manifest_key = ${key}`;
            sql.run`DELETE FROM chunk_value_sizes WHERE manifest_key = ${key}`;
            sql.run`DELETE FROM kv WHERE key = ${key}`;
            markReclaimableDirty();
        });
    }

    // Reclaim unreferenced chunks. Returns the number deleted. Run opportunistically
    // (e.g. Optimize / periodic) — never on the hot save path.
    function gc() {
        // Defensive self-heal: drop any manifest that is not backed by a live chunked
        // kv row — i.e. the key is gone OR its value is no longer the marker (some
        // path wrote a raw value over it). Either way the manifest is stale and would
        // pin its chunks forever; sweeping these first lets the damage be reclaimed.
        sql.run`DELETE FROM manifest_chunks WHERE NOT EXISTS (
          SELECT 1 FROM kv WHERE kv.key = manifest_chunks.manifest_key AND kv.value = ${CHUNK_MARKER})`;
        sql.run`DELETE FROM chunk_value_sizes WHERE NOT EXISTS (
          SELECT 1 FROM kv WHERE kv.key = chunk_value_sizes.manifest_key AND kv.value = ${CHUNK_MARKER})`;
        // Mark-sweep: the set of all hashes referenced by ANY manifest (live + every
        // snapshot/backup) is the live set; anything else is unreachable. Recomputed
        // from manifest_chunks each run — stateless, self-healing, can't over-delete.
        const { changes } = sql.run`DELETE FROM chunks WHERE hash NOT IN (SELECT hash FROM manifest_chunks)`;
        sql.run`UPDATE chunk_store_stats
          SET (chunk_count, chunk_bytes) = (SELECT COUNT(*), COALESCE(SUM(LENGTH(data)), 0) FROM chunks),
              reclaimable_bytes = 0, reclaimable_dirty = 0
          WHERE id = 1`;
        return changes;
    }

    const selectStats = () => sql.get`
      SELECT chunk_count AS count, chunk_bytes AS bytes,
             reclaimable_bytes AS reclaimableBytes, reclaimable_dirty AS reclaimableDirty
      FROM chunk_store_stats WHERE id = 1
    `;

    function reclaimableBytes() {
        const stats = selectStats();
        if (!stats.reclaimableDirty) return stats.reclaimableBytes;
        // Bytes gc would reclaim right now: chunks referenced by no marker-backed
        // (live) manifest. Counts true orphans + chunks held only by stale manifests.
        // The kv check is correlated on key (PK lookup per manifest key, ~6 keys), NOT
        // `value IN (SELECT … WHERE value = ?)` which full-scans every kv blob (seconds
        // on a DB with thousands of assets, blocking the synchronous event loop).
        const bytes = Number(sql.get`
          SELECT COALESCE(SUM(LENGTH(data)), 0) AS b FROM chunks WHERE hash NOT IN
            (SELECT hash FROM manifest_chunks mc
             WHERE EXISTS (SELECT 1 FROM kv WHERE kv.key = mc.manifest_key AND kv.value = ${CHUNK_MARKER}))
        `.b ?? 0);
        sql.run`UPDATE chunk_store_stats SET reclaimable_bytes = ${bytes}, reclaimable_dirty = 0 WHERE id = 1`;
        return bytes;
    }

    function stats() {
        const { count, bytes } = selectStats();
        return { count, bytes };
    }

    // True only when the key is actually stored chunked right now (its kv value
    // is the marker) — not merely when a manifest exists. A raw value that
    // overwrote the marker (manifest not yet swept) reads as not-chunked.
    function isChunkedKey(key) {
        return Boolean(rowInfo(key)?.chunked);
    }

    return {
        putValue,
        prepareValue,
        putPreparedValue,
        getValue,
        sizeValue,
        keySetPhysicalCost,
        dropValue,
        gc,
        reclaimableBytes,
        stats,
        isChunkedKey,
    };
}

module.exports = { cdcSplit, createChunkStore, CHUNK_MARKER };
