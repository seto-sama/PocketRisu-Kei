'use strict';

const JOB_TYPES = new Set([
    'model', 'submodel', 'memory', 'emotion', 'otherAx', 'translate',
]);

const OPERATION_JOB_TYPES = Object.freeze({
    translation: 'translate',
    'hypav3-summary': 'memory',
    'lua-llm': 'otherAx',
});

const WORKFLOW_STEP_STATUSES = new Set([
    'pending', 'running', 'waiting_client', 'waiting_job', 'output_ready',
    'completed', 'skipped', 'failed',
]);
const WORKFLOW_RECOVERY_POLICIES = new Set([
    'resume', 'replay_output', 'at_least_once', 'foreground_restart', 'skip',
]);
const WORKFLOW_TERMINAL_STATUSES = new Set(['completed', 'cancelled', 'failed']);
const WORKFLOW_KEY_PATTERN = /^[a-z0-9][a-z0-9._:/-]{0,127}$/;
const REMOTE_HYPA_MODELS = new Set([
    'custom', 'ada', 'openai3small', 'openai3large',
    'voyage4large', 'voyageContext3', 'voyageContext4',
]);
const SERVER_TOKENIZERS = new Set([
    'tik', 'mistral', 'novelai', 'claude', 'llama', 'llama3',
    'novellist', 'gemma', 'cohere', 'deepseek',
]);

function normalizeRevenantJobType(value) {
    return JOB_TYPES.has(value) ? value : 'model';
}

function isRevenantJobActive(status) {
    return status === 'queued' || status === 'generating';
}

function normalizeRevenantWorkflowPlan(value) {
    if (!Array.isArray(value) || value.length === 0 || value.length > 64) return undefined;
    const keys = new Set();
    const normalized = [];
    for (let index = 0; index < value.length; index++) {
        const step = value[index];
        if (!step || typeof step !== 'object' || Array.isArray(step)) return undefined;
        const key = typeof step.key === 'string' ? step.key : '';
        const kind = typeof step.kind === 'string' ? step.kind : '';
        const recoveryPolicy = typeof step.recoveryPolicy === 'string'
            ? step.recoveryPolicy
            : 'resume';
        const status = typeof step.status === 'string' ? step.status : 'pending';
        const metadata = step.metadata == null ? null
            : step.metadata && typeof step.metadata === 'object' && !Array.isArray(step.metadata)
                ? structuredClone(step.metadata)
                : undefined;
        if (
            !WORKFLOW_KEY_PATTERN.test(key)
            || !WORKFLOW_KEY_PATTERN.test(kind)
            || keys.has(key)
            || !WORKFLOW_RECOVERY_POLICIES.has(recoveryPolicy)
            || !['pending', 'completed', 'skipped'].includes(status)
            || metadata === undefined
        ) return undefined;
        keys.add(key);
        normalized.push({
            key,
            kind,
            recoveryPolicy,
            status,
            ...(metadata ? { metadata } : {}),
            order: index,
        });
    }
    return normalized;
}

function normalizeRevenantWorkflowStepUpdate(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const status = typeof value.status === 'string' ? value.status : '';
    if (!WORKFLOW_STEP_STATUSES.has(status)) return undefined;
    return {
        status,
        metadata: value.metadata && typeof value.metadata === 'object' && !Array.isArray(value.metadata)
            ? structuredClone(value.metadata)
            : null,
    };
}

function normalizeRevenantWorkflowTerminalStatus(value) {
    return WORKFLOW_TERMINAL_STATUSES.has(value) ? value : undefined;
}

function isValidRevenantWorkflowKey(value) {
    return typeof value === 'string' && WORKFLOW_KEY_PATTERN.test(value);
}

function hasRevenantWorkflowOwnerLease(workflow, clientId, ownerEpoch, active = true) {
    return !!workflow
        && (!active || workflow.status === 'active')
        && typeof clientId === 'string'
        && workflow.ownerClientId === clientId
        && Number.isSafeInteger(ownerEpoch)
        && ownerEpoch >= 1
        && workflow.ownerEpoch === ownerEpoch;
}

