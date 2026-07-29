'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { maskSensitive } = require('./logs.cjs');

const MAX_FIELD_BYTES = 4 * 1024 * 1024;

const saveDir = path.join(process.cwd(), 'save');
if (!fs.existsSync(saveDir)) {
    fs.mkdirSync(saveDir, { recursive: true });
}

const dbPath = path.join(saveDir, 'request-logs.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');

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
        platform TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_request_logs_timestamp ON request_logs(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_request_logs_chat_id_timestamp
        ON request_logs(chat_id, timestamp DESC);
`);

const stmtUpsert = db.prepare(`
    INSERT INTO request_logs
        (id, timestamp, date, url, body, header, response, success, response_type, chat_id, status, client_id, platform)
    VALUES
        (@id, @timestamp, @date, @url, @body, @header, @response, @success, @responseType, @chatId, @status, @clientId, @platform)
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
        platform = excluded.platform
`);

const stmtQuery = db.prepare(`
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
        platform
    FROM request_logs
    ORDER BY timestamp DESC, rowid DESC
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
        platform
    FROM request_logs
    WHERE chat_id = ?
    ORDER BY timestamp DESC, rowid DESC
    LIMIT 1
`);

const stmtClearAll = db.prepare(`DELETE FROM request_logs`);
const stmtDeleteById = db.prepare(`DELETE FROM request_logs WHERE id = ?`);
const stmtUpdateById = db.prepare(`
    UPDATE request_logs
    SET response = ?, success = ?, status = COALESCE(?, status), response_type = 'stream'
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

function updateRequestLogResponseById(id, response, status, success = true) {
    if (!id) return false;
    const result = stmtUpdateById.run(
        truncate(response),
        success ? 1 : 0,
        Number.isInteger(status) ? status : null,
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

function queryRequestLogs() {
    return stmtQuery.all().map(mapRequestLog);
}

function queryRequestLogByChatId(chatId) {
    if (!chatId) return null;
    return mapRequestLog(stmtQueryByChatId.get(String(chatId).slice(0, 128)));
}

function installRequestLogRoutes(app, { checkAuth, requireSyncClientId }) {
    app.get('/api/request-logs', async (req, res, next) => {
        if (!await checkAuth(req, res)) return;
        try {
            res.send({ success: true, content: queryRequestLogs() });
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
    queryRequestLogByChatId,
    clearRequestLogs,
    deleteRequestLog,
    updateRequestLogResponseById,
    installRequestLogRoutes,
};
