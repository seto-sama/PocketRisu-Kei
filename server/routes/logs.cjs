'use strict';

const { addLogBatch, queryLogs, countLogs, clearLogs, deleteLog } = require('../logs/logs.cjs');

const { queryRequestLogs, queryRequestLogByChatId, queryRequestLogById, countRequestLogs, clearRequestLogs, deleteRequestLog, enrichRequestLogs, getRequestLogStorage, setRequestLogMaxBytes } = require('../logs/requestLogs.cjs');

const { listUsage, countUsage, summarizeUsage, clearUsage, deleteUsage, recordReportedUsage, getUsageByJobIds } = require('../logs/usageDb.cjs');
const { queryProviderContexts } = require('../logs/providerContexts.cjs');

function installLogsRoutes(app, {
    checkAuth,
    requireSyncClientId,
}) {
    const LOGS_POST_MAX_ENTRIES = 1000;

    app.post('/api/provider-contexts/query', async (req, res) => {
        if (!await checkAuth(req, res)) return;
        const { responseIds, adapterKind, model } = req.body || {};
        if (!Array.isArray(responseIds) || !responseIds.every(id => typeof id === 'string')
            || typeof adapterKind !== 'string' || !adapterKind || typeof model !== 'string' || !model) {
            res.status(400).send({ error: 'responseIds, adapterKind and model are required' });
            return;
        }
        res.send({ records: queryProviderContexts(responseIds, adapterKind, model) });
    });

    app.post('/api/logs', async (req, res) => {
        if (!await checkAuth(req, res)) return;
        const body = req.body;
        const entries = Array.isArray(body) ? body : [body];
        if (entries.length === 0) {
            return res.send({ success: true, written: 0 });
        }
        if (entries.length > LOGS_POST_MAX_ENTRIES) {
            return res.status(413).send({ error: `too many entries (max ${LOGS_POST_MAX_ENTRIES})` });
        }
        const prepared = entries
            .filter(e => e && typeof e === 'object' && typeof e.message === 'string')
            .map(e => ({
                timestamp: typeof e.timestamp === 'number' ? e.timestamp : Date.now(),
                level: e.level,
                origin: 'client',
                message: e.message,
                description: e.description,
                source: e.source,
                count: e.count,
                platform: e.platform,
                clientId: e.clientId,
                userAgent: e.userAgent,
            }));
        const written = addLogBatch(prepared);
        res.send({ success: true, written });
    });

    app.get('/api/logs', async (req, res) => {
        if (!await checkAuth(req, res)) return;
        const parseCsv = (v) => typeof v === 'string' && v.length ? v.split(',').filter(Boolean) : undefined;
        const filterArgs = {
            level: typeof req.query.level === 'string' ? req.query.level : undefined,
            origin: typeof req.query.origin === 'string' ? req.query.origin : undefined,
            since: req.query.since ? Number(req.query.since) : undefined,
            excludeLevels: parseCsv(req.query.exclude_levels),
            excludeOrigins: parseCsv(req.query.exclude_origins),
            excludeBackground: req.query.exclude_background === '1',
        };
        const rows = queryLogs({
            ...filterArgs,
            beforeId: req.query.before_id ? Number(req.query.before_id) : undefined,
            limit: req.query.limit ? Number(req.query.limit) : undefined,
        });
        // total reflects rows matching the same filter — pagination math depends on it.
        res.send({ success: true, content: rows, total: countLogs(filterArgs) });
    });

    app.delete('/api/logs', async (req, res) => {
        if (!await checkAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        clearLogs();
        res.send({ success: true });
    });

    app.delete('/api/logs/:id', async (req, res) => {
        if (!await checkAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        const id = Number(req.params.id);
        if (!Number.isSafeInteger(id) || id <= 0) {
            return res.status(400).send({ error: 'invalid log id' });
        }
        res.send({ success: true, deleted: deleteLog(id) });
    });
    app.get('/api/request-logs', async (req, res) => {
        if (!await checkAuth(req, res)) return;
        res.send({
            success: true,
            content: enrichRequestLogs(queryRequestLogs({
                limit: req.query.limit,
                beforeId: req.query.before_id,
            }), getUsageByJobIds),
            total: countRequestLogs(),
            storage: getRequestLogStorage(),
        });
    });

    app.put('/api/request-logs/limits', async (req, res, next) => {
        if (!await checkAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        try {
            res.send(setRequestLogMaxBytes(req.body?.maxBytes));
        } catch (error) {
            if (error instanceof RangeError) return res.status(400).send({ success: false });
            next(error);
        }
    });

    app.get('/api/request-logs/chat/:chatId', async (req, res) => {
        if (!await checkAuth(req, res)) return;
        res.send({
            success: true,
            content: queryRequestLogByChatId(req.params.chatId),
        });
    });

    app.get('/api/request-logs/:id', async (req, res) => {
        if (!await checkAuth(req, res)) return;
        const log = queryRequestLogById(req.params.id);
        if (!log) return res.status(404).send({ error: 'request log not found' });
        res.send({ success: true, content: log });
    });

    app.delete('/api/request-logs', async (req, res) => {
        if (!await checkAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        const scope = req.query.scope;
        if (scope !== 'payload' && scope !== 'all') {
            return res.status(400).send({ success: false });
        }
        clearRequestLogs(scope);
        res.send({ success: true });
    });

    app.delete('/api/request-logs/:id', async (req, res) => {
        if (!await checkAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        res.send({ success: true, deleted: deleteRequestLog(req.params.id) });
    });
    app.get('/api/usage', async (req, res) => {
        if (!await checkAuth(req, res)) return;
        const range = { start: req.query.start, end: req.query.end };
        res.send({
            success: true,
            content: listUsage({
                limit: req.query.limit,
                beforeId: req.query.before_id,
                ...range,
            }),
            total: countUsage(range),
        });
    });
    app.get('/api/usage/summary', async (req, res) => {
        if (!await checkAuth(req, res)) return;
        res.send({
            success: true,
            content: summarizeUsage({
                start: req.query.start,
                end: req.query.end,
            }),
        });
    });
    app.delete('/api/usage', async (req, res) => {
        if (!await checkAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        clearUsage();
        res.send({ success: true });
    });
    app.delete('/api/usage/:jobId', async (req, res) => {
        if (!await checkAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        res.send({ success: true, deleted: deleteUsage(req.params.jobId) });
    });
    app.post('/api/usage/:jobId', async (req, res) => {
        if (!await checkAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        res.send({
            success: recordReportedUsage({
                ...req.body,
                jobId: req.params.jobId,
            }),
        });
    });

}

module.exports = { installLogsRoutes };
