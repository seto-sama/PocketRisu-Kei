'use strict';

const Database = require('better-sqlite3');
const { encoding_for_model, get_encoding } = require('@dqbd/tiktoken');
const path = require('path');
const fs = require('fs');

const USAGE_LIST_LIMIT = 100;

const saveDir = path.join(process.cwd(), 'save');
if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });

const db = new Database(path.join(saveDir, 'usage.db'));
db.pragma('journal_mode = WAL');
db.pragma('synchronous = FULL');
db.pragma('busy_timeout = 5000');

db.exec(`
    CREATE TABLE IF NOT EXISTS generation_usage (
        job_id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        chat_id TEXT,
        provider TEXT,
        model TEXT,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        total_tokens INTEGER,
        cached_tokens INTEGER,
        cache_read_tokens INTEGER,
        cache_creation_tokens INTEGER,
        reasoning_tokens INTEGER,
        service_tier TEXT,
        gateway_cost REAL,
        usage_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_generation_usage_timestamp
        ON generation_usage(timestamp DESC);
`);
const usageColumns = new Set(
    db.prepare(`PRAGMA table_info(generation_usage)`).all().map(column => column.name)
);
if (!usageColumns.has('reasoning_tokens')) {
    db.exec(`ALTER TABLE generation_usage ADD COLUMN reasoning_tokens INTEGER`);
}
if (!usageColumns.has('service_tier')) {
    db.exec(`ALTER TABLE generation_usage ADD COLUMN service_tier TEXT`);
}
if (!usageColumns.has('gateway_cost')) {
    db.exec(`ALTER TABLE generation_usage ADD COLUMN gateway_cost REAL`);
}

const stmtUpsert = db.prepare(`
    INSERT INTO generation_usage (
        job_id, timestamp, chat_id, provider, model,
        prompt_tokens, completion_tokens, total_tokens,
        cached_tokens, cache_read_tokens, cache_creation_tokens, reasoning_tokens,
        service_tier, gateway_cost, usage_json
    ) VALUES (
        @jobId, @timestamp, @chatId, @provider, @model,
        @promptTokens, @completionTokens, @totalTokens,
        @cachedTokens, @cacheReadTokens, @cacheCreationTokens, @reasoningTokens,
        @serviceTier, @gatewayCost, @usageJson
    )
    ON CONFLICT(job_id) DO UPDATE SET
        timestamp = excluded.timestamp,
        chat_id = excluded.chat_id,
        provider = excluded.provider,
        model = excluded.model,
        prompt_tokens = excluded.prompt_tokens,
        completion_tokens = excluded.completion_tokens,
        total_tokens = excluded.total_tokens,
        cached_tokens = excluded.cached_tokens,
        cache_read_tokens = excluded.cache_read_tokens,
        cache_creation_tokens = excluded.cache_creation_tokens,
        reasoning_tokens = excluded.reasoning_tokens,
        service_tier = excluded.service_tier,
        gateway_cost = excluded.gateway_cost,
        usage_json = excluded.usage_json
`);

