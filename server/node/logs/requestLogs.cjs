'use strict';

const { maskSensitive } = require('./logs.cjs');
const { db } = require('./requestLogDb.cjs');

const MAX_FIELD_BYTES = 4 * 1024 * 1024;
const REQUEST_LOG_LIST_LIMIT = 100;

db.exec(`
    CREATE TABLE IF NOT EXISTS request_logs (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        date TEXT NOT NULL,
        url TEXT NOT NULL,
        body TEXT NOT NULL,
        header TEXT NOT NULL,
        response TEXT NOT NULL,
        success INTEGER NOT NULL,
        response_type TEXT,
        chat_id TEXT,
        status INTEGER,
        client_id TEXT,
        platform TEXT,
        duration_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_request_logs_timestamp ON request_logs(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_request_logs_chat_id_timestamp
        ON request_logs(chat_id, timestamp DESC);
`);
const requestLogColumns = new Set(
    db.prepare(`PRAGMA table_info(request_logs)`).all().map(column => column.name)
);
if (!requestLogColumns.has('duration_ms')) {
    db.exec(`ALTER TABLE request_logs ADD COLUMN duration_ms INTEGER`);
}

const stmtUpsert = db.prepare(`
    INSERT INTO request_logs
        (id, timestamp, date, url, body, header, response, success, response_type, chat_id, status, client_id, platform, duration_ms)
    VALUES
        (@id, @timestamp, @date, @url, @body, @header, @response, @success, @responseType, @chatId, @status, @clientId, @platform, @durationMs)
    ON CONFLICT(id) DO UPDATE SET
        timestamp = excluded.timestamp,
        date = excluded.date,
        url = excluded.url,
        body = excluded.body,
        header = excluded.header,
        response = excluded.response,
        success = excluded.success,
        response_type = excluded.response_type,
        chat_id = excluded.chat_id,
        status = excluded.status,
        client_id = excluded.client_id,
        platform = excluded.platform,
        duration_ms = excluded.duration_ms
`);

const stmtQuery = db.prepare(`
    SELECT
        id,
        timestamp,
        date,
        url,
        success,
        response_type AS responseType,
        chat_id AS chatId,
        status,
        client_id AS clientId,
        platform,
        duration_ms AS responseDurationMs
    FROM request_logs
    ORDER BY timestamp DESC, rowid DESC
    LIMIT ?
`);
const stmtQueryBefore = db.prepare(`
    SELECT
        current.id,
        current.timestamp,
        current.date,
        current.url,
        current.success,
        current.response_type AS responseType,
        current.chat_id AS chatId,
        current.status,
        current.client_id AS clientId,
        current.platform,
        current.duration_ms AS responseDurationMs
    FROM request_logs AS current
    JOIN request_logs AS boundary ON boundary.id = ?
    WHERE current.timestamp < boundary.timestamp
        OR (current.timestamp = boundary.timestamp AND current.rowid < boundary.rowid)
    ORDER BY current.timestamp DESC, current.rowid DESC
    LIMIT ?
`);
const stmtCount = db.prepare(`SELECT COUNT(*) AS total FROM request_logs`);
const stmtQueryById = db.prepare(`
    SELECT
        id,
        timestamp,
        date,
        url,
        body,
        header,
        response,
        success,
        response_type AS responseType,
        chat_id AS chatId,
        status,
        client_id AS clientId,
        platform,
        duration_ms AS responseDurationMs
    FROM request_logs
    WHERE id = ?
`);
const stmtQueryByChatId = db.prepare(`
    SELECT
        id,
        timestamp,
        date,
        url,
        body,
        header,
        response,
        success,
        response_type AS responseType,
        chat_id AS chatId,
        status,
        client_id AS clientId,
        platform,
        duration_ms AS responseDurationMs
    FROM request_logs
    WHERE chat_id = ?
    ORDER BY timestamp DESC, rowid DESC
    LIMIT 1
`);

const stmtClearAll = db.prepare(`DELETE FROM request_logs`);
const stmtDeleteById = db.prepare(`DELETE FROM request_logs WHERE id = ?`);
const stmtUpdateById = db.prepare(`
    UPDATE request_logs
    SET response = ?, success = ?, status = COALESCE(?, status), response_type = 'stream',
        duration_ms = MAX(0, ? - timestamp)
    WHERE id = ?
`);

function truncate(value) {
    const text = maskSensitive(String(value ?? ''));
    if (Buffer.byteLength(text, 'utf8') <= MAX_FIELD_BYTES) return text;
    return Buffer.from(text, 'utf8').subarray(0, MAX_FIELD_BYTES).toString('utf8') + '...[truncated]';
}

