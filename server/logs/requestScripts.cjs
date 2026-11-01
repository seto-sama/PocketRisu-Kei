'use strict';

const { getRequestLogMaxBytes, MIN_REQUEST_LOG_BYTES } = require('./requestLogLimits.cjs');

function createScriptStore(db) {
    const sql = db.createTagStore();
    const remove = id => sql.run`DELETE FROM request_script.script WHERE id = ${id}`;
    const pageSize = () => sql.get`PRAGMA request_script.page_size`.page_size;
    const pageCount = () => sql.get`PRAGMA request_script.page_count`.page_count;

    function trim(maxBytes = getRequestLogMaxBytes()) {
        const bytesPerPage = pageSize();
        // FULL auto-vacuum removes free pages at commit; WAL is outside this budget.
        while ((pageCount() - sql.get`PRAGMA request_script.freelist_count`.freelist_count) * bytesPerPage > maxBytes) {
            const row = sql.get`SELECT id FROM request_script.script ORDER BY timestamp, rowid LIMIT 1`;
            if (!row) break;
            remove(row.id);
        }
    }

    return {
        trim,
        getStorage() {
            return {
                currentBytes: pageCount() * pageSize(),
                maxBytes: getRequestLogMaxBytes(),
                minBytes: MIN_REQUEST_LOG_BYTES,
            };
        },
        upsert({ id, body, header, response }) {
            const maxBytes = getRequestLogMaxBytes();
            if (Buffer.byteLength(body) + Buffer.byteLength(header) + Buffer.byteLength(response) > maxBytes) {
                remove(id);
                return false;
            }
            sql.run`
                INSERT INTO request_script.script (rowid, id, timestamp, body, header, response)
                SELECT rowid, id, timestamp, ${body}, ${header}, ${response} FROM metadata WHERE id = ${id}
                ON CONFLICT(id) DO UPDATE SET timestamp = excluded.timestamp,
                    body = excluded.body, header = excluded.header, response = excluded.response
            `;
            trim(maxBytes);
            return Boolean(sql.get`SELECT 1 FROM request_script.script WHERE id = ${id}`);
        },
        updateResponse({ id, response }) {
            const original = sql.get`
                SELECT length(CAST(body AS BLOB)) + length(CAST(header AS BLOB)) AS bytes
                FROM request_script.script WHERE id = ${id}
            `;
            if (!original) return;
            const maxBytes = getRequestLogMaxBytes();
            if (original.bytes + Buffer.byteLength(response) > maxBytes) remove(id);
            else sql.run`UPDATE request_script.script SET response = ${response} WHERE id = ${id}`;
            trim(maxBytes);
        },
        delete(id) { remove(id); },
        clear() { sql.run`DELETE FROM request_script.script`; },
    };
}

module.exports = { createScriptStore };
