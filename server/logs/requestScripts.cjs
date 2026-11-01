'use strict';

const { getRequestLogMaxBytes, MIN_REQUEST_LOG_BYTES } = require('./requestLogLimits.cjs');

function createScriptStore(db) {
    const upsert = db.prepare(`
        INSERT INTO request_script.script (rowid, id, timestamp, body, header, response)
        SELECT rowid, id, timestamp, @body, @header, @response FROM metadata WHERE id = @id
        ON CONFLICT(id) DO UPDATE SET timestamp = excluded.timestamp,
            body = excluded.body, header = excluded.header, response = excluded.response
    `);
    const update = db.prepare(`
        UPDATE request_script.script SET response = @response WHERE id = @id
    `);
    const remove = db.prepare('DELETE FROM request_script.script WHERE id = ?');
    const clear = db.prepare('DELETE FROM request_script.script');
    const oldest = db.prepare('SELECT id FROM request_script.script ORDER BY timestamp, rowid LIMIT 1');
    const exists = db.prepare('SELECT 1 FROM request_script.script WHERE id = ?');
    const originalBytes = db.prepare(`
        SELECT length(CAST(body AS BLOB)) + length(CAST(header AS BLOB)) AS bytes
        FROM request_script.script WHERE id = ?
    `);
    const pageSize = db.prepare('PRAGMA request_script.page_size');
    const pageCount = db.prepare('PRAGMA request_script.page_count');
    const freelistCount = db.prepare('PRAGMA request_script.freelist_count');

    function trim(maxBytes = getRequestLogMaxBytes()) {
        const bytesPerPage = pageSize.get().page_size;
        // FULL auto-vacuum removes free pages at commit; WAL is outside this budget.
        while ((pageCount.get().page_count - freelistCount.get().freelist_count) * bytesPerPage > maxBytes) {
            const row = oldest.get();
            if (!row) break;
            remove.run(row.id);
        }
    }

    return {
        trim,
        getStorage() {
            return {
                currentBytes: pageCount.get().page_count * pageSize.get().page_size,
                maxBytes: getRequestLogMaxBytes(),
                minBytes: MIN_REQUEST_LOG_BYTES,
            };
        },
        upsert(log) {
            const maxBytes = getRequestLogMaxBytes();
            const bytes = Buffer.byteLength(log.body) + Buffer.byteLength(log.header)
                + Buffer.byteLength(log.response);
            if (bytes > maxBytes) {
                remove.run(log.id);
                return false;
            }
            upsert.run(log);
            trim(maxBytes);
            return Boolean(exists.get(log.id));
        },
        updateResponse(log) {
            const original = originalBytes.get(log.id);
            if (!original) return;
            const maxBytes = getRequestLogMaxBytes();
            if (original.bytes + Buffer.byteLength(log.response) > maxBytes) remove.run(log.id);
            else update.run(log);
            trim(maxBytes);
        },
        delete(id) { remove.run(id); },
        clear() { clear.run(); },
    };
}

module.exports = { createScriptStore };