const stmtList = db.prepare(`
    SELECT
        job_id AS jobId, timestamp, chat_id AS chatId, provider, model,
        prompt_tokens AS promptTokens, completion_tokens AS completionTokens,
        total_tokens AS totalTokens, cached_tokens AS cachedTokens,
        cache_read_tokens AS cacheReadTokens,
        cache_creation_tokens AS cacheCreationTokens,
        reasoning_tokens AS reasoningTokens,
        service_tier AS serviceTier, gateway_cost AS gatewayCost
    FROM generation_usage
    WHERE timestamp >= ? AND timestamp <= ?
    ORDER BY timestamp DESC, rowid DESC
    LIMIT ?
`);
const stmtListBefore = db.prepare(`
    SELECT
        current.job_id AS jobId, current.timestamp, current.chat_id AS chatId,
        current.provider, current.model,
        current.prompt_tokens AS promptTokens,
        current.completion_tokens AS completionTokens,
        current.total_tokens AS totalTokens,
        current.cached_tokens AS cachedTokens,
        current.cache_read_tokens AS cacheReadTokens,
        current.cache_creation_tokens AS cacheCreationTokens,
        current.reasoning_tokens AS reasoningTokens,
        current.service_tier AS serviceTier,
        current.gateway_cost AS gatewayCost
    FROM generation_usage AS current
    JOIN generation_usage AS boundary ON boundary.job_id = ?
    WHERE current.timestamp >= ? AND current.timestamp <= ?
        AND (
            current.timestamp < boundary.timestamp
            OR (current.timestamp = boundary.timestamp AND current.rowid < boundary.rowid)
        )
    ORDER BY current.timestamp DESC, current.rowid DESC
    LIMIT ?
`);
const stmtCountRange = db.prepare(`
    SELECT COUNT(*) AS total
    FROM generation_usage
    WHERE timestamp >= ? AND timestamp <= ?
`);
const stmtSummaryRange = db.prepare(`
    SELECT
        timestamp, provider, model,
        prompt_tokens AS promptTokens,
        completion_tokens AS completionTokens,
        total_tokens AS totalTokens,
        cached_tokens AS cachedTokens,
        cache_read_tokens AS cacheReadTokens,
        cache_creation_tokens AS cacheCreationTokens,
        reasoning_tokens AS reasoningTokens,
        service_tier AS serviceTier,
        gateway_cost AS gatewayCost
    FROM generation_usage
    WHERE timestamp >= ? AND timestamp <= ?
    ORDER BY timestamp ASC, rowid ASC
`);
const stmtTotals = db.prepare(`
    SELECT
        COUNT(*) AS requests,
        COALESCE(SUM(prompt_tokens), 0) AS promptTokens,
        COALESCE(SUM(completion_tokens), 0) AS completionTokens,
        COALESCE(SUM(total_tokens), 0) AS totalTokens,
        COALESCE(SUM(cached_tokens), 0) AS cachedTokens,
        COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens,
        COALESCE(SUM(cache_creation_tokens), 0) AS cacheCreationTokens,
        COALESCE(SUM(reasoning_tokens), 0) AS reasoningTokens
    FROM generation_usage
`);
const stmtClear = db.prepare(`DELETE FROM generation_usage`);
const stmtDelete = db.prepare(`DELETE FROM generation_usage WHERE job_id = ?`);
const fallbackOpenAIEncoding = get_encoding('o200k_base');

function number(value) {
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : null;
}

function decimal(value) {
    if (value === null || value === undefined || value === '') return null;
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function estimateOpenAICompletionTokens(text, model) {
    if (typeof text !== 'string' || text.length === 0) return null;
    let encoder = fallbackOpenAIEncoding;
    let disposable = false;
    if (typeof model === 'string' && model.length > 0) {
        try {
            encoder = encoding_for_model(model);
            disposable = true;
        } catch {
            // Newly released model IDs may not be known by this tiktoken build.
            // Current OpenAI text models use the o200k family, which is a much
            // closer fallback than treating a visible response as zero tokens.
        }
    }
    try {
        return encoder.encode(text).length;
    } finally {
        if (disposable) encoder.free();
    }
}

function mergeUsage(target, raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    const assign = (key, ...values) => {
        for (const value of values) {
            const normalized = number(value);
            if (normalized !== null) target[key] = normalized;
        }
    };

    assign('promptTokens', raw.promptTokens, raw.prompt_tokens, raw.input_tokens, raw.promptTokenCount);
    assign('completionTokens', raw.completionTokens, raw.completion_tokens, raw.output_tokens, raw.candidatesTokenCount);
    assign('totalTokens', raw.totalTokens, raw.total_tokens, raw.totalTokenCount);
    assign(
        'cachedTokens',
        raw.cachedTokens,
        raw.cached_tokens,
        raw.cachedContentTokenCount,
        raw.prompt_tokens_details?.cached_tokens,
        raw.input_tokens_details?.cached_tokens,
    );
    assign('cacheReadTokens', raw.cacheReadTokens, raw.cache_read_input_tokens, raw.cache_read_tokens);
    assign('cacheCreationTokens', raw.cacheCreationTokens, raw.cache_creation_input_tokens, raw.cache_creation_tokens);
    assign(
        'reasoningTokens',
        raw.reasoningTokens,
        raw.reasoning_tokens,
        raw.completion_tokens_details?.reasoning_tokens,
        raw.output_tokens_details?.reasoning_tokens,
    );
}

function responsePayloads(rawBuffer) {
    const text = Buffer.from(rawBuffer || '').toString('utf-8');
    const payloads = [];
    for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try { payloads.push(JSON.parse(data)); } catch { /* incomplete/non-JSON event */ }
    }
    if (payloads.length === 0) {
        try {
            const parsed = JSON.parse(text);
            if (Array.isArray(parsed)) payloads.push(...parsed);
            else payloads.push(parsed);
        } catch { /* provider returned no JSON usage */ }
    }
    return payloads;
}

