'use strict';

const HYPA_CONCURRENT_REQUEST_MIN = 1;
const HYPA_CONCURRENT_REQUEST_MAX = 12;

const { applyPatch } = require('fast-json-patch');
const { REMOTE_HYPA_MODELS, SERVER_HYPA_TOKENIZERS } = require('./hypaExecutor.cjs');

const JOB_TYPES = new Set([
    'model', 'submodel', 'memory', 'otherAx', 'translate',
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
const WORKFLOW_TERMINAL_STATUSES = new Set(['completed', 'cancelled', 'failed']);
const WORKFLOW_KEY_PATTERN = /^[a-z0-9][a-z0-9._:/-]{0,127}$/;

function isObjectRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function resolveRevenantPostprocessChat(context, inputChat) {
    const recipe = context?.postprocess;
    const base = inputChat;
    if (
        !recipe
        || typeof recipe !== 'object'
        || !base?.id
        || !Array.isArray(base.message)
        || !Array.isArray(recipe.chatPatch)
    ) return undefined;
    try {
        return applyPatch(structuredClone(base), recipe.chatPatch, true, true, true).newDocument;
    } catch {
        return undefined;
    }
}

function resolveRevenantPostprocessRecipe(context, inputChat) {
    const chat = resolveRevenantPostprocessChat(context, inputChat);
    if (!chat) return undefined;
    const { chatPatch: _chatPatch, ...snapshot } = context.postprocess;
    return {
        ...snapshot,
        character: {
            ...snapshot.character,
            chats: [chat],
        },
        chat,
    };
}

function normalizeRevenantJobType(value) {
    return JOB_TYPES.has(value) ? value : 'model';
}

function isRevenantJobActive(status) {
    return status === 'queued' || status === 'generating';
}

function normalizeRevenantWorkflowPlan(value) {
    if (
        !Array.isArray(value) || value.length === 0
        || !value.every(step => isValidRevenantWorkflowKey(step?.key))
    ) return undefined;
    return value.map((step, order) => ({
        key: step.key,
        kind: step.kind,
        recoveryPolicy: step.recoveryPolicy,
        status: step.status ?? 'pending',
        ...(step.metadata ? { metadata: step.metadata } : {}),
        order,
    }));
}

function normalizeRevenantWorkflowContext(value, characterId, roomId) {
    if (!isObjectRecord(value)) return undefined;
    if (value.kind === 'image-generation') {
        return value.target?.characterId === characterId
            && roomId === `image-generation:${value.target.roomId}`
            ? value
            : undefined;
    }
    if (
        value.kind !== 'chat-generation'
        || value.postprocess?.character?.chaId !== characterId
        || value.inputCommit?.chat?.id !== roomId
        || resolveRevenantPostprocessChat(value, value.inputCommit.chat)?.id !== roomId
    ) return undefined;
    return value;
}

function normalizeRevenantWorkflowStepUpdate(value) {
    if (!WORKFLOW_STEP_STATUSES.has(value?.status)) return undefined;
    return { status: value.status, metadata: value.metadata ?? null };
}

function normalizeRevenantWorkflowTerminalStatus(value) {
    return WORKFLOW_TERMINAL_STATUSES.has(value) ? value : undefined;
}

function isValidRevenantWorkflowKey(value) {
    return typeof value === 'string' && WORKFLOW_KEY_PATTERN.test(value);
}

function isRevenantWorkflowClientActionJobAllowed(input) {
    const action = input.action;
    if (
        !action
        || action.actionId !== input.actionId
        || typeof action.kind !== 'string'
    ) return false;
    if (action.kind === 'provider.main') {
        return input.parentStepKey === 'model.dispatch'
            && input.actionId === 'model.dispatch.plugin'
            && input.jobType === 'model'
            && input.workflowStepKey === 'model.main';
    }
    return input.jobType !== 'model'
        && input.workflowStepKey === `client-action:${input.actionId}`.slice(0, 128);
}

function normalizeRevenantOperationContext(jobType, value) {
    if (value == null) return null;
    if (OPERATION_JOB_TYPES[value.kind] !== jobType) return undefined;
    if (value.kind === 'hypav3-summary' && !isValidRevenantWorkflowKey(value.batchId)) return undefined;
    return value;
}

function normalizeRevenantDispatchPolicy(value, operationContext, workflowId) {
    if (value === undefined || value === null) return null;
    if (
        !value || typeof value !== 'object' || Array.isArray(value)
        || operationContext?.kind !== 'hypav3-summary'
    ) return undefined;
    const maxConcurrent = Number(value.maxConcurrent);
    if (
        !Number.isInteger(maxConcurrent)
        || maxConcurrent < HYPA_CONCURRENT_REQUEST_MIN
        || maxConcurrent > HYPA_CONCURRENT_REQUEST_MAX
    ) return undefined;
    return {
        dispatchGroup: `${workflowId || 'standalone'}:hypa:${operationContext.batchId}`,
        maxConcurrent,
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

function resolveRevenantWorkflowRequestBody(body, dependency, execution) {
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
        requestBody = JSON.parse(Buffer.from(body).toString('utf8'));
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
    return Buffer.from(JSON.stringify(resolved), 'utf8');
}

function normalizeRevenantHypaExecutionRecipe(value) {
    const operationIds = value?.expectedOperationIds;
    const requests = value?.summaryRequests;
    if (
        value?.schemaVersion !== 1
        || !isValidRevenantWorkflowKey(value.batchId)
        || !Array.isArray(operationIds)
        || !operationIds.every(isValidRevenantWorkflowKey)
        || !REMOTE_HYPA_MODELS.has(value.embedding?.model)
        || !SERVER_HYPA_TOKENIZERS.has(value.tokenizer?.tokenizer)
        || !Array.isArray(requests)
        || requests.length !== operationIds.length
        || !requests.every(request => operationIds.includes(request?.operationId))
        || !value.summaryProvider?.profileSnapshot
        || !normalizeRevenantDispatchPolicy(value.summaryDispatch, { kind: 'hypav3-summary' })
    ) return undefined;
    return value;
}

module.exports = {
    isRevenantJobActive,
    isValidRevenantWorkflowKey,
    isRevenantWorkflowClientActionJobAllowed,
    normalizeRevenantWorkflowPlan,
    normalizeRevenantWorkflowContext,
    resolveRevenantPostprocessRecipe,
    normalizeRevenantWorkflowStepUpdate,
    normalizeRevenantWorkflowTerminalStatus,
    normalizeRevenantJobType,
    normalizeRevenantOperationContext,
    normalizeRevenantDispatchPolicy,
    normalizeRevenantWorkflowDependency,
    resolveRevenantWorkflowRequestBody,
    normalizeRevenantHypaExecutionRecipe,
};