function normalizeLog(log) {
    return {
        id: String(log.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`).slice(0, 128),
        timestamp: typeof log.timestamp === 'number' ? log.timestamp : Date.now(),
        date: String(log.date ?? '').slice(0, 64),
        url: truncate(log.url).slice(0, 4096),
        body: truncate(log.body),
        header: truncate(log.header),
        response: truncate(log.response),
        success: log.success ? 1 : 0,
        responseType: log.responseType ? String(log.responseType).slice(0, 64) : null,
        chatId: log.chatId ? String(log.chatId).slice(0, 128) : null,
        status: Number.isInteger(log.status) ? log.status : null,
        clientId: log.clientId ? String(log.clientId).slice(0, 64) : null,
        platform: log.platform ? String(log.platform).slice(0, 128) : null,
        durationMs: Number.isFinite(log.durationMs) ? Math.max(0, Math.round(log.durationMs)) : null,
    };
}

function addRequestLog(log) {
    stmtUpsert.run(normalizeLog(log));
}

function clearRequestLogs() {
    stmtClearAll.run();
}

function deleteRequestLog(id) {
    return stmtDeleteById.run(String(id).slice(0, 128)).changes === 1;
}

function updateRequestLogResponseById(id, response, status, success = true, completedAt = Date.now()) {
    if (!id) return false;
    const result = stmtUpdateById.run(
        truncate(response),
        success ? 1 : 0,
        Number.isInteger(status) ? status : null,
        Number.isFinite(completedAt) ? Math.round(completedAt) : Date.now(),
        String(id).slice(0, 128),
    );
    return result.changes === 1;
}

function mapRequestLog(row) {
    if (!row) return null;
    return {
        ...row,
        success: row.success === 1,
    };
}

function queryRequestLogs(options = {}) {
    if (typeof options === 'number') options = { limit: options };
    const safeLimit = Math.min(
        Math.max(Number(options.limit) || REQUEST_LOG_LIST_LIMIT, 1),
        REQUEST_LOG_LIST_LIMIT,
    );
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

function queryRequestLogByChatId(chatId) {
    if (!chatId) return null;
    return mapRequestLog(stmtQueryByChatId.get(String(chatId).slice(0, 128)));
}

function enrichRequestLogs(logs, getUsageByJobIds) {
    if (!getUsageByJobIds || logs.length === 0) return logs;
    const usageRows = getUsageByJobIds(logs.map(log => log.id));
    const usageByJobId = new Map(
        usageRows.map(usage => [usage.jobId, usage])
    );
    return logs.map(log => {
        const usage = usageByJobId.get(log.id);
        return {
            ...log,
            provider: usage?.provider ?? undefined,
            model: usage?.model ?? undefined,
            promptTokens: usage?.promptTokens ?? undefined,
            completionTokens: usage?.completionTokens ?? undefined,
        };
    });
}

function installRequestLogRoutes(app, { checkAuth, requireSyncClientId, getUsageByJobIds }) {
    app.get('/api/request-logs', async (req, res, next) => {
        if (!await checkAuth(req, res)) return;
        try {
            res.send({
                success: true,
                content: enrichRequestLogs(queryRequestLogs({
                    limit: req.query.limit,
                    beforeId: req.query.before_id,
                }), getUsageByJobIds),
                total: countRequestLogs(),
            });
        } catch (error) {
            next(error);
        }
    });

    app.get('/api/request-logs/chat/:chatId', async (req, res, next) => {
        if (!await checkAuth(req, res)) return;
        try {
            res.send({
                success: true,
                content: queryRequestLogByChatId(req.params.chatId),
            });
        } catch (error) {
            next(error);
        }
    });

    app.get('/api/request-logs/:id', async (req, res, next) => {
        if (!await checkAuth(req, res)) return;
        try {
            const log = queryRequestLogById(req.params.id);
            if (!log) return res.status(404).send({ error: 'request log not found' });
            res.send({ success: true, content: log });
        } catch (error) {
            next(error);
        }
    });

    app.delete('/api/request-logs', async (req, res, next) => {
        if (!await checkAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        try {
            clearRequestLogs();
            res.send({ success: true });
        } catch (error) {
            next(error);
        }
    });

    app.delete('/api/request-logs/:id', async (req, res, next) => {
        if (!await checkAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        try {
            res.send({ success: true, deleted: deleteRequestLog(req.params.id) });
        } catch (error) {
            next(error);
        }
    });
}

module.exports = {
    addRequestLog,
    queryRequestLogs,
    queryRequestLogById,
    queryRequestLogByChatId,
    countRequestLogs,
    clearRequestLogs,
    deleteRequestLog,
    updateRequestLogResponseById,
    installRequestLogRoutes,
};
