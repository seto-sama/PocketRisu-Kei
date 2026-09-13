'use strict';

const path = require('path');
const { createServerServiceAccountTokenCache } = require('../googleServiceAccount.cjs');
const { randomUUID } = require('crypto');
const { setTimeout: delay } = require('timers/promises');
require('sucrase/register/ts');
const source = file => require(path.join(__dirname, '../../../src/ts', file));
const { compileModelPreset } = source('preset/runtime/compilePreset.ts');
const { resolveModelPresetCredential } = source('preset/runtime/credential.ts');
const { modelsDevUsageIdentity } = source('preset/runtime/usageIdentity.ts');
const { convertInterfaceToSchemaCore } = source('process/templates/jsonSchemaCore.ts');
const { formatPresetMessages } = source('process/request/formatMessages.ts');
const { toAdapterMessage } = source('process/request/modelPresetMessages.ts');
const { parseChatMLCore } = source('parser/chatMLCore.ts');
const { normalizeLuaLlmPrompt, extractLuaLlmInlays } = source('process/luaLlmCore.ts');
const { renderRevenantTemplate } = source('process/revenant/postprocess/headlessParser.ts');
const { GENERATION_REQUEST_DEFAULT_TIMEOUT_MS } = require('./generationConfig.cjs');

const PROVIDER_ACTIONS = new Set([
    'provider.llm', 'provider.axllm', 'provider.simplellm', 'provider.igp',
]);

function canExecuteServerProviderAction(action) {
    if (!PROVIDER_ACTIONS.has(action?.kind)) return false;
    const preset = action.payload?.modelPreset;
    // Plugins and batch transport still use the browser dispatch path.
    if (!preset || preset.claudeBatching) return false;
    try {
        const compiled = compileModelPreset(preset);
        return compiled.backend !== 'plugin';
    }
    catch { return false; }
}

