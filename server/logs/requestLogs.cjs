'use strict';

const { withTransaction } = require('../sqlite.cjs');
const { maskSensitive } = require('./logs.cjs');
const { requestDb: db, scriptStore } = require('./logDatabases.cjs');
const { extractRequestModel } = require('./requestMetadata.cjs');
const { setRequestLogMaxBytes: saveRequestLogMaxBytes } = require('./requestLogLimits.cjs');

const REQUEST_LOG_LIST_LIMIT = 100;

const stmtUpsert = db.prepare(`
    INSERT INTO metadata (
        id, timestamp, date, url, success, response_type, chat_id,
        status, client_id, platform, duration_ms, model
    ) VALUES (
        @id, @timestamp, @date, @url, @success, @responseType, @chatId,
        @status, @clientId, @platform, @durationMs, @model
    )
    ON CONFLICT(id) DO UPDATE SET
        timestamp = excluded.timestamp,
        date = excluded.date,
        url = excluded.url,
        success = excluded.success,
        response_type = excluded.response_type,
        chat_id = excluded.chat_id,
        status = excluded.status,
        client_id = excluded.client_id,
        platform = excluded.platform,
        duration_ms = excluded.duration_ms,
        model = excluded.model
`);
function metadataColumns(alias) {
    return `${alias}.id, ${alias}.timestamp, ${alias}.date, ${alias}.url, ${alias}.success,
        ${alias}.response_type AS responseType, ${alias}.chat_id AS chatId, ${alias}.status,
        ${alias}.client_id AS clientId, ${alias}.platform, ${alias}.duration_ms AS responseDurationMs,
        ${alias}.model`;
}

const stmtQuery = db.prepare(`
    SELECT ${metadataColumns('log')} FROM metadata AS log
    ORDER BY log.timestamp DESC, log.rowid DESC LIMIT ?
`);
const stmtQueryBefore = db.prepare(`
    SELECT ${metadataColumns('log')}
    FROM metadata AS log JOIN metadata AS boundary ON boundary.id = ?
    WHERE log.timestamp < boundary.timestamp
        OR (log.timestamp = boundary.timestamp AND log.rowid < boundary.rowid)
    ORDER BY log.timestamp DESC, log.rowid DESC LIMIT ?
`);
const stmtCount = db.prepare('SELECT COUNT(*) AS total FROM metadata');
const stmtMetadataById = db.prepare(`
    SELECT ${metadataColumns('log')} FROM metadata AS log WHERE log.id = ?
`);
const detailColumns = `${metadataColumns('log')},
    COALESCE(payload.body, '') AS body, COALESCE(payload.header, '') AS header,
    COALESCE(payload.response, '') AS response, payload.id IS NOT NULL AS payloadAvailable`;
const stmtQueryById = db.prepare(`
    SELECT ${detailColumns} FROM metadata AS log
    LEFT JOIN request_script.script AS payload ON payload.id = log.id WHERE log.id = ?
`);
const stmtQueryByChatId = db.prepare(`
    SELECT ${detailColumns} FROM metadata AS log
    LEFT JOIN request_script.script AS payload ON payload.id = log.id WHERE log.chat_id = ?
    ORDER BY log.timestamp DESC, log.rowid DESC LIMIT 1
`);
const stmtClearAll = db.prepare('DELETE FROM metadata');
const stmtDeleteById = db.prepare('DELETE FROM metadata WHERE id = ?');
const stmtUpdateById = db.prepare(`
    UPDATE metadata
    SET success = @success, status = COALESCE(@status, status), response_type = 'stream',
        duration_ms = MAX(0, @completedAt - timestamp)
    WHERE id = @id
`);
function sanitize(value) {
    return maskSensitive(String(value ?? ''));
}