function extractUsage(rawBuffer) {
    const usage = {};
    const rawUsage = [];
    for (const payload of responsePayloads(rawBuffer)) {
        if (typeof payload?.service_tier === 'string') usage.serviceTier = payload.service_tier;
        if (typeof payload?.response?.service_tier === 'string') usage.serviceTier = payload.response.service_tier;
        const candidates = [
            payload?.usage,
            payload?.usageMetadata,
            payload?.response?.usage,
            payload?.message?.usage,
        ];
        for (const candidate of candidates) {
            if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
            rawUsage.push(candidate);
            mergeUsage(usage, candidate);
            if (candidate.trafficType === 'ON_DEMAND_FLEX') usage.serviceTier = 'flex';
            else if (candidate.trafficType === 'ON_DEMAND' && !usage.serviceTier) usage.serviceTier = 'default';
            const gatewayCost = decimal(candidate.gateway_cost);
            if (gatewayCost !== null) usage.gatewayCost = gatewayCost;
        }
    }
    if (Object.keys(usage).length === 0) return null;
    if (usage.totalTokens === undefined
        && usage.promptTokens !== undefined
        && usage.completionTokens !== undefined) {
        usage.totalTokens = usage.promptTokens + usage.completionTokens;
    }
    return { ...usage, rawUsage };
}

function inferProvider(targetUrl) {
    try {
        const host = new URL(targetUrl).hostname.toLowerCase();
        if (host.includes('anthropic')) return 'anthropic';
        if (host.includes('aiplatform.googleapis')) return 'google-vertex';
        if (host.includes('generativelanguage')) return 'google';
        if (host.includes('bedrock-runtime') && host.endsWith('amazonaws.com')) return 'amazon-bedrock';
        if (host.includes('openrouter')) return 'openrouter';
        if (host.includes('openai')) return 'openai';
        return host || 'Unknown';
    } catch {
        return 'Unknown';
    }
}

function extractModel(bodyBase64, targetUrl) {
    try {
        const body = JSON.parse(Buffer.from(bodyBase64 || '', 'base64').toString('utf-8'));
        if (typeof body?.model === 'string') return body.model.slice(0, 256);
    } catch {
        // Some providers, notably Gemini, carry the model in the URL.
    }
    try {
        const match = new URL(targetUrl).pathname.match(/\/models\/([^:/?]+)/);
        return match?.[1] ? decodeURIComponent(match[1]).slice(0, 256) : null;
    } catch {
        return null;
    }
}

function extractServiceTier(bodyBase64) {
    try {
        const body = JSON.parse(Buffer.from(bodyBase64 || '', 'base64').toString('utf-8'));
        return typeof body?.service_tier === 'string' ? body.service_tier.slice(0, 32) : null;
    } catch {
        return null;
    }
}

function recordGenerationUsage(arg) {
    try {
        const provider = arg.usageProviderId || inferProvider(arg.targetUrl);
        const model = arg.usageModelId || extractModel(arg.bodyBase64, arg.targetUrl);
        const usage = extractUsage(arg.rawResponse) ?? { rawUsage: [] };
        if (usage.completionTokens === undefined
            && usage.promptTokens !== undefined
            && usage.totalTokens !== undefined
            && usage.totalTokens >= usage.promptTokens) {
            usage.completionTokens = usage.totalTokens - usage.promptTokens;
        }
        if (usage.completionTokens === undefined && provider === 'openai') {
            const estimatedCompletionTokens = estimateOpenAICompletionTokens(arg.outputText, model);
            if (estimatedCompletionTokens !== null) {
                usage.completionTokens = estimatedCompletionTokens;
                if (usage.promptTokens !== undefined) {
                    usage.totalTokens = usage.promptTokens + estimatedCompletionTokens;
                }
                usage.rawUsage.push({
                    estimated_completion_tokens: estimatedCompletionTokens,
                    estimation_source: 'local_tiktoken',
                });
            }
        }
        if (usage.promptTokens === undefined
            && usage.completionTokens === undefined
            && usage.totalTokens === undefined) {
            return false;
        }
        if (usage.totalTokens === undefined
            && usage.promptTokens !== undefined
            && usage.completionTokens !== undefined) {
            usage.totalTokens = usage.promptTokens + usage.completionTokens;
        }
        stmtUpsert.run({
            jobId: String(arg.jobId).slice(0, 128),
            timestamp: Number(arg.timestamp) || Date.now(),
            chatId: arg.chatId ? String(arg.chatId).slice(0, 128) : null,
            provider,
            model,
            promptTokens: usage.promptTokens ?? null,
            completionTokens: usage.completionTokens ?? null,
            totalTokens: usage.totalTokens ?? null,
            cachedTokens: usage.cachedTokens ?? null,
            cacheReadTokens: usage.cacheReadTokens ?? null,
            cacheCreationTokens: usage.cacheCreationTokens ?? null,
            reasoningTokens: usage.reasoningTokens ?? null,
            serviceTier: arg.usageServiceTier
                ?? usage.serviceTier
                ?? extractServiceTier(arg.bodyBase64),
            gatewayCost: usage.gatewayCost ?? null,
            usageJson: JSON.stringify(usage.rawUsage),
        });
        return true;
    } catch {
        // Usage accounting must never turn a successful generation into a failure.
        return false;
    }
}