function normalizeRevenantOperationContext(jobType, value) {
    if (value === undefined || value === null) return null;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    if (typeof value.kind !== 'string' || typeof value.operationId !== 'string') return undefined;
    if (OPERATION_JOB_TYPES[value.kind] !== jobType) return undefined;

    switch (value.kind) {
        case 'translation':
            if (
                typeof value.cacheKey !== 'string'
                || !Array.isArray(value.styleDecodes)
                || !value.styleDecodes.every(item => typeof item === 'string')
                || typeof value.replaceExisting !== 'boolean'
            ) return undefined;
            break;
        case 'hypav3-summary':
            if (
                typeof value.characterId !== 'string'
                || typeof value.roomId !== 'string'
                || typeof value.batchId !== 'string'
                || !WORKFLOW_KEY_PATTERN.test(value.batchId)
                || !Array.isArray(value.chatMemos)
                || !value.chatMemos.every(item => typeof item === 'string')
            ) return undefined;
            break;
        case 'lua-llm':
            if (
                typeof value.executionKey !== 'string'
                || typeof value.replayKey !== 'string'
                || typeof value.characterId !== 'string'
                || typeof value.roomId !== 'string'
                || typeof value.mode !== 'string'
                || typeof value.code !== 'string'
                || typeof value.lowLevelAccess !== 'boolean'
                || typeof value.anchorMessageId !== 'string'
                || !Number.isInteger(value.callIndex)
            ) return undefined;
            break;
        default:
            return undefined;
    }

    return structuredClone(value);
}

function normalizeRevenantDispatchPolicy(value, operationContext, workflowId) {
    if (value === undefined || value === null) return null;
    if (
        !value || typeof value !== 'object' || Array.isArray(value)
        || operationContext?.kind !== 'hypav3-summary'
    ) return undefined;
    const maxConcurrent = Number(value.maxConcurrent);
    const requestsPerMinute = Number(value.requestsPerMinute);
    if (
        !Number.isInteger(maxConcurrent)
        || !Number.isInteger(requestsPerMinute)
        || maxConcurrent < 1 || maxConcurrent > 32
        || requestsPerMinute < 1 || requestsPerMinute > 1000
        || maxConcurrent > requestsPerMinute
    ) return undefined;
    return {
        dispatchGroup: `${workflowId || 'standalone'}:hypa:${operationContext.batchId}`,
        maxConcurrent,
        requestsPerMinute,
    };
}

function normalizeRevenantWorkflowDependency(value, jobType, workflowId) {
    if (value === undefined || value === null) return null;
    if (
        !value || typeof value !== 'object' || Array.isArray(value)
        || jobType !== 'model'
        || !workflowId
        || value.kind !== 'hypav3-selection'
        || typeof value.placeholder !== 'string'
        || value.placeholder.length > 256
        || !/^__RISU_REVENANT_HYPA_[A-Za-z0-9_-]+__$/.test(value.placeholder)
    ) return undefined;
    return {
        kind: 'hypav3-selection',
        placeholder: value.placeholder,
    };
}

function resolveRevenantWorkflowRequestBody(bodyBase64, dependency, execution) {
    if (
        dependency?.kind !== 'hypav3-selection'
        || execution?.kind !== 'hypav3-selection'
        || execution?.status !== 'completed'
        || !Array.isArray(execution.result?.chatSequence)
    ) throw new Error('HypaV3 workflow selection is not complete');
    const memoryPrompt = execution.result.chatSequence
        .map(item => item?.chat)
        .find(chat => chat?.memo === 'supaMemory')?.content;
    if (typeof memoryPrompt !== 'string') {
        throw new Error('HypaV3 workflow selection has no memory prompt');
    }
    let requestBody;
    try {
        requestBody = JSON.parse(Buffer.from(bodyBase64, 'base64').toString('utf8'));
    } catch {
        throw new Error('Dependent generation request body is not valid JSON');
    }
    let replacements = 0;
    const replacePlaceholder = value => {
        if (typeof value === 'string') {
            if (!value.includes(dependency.placeholder)) return value;
            replacements += value.split(dependency.placeholder).length - 1;
            return value.replaceAll(dependency.placeholder, memoryPrompt);
        }
        if (Array.isArray(value)) return value.map(replacePlaceholder);
        if (value && typeof value === 'object') {
            return Object.fromEntries(Object.entries(value).map(([key, item]) => [
                key,
                replacePlaceholder(item),
            ]));
        }
        return value;
    };
    const resolved = replacePlaceholder(requestBody);
    if (replacements === 0) {
        throw new Error('Dependent generation request has no HypaV3 placeholder');
    }
    return Buffer.from(JSON.stringify(resolved), 'utf8').toString('base64');
}