/** Uses the same adapters and durable dispatch queue as browser-originated work. */
function createServerProviderActionExecutor(options) {
    const {
        repository,
        scheduleGenerationDispatch,
        sanitizeGenerationTargetUrl,
        getDatabase,
        readInlay,
        writeMedia,
    } = options;

    const tokenCache = options.tokenCache ?? createServerServiceAccountTokenCache();

    return async function executeProviderAction({ workflow, action, chat, operationContext, dispatchPolicy }) {
        const controller = new AbortController();
        const signal = controller.signal;
        const checkActive = () => {
            if (repository.getGenerationWorkflow(workflow.workflowId)?.status !== 'active') {
                controller.abort(new Error('Generation workflow is no longer active'));
            }
        };
        checkActive();
        const cancellationTimer = setInterval(checkActive, 100);
        // A rate-limited Hypa batch can spend longer than a request timeout in
        // the queue. Its provider timeout starts when the dispatcher runs it.
        const timeoutTimer = operationContext?.kind === 'hypav3-summary' ? null
            : setTimeout(() => controller.abort(new Error('Provider action timed out')),
                GENERATION_REQUEST_DEFAULT_TIMEOUT_MS);
        const jobIds = [];
        try {
            signal.throwIfAborted();
            const payload = action.payload;
            const database = getDatabase();
            const compiled = compileModelPreset(payload.modelPreset, {
                jsonSchemaRequested: database.jsonSchemaEnabled === true,
            });
            const preset = compiled.preset;
            const recipe = workflow.context.postprocess;
            const currentChat = chat || recipe.chat;
            const rawPrompt = payload.prompt;
            let prompt = action.kind === 'provider.simplellm'
                ? [{ role: 'user', content: String(rawPrompt ?? '') }]
                : Array.isArray(rawPrompt) ? normalizeLuaLlmPrompt(rawPrompt)
                    : parseChatMLCore(String(rawPrompt ?? ''), text =>
                        renderRevenantTemplate(text, recipe, currentChat).text)
                        || [{ role: 'user', content: String(rawPrompt ?? '') }];
            if (payload.useMultimodal === true) {
                for (const message of prompt) {
                    const extracted = extractLuaLlmInlays(message);
                    message.content = extracted.content;
                    message.multimodals = await Promise.all(extracted.inlayIds.map(readInlay));
                }
            }
            prompt = formatPresetMessages(prompt, compiled.behavior, database);
            const messages = prompt.map((message, index) => toAdapterMessage(
                message, compiled.features.vision,
                compiled.behavior.deepSeekThinkingInput && index === prompt.length - 1,
                compiled.features.audioInput, compiled.features.videoInput,
            ));
            if (compiled.behavior.developerRole) {
                for (const message of messages) {
                    if (message.role === 'system') message.role = 'developer';
                }
            }
            const streaming = compiled.backend === 'http' && payload.options?.streaming === true
                && compiled.adapter.support.streaming && !compiled.features.mediaOutput;
            const fetchImpl = async (url, init = {}) => {
                checkActive();
                signal.throwIfAborted();
                const targetUrl = sanitizeGenerationTargetUrl(String(url));
                if (!targetUrl) throw new Error('Invalid provider target URL');
                const jobId = randomUUID();
                repository.createGenerationJob({
                    jobId, chatId: jobId,
                    jobType: operationContext?.kind === 'hypav3-summary' ? 'memory'
                        : payload.mode === 'submodel' ? 'submodel'
                        : action.kind === 'provider.igp' ? 'emotion' : 'otherAx',
                    characterId: workflow.characterId, roomId: workflow.roomId,
                    workflowId: workflow.workflowId,
                    workflowStepKey: `client-action:${action.actionId}`.slice(0, 128),
                    stepExecutionId: randomUUID(),
                    adapterKind: compiled.adapterKind, streaming,
                    generationInfo: { model: preset.name },
                    operationContext,
                    dispatchGroup: operationContext?.kind === 'hypav3-summary'
                        ? `${workflow.workflowId}:hypa:${operationContext.batchId}`
                        : `${workflow.workflowId}:postprocess`,
                    dispatchMaxConcurrent: dispatchPolicy?.maxConcurrent ?? 1,
                    dispatchRequestsPerMinute: dispatchPolicy?.requestsPerMinute ?? 1000,
                    requestSpec: {
                        targetUrl, method: init.method || 'POST',
                        headers: Object.fromEntries(new Headers(init.headers).entries()),
                        body: Buffer.from(String(init.body || '')),
                        timeoutMs: GENERATION_REQUEST_DEFAULT_TIMEOUT_MS,
                        requestLog: { chatId: jobId, platform: 'Server' },
                        ...modelsDevUsageIdentity(preset),
                    },
                });
                jobIds.push(jobId);
                scheduleGenerationDispatch();
                let job;
                do {
                    await delay(50, undefined, { signal });
                    job = repository.getGenerationJob(jobId, false);
                    if (!job) throw new Error('Provider job disappeared');
                } while (job.status === 'queued' || job.status === 'generating');
                signal.throwIfAborted();
                if (job.status !== 'generated' && !(job.responseStatus >= 400)) {
                    throw new Error(job.error || `Provider job ${job.status}`);
                }
                const raw = repository.getGenerationJob(jobId, true).rawResponse;
                return new Response(raw, { status: job.responseStatus || 200, headers: job.responseHeaders });
            };
            if (compiled.backend === 'echo') {
                const response = await fetchImpl('https://echo.invalid/v1/chat/completions', {
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({
                        message: preset.userValues?.echoMessage ?? 'Echo Message',
                        delayMs: Math.max(0, Number(preset.userValues?.echoDelay) || 0) * 1000,
                        model: preset.name,
                    }),
                });
                const result = await response.json();
                return { success: true, result: String(result.choices?.[0]?.message?.content ?? '') };
            }
            const credential = resolveModelPresetCredential(preset, database.apiKeyPool);
            const adapterOptions = {
                messages, fetchImpl, abortSignal: signal, tokenCache,
                ...(compiled.features.jsonSchema ? {
                    structuredOutput: {
                        schema: convertInterfaceToSchemaCore(database.jsonSchema, text =>
                            renderRevenantTemplate(text, recipe, currentChat).text),
                        strict: database.strictJsonSchema,
                    },
                } : {}),
            };
            let text = '';
            let thinking = '';
            let media = [];
            if (streaming) {
                for await (const delta of compiled.adapter.stream(preset, adapterOptions, credential)) {
                    text += delta.textDelta || '';
                    thinking += delta.reasoningDelta || '';
                }
            } else {
                const response = await compiled.adapter.send(preset, adapterOptions, credential);
                text = response.text;
                for (const part of response.reasoning || []) {
                    thinking += part.redactedData !== undefined ? '\n{{redacted_thinking}}\n' : part.text || '';
                }
                media = response.media || [];
            }
            signal.throwIfAborted();
            const markers = await Promise.all(media.map(item => writeMedia(item)));
            return {
                success: true,
                result: (thinking.trim() ? `<Thoughts>\n${thinking}\n</Thoughts>\n\n` : '')
                    + text + (text && markers.length ? '\n' : '') + markers.join('\n'),
            };
        } catch (error) {
            return { success: false, result: `Error: ${error instanceof Error ? error.message : String(error)}` };
        } finally {
            clearInterval(cancellationTimer);
            clearTimeout(timeoutTimer);
            for (const jobId of jobIds) {
                // Cancel any queued/running job if preparation/parsing timed out.
                const job = repository.getGenerationJob(jobId, false);
                if (job && ['queued', 'generating'].includes(job.status)) await options.cancelJob(jobId);
                repository.markGenerationMaterialized(jobId);
            }
        }
    };
}

module.exports = { canExecuteServerProviderAction, createServerProviderActionExecutor };