function recordReportedUsage(arg) {
    try {
        const raw = arg.usage;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
        const usage = {};
        mergeUsage(usage, raw);
        if (Object.keys(usage).length === 0) return false;
        if (usage.totalTokens === undefined
            && usage.promptTokens !== undefined
            && usage.completionTokens !== undefined) {
            usage.totalTokens = usage.promptTokens + usage.completionTokens;
        }
        stmtUpsert.run({
            jobId: String(arg.jobId).slice(0, 128),
            timestamp: Number(arg.timestamp) || Date.now(),
            chatId: arg.chatId ? String(arg.chatId).slice(0, 128) : null,
            provider: arg.provider ? String(arg.provider).slice(0, 128) : null,
            model: arg.model ? String(arg.model).slice(0, 256) : null,
            promptTokens: usage.promptTokens ?? null,
            completionTokens: usage.completionTokens ?? null,
            totalTokens: usage.totalTokens ?? null,
            cachedTokens: usage.cachedTokens ?? null,
            cacheReadTokens: usage.cacheReadTokens ?? null,
            cacheCreationTokens: usage.cacheCreationTokens ?? null,
            reasoningTokens: usage.reasoningTokens ?? null,
            serviceTier: arg.serviceTier ? String(arg.serviceTier).slice(0, 32) : null,
            gatewayCost: decimal(raw.gateway_cost),
            usageJson: JSON.stringify([raw]),
        });
        return true;
    } catch {
        return false;
    }
}

function normalizeUsageRange(options = {}) {
    const start = Number(options.start);
    const end = Number(options.end);
    return {
        start: Number.isFinite(start) ? start : Number.MIN_SAFE_INTEGER,
        end: Number.isFinite(end) ? end : Number.MAX_SAFE_INTEGER,
    };
}

function listUsage(options = {}) {
    if (typeof options === 'number') options = { limit: options };
    const range = normalizeUsageRange(options);
    const limit = Math.min(
        Math.max(Number(options.limit) || USAGE_LIST_LIMIT, 1),
        USAGE_LIST_LIMIT,
    );
    return options.beforeId
        ? stmtListBefore.all(String(options.beforeId).slice(0, 128), range.start, range.end, limit)
        : stmtList.all(range.start, range.end, limit);
}

function countUsage(options = {}) {
    const range = normalizeUsageRange(options);
    return stmtCountRange.get(range.start, range.end).total;
}

function summarizeUsage(options = {}) {
    const range = normalizeUsageRange(options);
    return stmtSummaryRange.all(range.start, range.end);
}

function getUsageTotals() {
    return stmtTotals.get();
}

function clearUsage() {
    stmtClear.run();
}

function deleteUsage(jobId) {
    return stmtDelete.run(String(jobId).slice(0, 128)).changes === 1;
}

function installUsageRoutes(app, { checkAuth, requireSyncClientId }) {
    app.get('/api/usage', async (req, res, next) => {
        if (!await checkAuth(req, res)) return;
        try {
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
        } catch (error) {
            next(error);
        }
    });
    app.get('/api/usage/summary', async (req, res, next) => {
        if (!await checkAuth(req, res)) return;
        try {
            res.send({
                success: true,
                content: summarizeUsage({
                    start: req.query.start,
                    end: req.query.end,
                }),
            });
        } catch (error) {
            next(error);
        }
    });
    app.delete('/api/usage', async (req, res, next) => {
        if (!await checkAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        try {
            clearUsage();
            res.send({ success: true });
        } catch (error) {
            next(error);
        }
    });
    app.delete('/api/usage/:jobId', async (req, res, next) => {
        if (!await checkAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        try {
            res.send({ success: true, deleted: deleteUsage(req.params.jobId) });
        } catch (error) {
            next(error);
        }
    });
    app.post('/api/usage/:jobId', async (req, res, next) => {
        if (!await checkAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        try {
            res.send({
                success: recordReportedUsage({
                    ...req.body,
                    jobId: req.params.jobId,
                }),
            });
        } catch (error) {
            next(error);
        }
    });
}

module.exports = {
    recordGenerationUsage,
    recordReportedUsage,
    listUsage,
    countUsage,
    summarizeUsage,
    getUsageTotals,
    clearUsage,
    deleteUsage,
    installUsageRoutes,
};