function normalizeLog(log) {
    const payload = { body: sanitize(log.body), header: sanitize(log.header), response: sanitize(log.response) };
    return {
        ...payload,
        id: String(log.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`).slice(0, 128),
        timestamp: typeof log.timestamp === 'number' ? log.timestamp : Date.now(),
        date: String(log.date ?? '').slice(0, 64),
        url: sanitize(log.url).slice(0, 4096),
        model: extractRequestModel(log.body, log.url),
        success: log.success ? 1 : 0,
        responseType: log.responseType ? String(log.responseType).slice(0, 64) : null,
        chatId: log.chatId ? String(log.chatId).slice(0, 128) : null,
        status: Number.isInteger(log.status) ? log.status : null,
        clientId: log.clientId ? String(log.clientId).slice(0, 64) : null,
        platform: log.platform ? String(log.platform).slice(0, 128) : null,
        durationMs: Number.isFinite(log.durationMs) ? Math.max(0, Math.round(log.durationMs)) : null,
    };
}

function writeImmediately(fn) {
    return withTransaction(db, fn, 'IMMEDIATE');
}

function addRequestLog(log) {
    const entry = normalizeLog(log);
    writeImmediately(() => {
        stmtUpsert.run(entry);
        scriptStore.upsert(entry);
    });
}

function getRequestLogStorage() {
    return scriptStore.getStorage();
}

function setRequestLogMaxBytes(maxBytes) {
    saveRequestLogMaxBytes(maxBytes);
    writeImmediately(() => scriptStore.trim());
    return getRequestLogStorage();
}

function clearRequestLogs(scope) {
    writeImmediately(() => {
        scriptStore.clear();
        if (scope === 'all') stmtClearAll.run();
    });
}

function deleteRequestLog(id) {
    const key = String(id).slice(0, 128);
    return writeImmediately(() => {
        scriptStore.delete(key);
        return stmtDeleteById.run(key).changes === 1;
    });
}

function updateRequestLogResponseById(id, response, status, success = true, completedAt = Date.now()) {
    if (!id) return false;
    const entry = {
        id: String(id).slice(0, 128), response: sanitize(response),
        success: success ? 1 : 0, status: Number.isInteger(status) ? status : null,
        completedAt: Number.isFinite(completedAt) ? Math.round(completedAt) : Date.now(),
    };
    return writeImmediately(() => {
        if (stmtUpdateById.run(entry).changes !== 1) return false;
        scriptStore.updateResponse(entry);
        return true;
    });
}

function mapRequestLog(row) {
    if (!row) return null;
    return {
        ...row,
        success: row.success === 1,
        ...(row.payloadAvailable !== undefined ? { payloadAvailable: row.payloadAvailable === 1 } : {}),
    };
}

function queryRequestLogs(options = {}) {
    if (typeof options === 'number') options = { limit: options };
    const safeLimit = Math.min(Math.max(Number(options.limit) || REQUEST_LOG_LIST_LIMIT, 1), REQUEST_LOG_LIST_LIMIT);
    const rows = options.beforeId
        ? stmtQueryBefore.all(String(options.beforeId).slice(0, 128), safeLimit)
        : stmtQuery.all(safeLimit);
    return rows.map(mapRequestLog);
}

function countRequestLogs() {
    return stmtCount.get().total;
}

function queryRequestLogById(id) {
    if (!id) return null;
    return mapRequestLog(stmtQueryById.get(String(id).slice(0, 128)));
}

function queryRequestLogMetadataById(id) {
    if (!id) return null;
    return mapRequestLog(stmtMetadataById.get(String(id).slice(0, 128)));
}

function queryRequestLogByChatId(chatId) {
    if (!chatId) return null;
    return mapRequestLog(stmtQueryByChatId.get(String(chatId).slice(0, 128)));
}

function enrichRequestLogs(logs, getUsageByJobIds) {
    if (!getUsageByJobIds || logs.length === 0) return logs;
    const usageRows = getUsageByJobIds(logs.map(log => log.id));
    const usageByJobId = new Map(usageRows.map(usage => [usage.jobId, usage]));
    return logs.map(log => {
        const usage = usageByJobId.get(log.id);
        return {
            ...log,
            provider: usage?.provider ?? undefined,
            model: usage?.model ?? log.model ?? undefined,
            promptTokens: usage?.promptTokens ?? undefined,
            completionTokens: usage?.completionTokens ?? undefined,
        };
    });
}

module.exports = {
    getRequestLogStorage,
    setRequestLogMaxBytes,
    enrichRequestLogs,
    addRequestLog,
    queryRequestLogs,
    queryRequestLogById,
    queryRequestLogMetadataById,
    queryRequestLogByChatId,
    countRequestLogs,
    clearRequestLogs,
    deleteRequestLog,
    updateRequestLogResponseById,
};
