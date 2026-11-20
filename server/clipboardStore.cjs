'use strict';

const { randomUUID } = require('crypto');
const { withTransaction } = require('./sqlite.cjs');

const CLIPBOARD_HISTORY_LIMIT = 50;
const CLIPBOARD_TEXT_LIMIT = 200_000;

function createClipboardStore(db) {
    // `guard_visible` marks text copied while the privacy guard was on, so it stays
    // listable under the guard; everything else may quote hidden chats.
    db.exec(`
        CREATE TABLE IF NOT EXISTS kei_clipboard (
            id TEXT PRIMARY KEY,
            text TEXT NOT NULL UNIQUE,
            created_at INTEGER NOT NULL,
            pinned INTEGER NOT NULL DEFAULT 0,
            guard_visible INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_kei_clipboard_created ON kei_clipboard(created_at);
    `);
    const sql = db.createTagStore();
    let lastCreatedAt = 0;
    // Strictly increasing so two copies in the same millisecond keep their order.
    const nextCreatedAt = () => (lastCreatedAt = Math.max(Date.now(), lastCreatedAt + 1));

    function list({ guarded = false } = {}) {
        const rows = guarded
            ? sql.all`SELECT * FROM kei_clipboard WHERE guard_visible = 1 ORDER BY created_at DESC`
            : sql.all`SELECT * FROM kei_clipboard ORDER BY created_at DESC`;
        return {
            entries: rows.map(row => ({
                id: row.id, text: row.text, createdAt: row.created_at, pinned: row.pinned === 1,
            })),
        };
    }

    const pruneHistory = () => sql.run`
        DELETE FROM kei_clipboard WHERE id IN (
            SELECT id FROM kei_clipboard WHERE pinned = 0
            ORDER BY created_at DESC LIMIT -1 OFFSET ${CLIPBOARD_HISTORY_LIMIT})`;

    function add(text, { guarded = false } = {}) {
        withTransaction(db, () => {
            const createdAt = nextCreatedAt();
            const visible = guarded ? 1 : 0;
            sql.run`
                INSERT INTO kei_clipboard(id, text, created_at, guard_visible)
                VALUES (${randomUUID()}, ${text}, ${createdAt}, ${visible})
                ON CONFLICT(text) DO UPDATE SET created_at = excluded.created_at,
                    guard_visible = MAX(guard_visible, excluded.guard_visible)`;
            pruneHistory();
        });
    }

    // Under the guard, mutations reach only the entries the guarded list shows.
    const minVisible = guarded => (guarded ? 1 : 0);
    // Unpinning can push the unpinned history past its cap, so it prunes like a copy does.
    const setPinned = (id, pinned, { guarded = false } = {}) => withTransaction(db, () => {
        const changed = sql.run`
            UPDATE kei_clipboard SET pinned = ${pinned ? 1 : 0}
            WHERE id = ${id} AND guard_visible >= ${minVisible(guarded)}`.changes > 0;
        if (changed && !pinned) pruneHistory();
        return changed;
    });
    const remove = (id, { guarded = false } = {}) => sql.run`
        DELETE FROM kei_clipboard WHERE id = ${id} AND guard_visible >= ${minVisible(guarded)}`.changes > 0;
    const clearUnpinned = ({ guarded = false } = {}) => {
        sql.run`DELETE FROM kei_clipboard WHERE pinned = 0 AND guard_visible >= ${minVisible(guarded)}`;
    };

    return { list, add, setPinned, remove, clearUnpinned };
}

module.exports = { createClipboardStore, CLIPBOARD_HISTORY_LIMIT, CLIPBOARD_TEXT_LIMIT };
