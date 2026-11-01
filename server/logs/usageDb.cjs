'use strict';

const { encoding_for_model, get_encoding } = require('@dqbd/tiktoken');
const { requestDb: db } = require('./logDatabases.cjs');
const { extractRequestModel } = require('./requestMetadata.cjs');

const USAGE_LIST_LIMIT = 100;

// Listing, counting, and summaries read the `reported_usage` view (see logDatabases.cjs).
const sql = db.createTagStore();
const fallbackOpenAIEncoding = get_encoding('o200k_base');

const camelCase = name => name.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
const toUsage = ({ seq, usage_json, ...row }) =>
    Object.fromEntries(Object.entries(row).map(([key, value]) => [camelCase(key), value]));

function upsertUsage(usage) {
    sql.run`
        INSERT INTO usage (
            job_id, timestamp, chat_id, provider, model,
            prompt_tokens, completion_tokens, total_tokens,
            cached_tokens, cache_read_tokens, cache_creation_tokens, reasoning_tokens,
            service_tier, gateway_cost, usage_json
        ) VALUES (
            ${usage.jobId}, ${usage.timestamp}, ${usage.chatId}, ${usage.provider}, ${usage.model},
            ${usage.promptTokens}, ${usage.completionTokens}, ${usage.totalTokens},
            ${usage.cachedTokens}, ${usage.cacheReadTokens}, ${usage.cacheCreationTokens}, ${usage.reasoningTokens},
            ${usage.serviceTier}, ${usage.gatewayCost}, ${usage.usageJson}
        )
        ON CONFLICT(job_id) DO UPDATE SET
            timestamp = excluded.timestamp, chat_id = excluded.chat_id,
            provider = excluded.provider, model = excluded.model,
            prompt_tokens = excluded.prompt_tokens, completion_tokens = excluded.completion_tokens,
            total_tokens = excluded.total_tokens, cached_tokens = excluded.cached_tokens,
            cache_read_tokens = excluded.cache_read_tokens,
            cache_creation_tokens = excluded.cache_creation_tokens,
            reasoning_tokens = excluded.reasoning_tokens, service_tier = excluded.service_tier,
            gateway_cost = excluded.gateway_cost, usage_json = excluded.usage_json
    `;
}

function getUsageByJobIds(jobIds) {
    const ids = [...new Set(
        (Array.isArray(jobIds) ? jobIds : [])
            .filter(id => typeof id === 'string' && id.length > 0)
            .map(id => id.slice(0, 128))
    )].slice(0, USAGE_LIST_LIMIT);
    if (ids.length === 0) return [];
    return sql.all`SELECT * FROM usage WHERE job_id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`
        .map(toUsage);
}

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

function extractServiceTier(body) {
    try {
        const parsed = JSON.parse(Buffer.from(body || '').toString('utf-8'));
        return typeof parsed?.service_tier === 'string' ? parsed.service_tier.slice(0, 32) : null;
    } catch {
        return null;
    }
}

function recordGenerationUsage(arg) {
    try {
        const provider = arg.usageProviderId || inferProvider(arg.targetUrl);
        const model = arg.usageModelId || extractRequestModel(arg.body, arg.targetUrl);
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
        if (usage.totalTokens === undefined
            && usage.promptTokens !== undefined
            && usage.completionTokens !== undefined) {
            usage.totalTokens = usage.promptTokens + usage.completionTokens;
        }
        upsertUsage({
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
                ?? extractServiceTier(arg.body),
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
        upsertUsage({
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
    const { start, end } = normalizeUsageRange(options);
    const limit = Math.min(
        Math.max(Number(options.limit) || USAGE_LIST_LIMIT, 1),
        USAGE_LIST_LIMIT,
    );
    const rows = options.beforeId
        ? sql.all`
            SELECT * FROM reported_usage WHERE timestamp BETWEEN ${start} AND ${end}
                AND (timestamp, seq) < (SELECT timestamp, rowid FROM usage WHERE job_id = ${String(options.beforeId).slice(0, 128)})
            ORDER BY timestamp DESC, seq DESC LIMIT ${limit}
        `
        : sql.all`
            SELECT * FROM reported_usage WHERE timestamp BETWEEN ${start} AND ${end}
            ORDER BY timestamp DESC, seq DESC LIMIT ${limit}
        `;
    return rows.map(toUsage);
}

function countUsage(options = {}) {
    const { start, end } = normalizeUsageRange(options);
    return sql.get`SELECT COUNT(*) AS total FROM reported_usage WHERE timestamp BETWEEN ${start} AND ${end}`.total;
}

function summarizeUsage(options = {}) {
    const { start, end } = normalizeUsageRange(options);
    return sql.all`
        SELECT * FROM reported_usage WHERE timestamp BETWEEN ${start} AND ${end} ORDER BY timestamp, seq
    `.map(row => {
        const { jobId, chatId, ...summary } = toUsage(row);
        return summary;
    });
}

function clearUsage() {
    sql.run`DELETE FROM usage`;
}

function deleteUsage(jobId) {
    return sql.run`DELETE FROM usage WHERE job_id = ${String(jobId).slice(0, 128)}`.changes === 1;
}


module.exports = {
    recordGenerationUsage,
    recordReportedUsage,
    getUsageByJobIds,
    listUsage,
    countUsage,
    summarizeUsage,
    clearUsage,
    deleteUsage,
};