function normalizeRevenantHypaExecutionRecipe(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    let serialized;
    try { serialized = JSON.stringify(value); }
    catch { return undefined; }
    if (Buffer.byteLength(serialized) > 4 * 1024 * 1024) return undefined;
    const embedding = value.embedding;
    const tokenizer = value.tokenizer;
    const settings = value.settings;
    const summaries = value.memory?.summaries;
    if (
        value.schemaVersion !== 1
        || typeof value.batchId !== 'string'
        || !WORKFLOW_KEY_PATTERN.test(value.batchId)
        || !Array.isArray(value.expectedOperationIds)
        || value.expectedOperationIds.length > 1000
        || !value.expectedOperationIds.every(id => typeof id === 'string' && WORKFLOW_KEY_PATTERN.test(id))
        || !embedding || !REMOTE_HYPA_MODELS.has(embedding.model)
        || typeof embedding.apiKey !== 'string'
        || !tokenizer || !SERVER_TOKENIZERS.has(tokenizer.tokenizer)
        || !Number.isInteger(tokenizer.chatAdditionalTokens)
        || tokenizer.chatAdditionalTokens < 0 || tokenizer.chatAdditionalTokens > 1000
        || !settings
        || ![settings.recentMemoryRatio, settings.similarMemoryRatio]
            .every(number => Number.isFinite(number) && number >= 0 && number <= 1)
        || settings.recentMemoryRatio + settings.similarMemoryRatio > 1
        || !Number.isInteger(settings.queryChatCount)
        || settings.queryChatCount < 1 || settings.queryChatCount > 100
        || typeof settings.summaryChunkSeparator !== 'string'
        || settings.summaryChunkSeparator.length > 1000
        || !Array.isArray(value.chats) || value.chats.length > 10000
        || !value.chats.every(chat => chat && typeof chat === 'object'
            && typeof chat.role === 'string' && typeof chat.content === 'string')
        || !Array.isArray(summaries) || summaries.length > 10000
        || !summaries.every(summary => summary && typeof summary.text === 'string'
            && Array.isArray(summary.chatMemos)
            && summary.chatMemos.every(memo => typeof memo === 'string')
            && typeof summary.isImportant === 'boolean')
        || ![value.currentTokens, value.maxContextTokens, value.availableMemoryTokens, value.memoryTokens]
            .every(Number.isFinite)
        || !Number.isInteger(value.startIdx)
        || value.startIdx < 0 || value.startIdx > value.chats.length
        || typeof value.shouldReserveMemoryTokens !== 'boolean'
        || typeof value.randomSeed !== 'string'
    ) return undefined;
    if (embedding.model === 'custom' && typeof embedding.customUrl !== 'string') return undefined;
    return JSON.parse(serialized);
}

module.exports = {
    isRevenantJobActive,
    isValidRevenantWorkflowKey,
    hasRevenantWorkflowOwnerLease,
    normalizeRevenantWorkflowPlan,
    normalizeRevenantWorkflowStepUpdate,
    normalizeRevenantWorkflowTerminalStatus,
    normalizeRevenantJobType,
    normalizeRevenantOperationContext,
    normalizeRevenantDispatchPolicy,
    normalizeRevenantWorkflowDependency,
    resolveRevenantWorkflowRequestBody,
    normalizeRevenantHypaExecutionRecipe,
};
