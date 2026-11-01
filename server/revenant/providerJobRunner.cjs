'use strict';

const nodeCrypto = require('crypto');
const { logger } = require('../logs/logs.cjs');
const { addRequestLog, updateRequestLogResponseById } = require('../logs/requestLogs.cjs');
const { recordGenerationUsage } = require('../logs/usageDb.cjs');
const {
    executeEchoProviderRequest,
    executeUpstreamRequest,
    filterUpstreamRequestHeaders,
} = require('../upstreamRequest.cjs');
const { createServerProviderAuthResolver } = require('../googleServiceAccount.cjs');
const {
    GENERATION_REQUEST_DEFAULT_TIMEOUT_MS,
    normalizeGenerationRequestTimeoutMs,
} = require('./generationConfig.cjs');
const { generationJournalStore } = require('./generationJournal.cjs');
const {
    NORMALIZED_PROJECTION_SCHEMA_VERSION,
    openGenerationEventJournal,
    projectGenerationJournal,
} = require('./generationProjection.cjs');
const { notifyRevenantJournalWaiters, streamRevenantJournal } = require('./generationStream.cjs');
const { waitForDrain } = require('./writableDrain.cjs');

const GENERATION_JOB_DEFAULT_HEARTBEAT_SEC = 15;
const GENERATION_JOB_HEARTBEAT_MIN_SEC = 5;
const GENERATION_JOB_HEARTBEAT_MAX_SEC = 60;
const GENERATION_JOB_GC_INTERVAL_MS = 60000;
const GENERATION_JOB_DONE_GRACE_MS = 30000;

function sanitizeGenerationTargetUrl(raw) {
    if (typeof raw !== 'string' || raw.trim() === '') return null;
    try {
        const parsed = new URL(raw);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
        if (parsed.username || parsed.password) return null;
        return parsed.toString();
    } catch {
        return null;
    }
}

function normalizeForwardHeaders(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
    return filterUpstreamRequestHeaders(Object.fromEntries(
        Object.entries(input).filter(([, value]) => typeof value === 'string'),
    ));
}

function normalizeHeartbeatSec(heartbeatSec) {
    if (!Number.isFinite(heartbeatSec)) {
        return GENERATION_JOB_DEFAULT_HEARTBEAT_SEC;
    }
    const parsed = Math.floor(heartbeatSec);
    return Math.min(GENERATION_JOB_HEARTBEAT_MAX_SEC, Math.max(GENERATION_JOB_HEARTBEAT_MIN_SEC, parsed));
}

function hasGenerationStreamTerminalMarker(rawBuffer) {
    const text = Buffer.from(rawBuffer || '').toString('utf-8');
    for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') return true;
        if (!data) continue;
        try {
            const payload = JSON.parse(data);
            if (
                payload?.type === 'message_stop'
                || payload?.type === 'response.completed'
                || payload?.type === 'response.done'
            ) {
                return true;
            }
            if (payload?.candidates?.some(candidate =>
                typeof candidate?.finishReason === 'string'
                && candidate.finishReason !== ''
                && candidate.finishReason !== 'FINISH_REASON_UNSPECIFIED'
            )) {
                return true;
            }
        } catch {
            // Partial/non-JSON SSE event.
        }
    }
    return false;
}

// In-memory state for provider requests: the durable job lives in the
// generation DB, while this map tracks abort controllers and journal sockets.
function createProviderJobRunner(options) {
    const repository = options.repository || require('./generationDb.cjs');
    const {
        finishGenerationJob,
        getGenerationJob,
        listGenerationJobsNeedingProjection,
        readGenerationJobRaw,
        replaceGenerationJobEvents,
        setGenerationJobGenerating,
        setGenerationJobHeaders,
        setGenerationJobProjection,
        setGenerationJobProjectionError,
    } = repository;
    const {
        outboundPolicy,
        scheduleHypaWorkflowExecution,
        scheduleRevenantPostprocess,
    } = options;
    const resolveProviderAuth = createServerProviderAuthResolver();
    const generationRuntimeJobs = new Map();

    function countActiveJobs() {
        let count = 0;
        for (const job of generationRuntimeJobs.values()) {
            if (!job.done && !job.waitingDispatch) count += 1;
        }
        return count;
    }

    function createGenerationRuntimeJob(arg) {
        const jobId = arg.jobId || nodeCrypto.randomUUID();
        const timeoutMs = normalizeGenerationRequestTimeoutMs(Number(arg.timeoutMs));
        const heartbeatSec = normalizeHeartbeatSec(arg.heartbeatSec);
        const controller = new AbortController();
        const createdAt = Date.now();
        const job = {
            id: jobId,
            workflowId: arg.workflowId || null,
            createdAt,
            updatedAt: createdAt,
            done: false,
            cleanupAt: 0,
            clients: new Set(),
            rawBytes: 0,
            journalWaiters: [],
            providerStartedAt: null,
            responseStatus: null,
            responseHeaders: {},
            terminalEvent: null,
            abortController: controller,
            cancelUpstream: null,
            deadlineAt: createdAt + timeoutMs,
            heartbeatSec,
            timeoutMs
        };
        generationRuntimeJobs.set(jobId, job);
        return job;
    }

    function loadPersistedGenerationRuntimeJob(jobId) {
        const persisted = getGenerationJob(jobId, false);
        if (!persisted) return null;
        const createdAt = persisted.createdAt || Date.now();
        const active = ['queued', 'generating'].includes(persisted.status);
        const job = {
            id: jobId,
            workflowId: persisted.workflowId || null,
            createdAt,
            updatedAt: persisted.updatedAt || createdAt,
            done: !active,
            waitingDispatch: persisted.status === 'queued',
            cleanupAt: active ? 0 : Date.now() + GENERATION_JOB_DONE_GRACE_MS,
            clients: new Set(),
            rawBytes: persisted.rawBytes || 0,
            journalWaiters: [],
            providerStartedAt: persisted.dispatchedAt || null,
            responseStatus: persisted.responseStatus || null,
            responseHeaders: persisted.responseHeaders || {},
            terminalEvent: active ? null : persisted.status === 'failed'
                ? {
                    type: 'error',
                    status: 502,
                    message: persisted.error || 'Generation job failed',
                }
                : {
                    type: 'done',
                    status: persisted.status,
                    partial: ['cancelled', 'interrupted', 'failed_partial'].includes(persisted.status),
                    finishReason: persisted.finishReason,
                },
            abortController: new AbortController(),
            cancelUpstream: null,
            deadlineAt: Date.now(),
            heartbeatSec: GENERATION_JOB_DEFAULT_HEARTBEAT_SEC,
            timeoutMs: GENERATION_REQUEST_DEFAULT_TIMEOUT_MS,
        };
        generationRuntimeJobs.set(jobId, job);
        return job;
    }

    function notifyGenerationJob(job) {
        job.updatedAt = Date.now();
        notifyRevenantJournalWaiters(job);
    }

    function markGenerationJobDone(job) {
        if (job.done) return;
        job.done = true;
        job.cleanupAt = Date.now() + GENERATION_JOB_DONE_GRACE_MS;
        notifyRevenantJournalWaiters(job);
    }

    function cleanupGenerationRuntimeJob(jobId) {
        const job = generationRuntimeJobs.get(jobId);
        if (!job) return;
        for (const client of job.clients) {
            try { client.close(); } catch { /* ignore */ }
        }
        generationRuntimeJobs.delete(jobId);
    }

    function findJob(jobId) {
        return generationRuntimeJobs.get(jobId) || loadPersistedGenerationRuntimeJob(jobId);
    }

    async function runGenerationProviderJob(job, arg) {
        const targetUrl = sanitizeGenerationTargetUrl(arg.targetUrl);
        if (!targetUrl) {
            finishGenerationJob(job.id, 'failed', 'invalid_target', 'Invalid target URL');
            markGenerationJobDone(job);
            return;
        }

        const headers = normalizeForwardHeaders(arg.headers);
        const bodyBuffer = arg.body?.length
            ? Buffer.from(arg.body.buffer, arg.body.byteOffset, arg.body.byteLength)
            : undefined;
        let completionProbe = Buffer.alloc(0);
        let providerCompleted = false;
        let eventJournal = null;
        const journalWriter = generationJournalStore.openWriter(job.workflowId, job.id);
        let journalWriteError = null;
        let journalClosed = false;
        journalWriter?.on('error', (error) => {
            journalWriteError ||= error;
            notifyRevenantJournalWaiters(job);
        });
        const closeJournal = async () => {
            if (journalClosed) return;
            journalClosed = true;
            if (!journalWriter.destroyed) {
                await new Promise((resolve) => {
                    const done = () => {
                        journalWriter.off('close', done);
                        resolve();
                    };
                    journalWriter.once('close', done);
                    journalWriter.end();
                });
            }
            notifyRevenantJournalWaiters(job);
            if (journalWriteError) throw journalWriteError;
        };
        const recordUsage = (persisted, rawResponse, outputText) => recordGenerationUsage({
            jobId: job.id,
            timestamp: persisted?.createdAt,
            chatId: persisted?.chatId,
            targetUrl,
            body: arg.body,
            rawResponse,
            outputText,
            usageProviderId: arg.usageProviderId,
            usageModelId: arg.usageModelId,
            usageServiceTier: arg.usageServiceTier,
        });

        try {
            await resolveProviderAuth(arg.serverProviderAuth, headers, job.abortController.signal);
            job.providerStartedAt ||= Date.now();
            notifyRevenantJournalWaiters(job);
            setGenerationJobGenerating(job.id);
            addRequestLog({
                id: job.id,
                timestamp: job.providerStartedAt,
                date: new Date(job.providerStartedAt).toLocaleTimeString(),
                url: targetUrl,
                body: bodyBuffer?.toString('utf-8') || '',
                header: JSON.stringify(headers, null, 2),
                response: 'Streamed Fetch',
                responseType: 'stream',
                success: true,
                chatId: arg.requestLog?.chatId,
                clientId: arg.requestLog?.clientId,
                platform: arg.requestLog?.platform,
            });
            const providerRequest = {
                url: targetUrl,
                method: arg.method,
                headers,
                body: bodyBuffer && arg.method !== 'GET' && arg.method !== 'HEAD' ? bodyBuffer : undefined,
                signal: job.abortController.signal,
                outboundPolicy,
            };
            const upstreamResponse = arg.adapterKind === 'echo'
                ? await executeEchoProviderRequest(providerRequest)
                : await executeUpstreamRequest(providerRequest);
            const filteredHeaders = upstreamResponse.headers;

            setGenerationJobHeaders(job.id, upstreamResponse.status, filteredHeaders);
            job.responseStatus = upstreamResponse.status;
            job.responseHeaders = filteredHeaders;
            const decodable = getGenerationJob(job.id, false);
            if (decodable?.responseDecoder && upstreamResponse.status >= 200 && upstreamResponse.status < 300) {
                eventJournal = openGenerationEventJournal(decodable, {
                    journalStore: generationJournalStore,
                    onWritten: () => notifyRevenantJournalWaiters(job),
                });
            }
            notifyGenerationJob(job);

            if (upstreamResponse.body) {
                const iterator = upstreamResponse.body[Symbol.asyncIterator]();
                let upstreamDone = false;
                let cancelPromise = null;
                const cancelUpstream = (reason) => {
                    if (upstreamDone || typeof iterator.return !== 'function') return Promise.resolve();
                    cancelPromise ||= Promise.resolve(iterator.return(reason)).then(() => {});
                    return cancelPromise;
                };
                job.cancelUpstream = cancelUpstream;
                try {
                    while (!job.abortController.signal.aborted) {
                        const next = await iterator.next();
                        if (next.done) {
                            upstreamDone = true;
                            break;
                        }
                        const value = next.value;
                        if (value && value.length > 0) {
                            const bytes = Buffer.from(value);
                            completionProbe = Buffer.concat([completionProbe, bytes]);
                            if (completionProbe.length > 256 * 1024) {
                                completionProbe = completionProbe.subarray(completionProbe.length - 256 * 1024);
                            }
                            if (journalWriteError) throw journalWriteError;
                            job.rawBytes += bytes.length;
                            eventJournal?.push(bytes);
                            const writable = journalWriter.write(bytes, () => {
                                notifyRevenantJournalWaiters(job);
                            });
                            if (!writable) await waitForDrain(journalWriter);
                            await eventJournal?.ready();
                            notifyGenerationJob(job);
                            if (hasGenerationStreamTerminalMarker(completionProbe)) {
                                providerCompleted = true;
                                break;
                            }
                        }
                    }
                } finally {
                    if (!upstreamDone) {
                        await cancelUpstream(job.abortController.signal.reason);
                    }
                    if (job.cancelUpstream === cancelUpstream) job.cancelUpstream = null;
                }
            }
            await closeJournal();
            const providerCompletedAt = Date.now();
            const cancelled = job.abortController.signal.aborted;
            const persisted = getGenerationJob(job.id, false);
            const cancelFinishReason = persisted?.finishReason || 'user_cancelled';
            const rawResponse = readGenerationJobRaw(job.id);
            let projection = persisted?.projection;
            let terminalFailure;
            if (!cancelled && (upstreamResponse.status < 200 || upstreamResponse.status >= 300)) {
                terminalFailure = {
                    finishReason: 'upstream_http_error',
                    message: `Provider request failed with HTTP ${upstreamResponse.status}`,
                };
            } else if (eventJournal) {
                try {
                    projection = await eventJournal.finish(cancelled);
                    setGenerationJobProjection(job.id, projection);
                } catch (error) {
                    const message = `Failed to normalize provider journal: ${error}`;
                    setGenerationJobProjectionError(job.id, message);
                    if (!cancelled) {
                        terminalFailure = { finishReason: 'projection_error', message };
                    } else {
                        logger.warn(`[GenerationJob] Cancelled projection unavailable for ${job.id}:`, error);
                    }
                }
            }
            updateRequestLogResponseById(
                job.id,
                rawResponse.toString('utf-8'),
                upstreamResponse.status,
                upstreamResponse.status >= 200 && upstreamResponse.status < 400,
                providerCompletedAt,
            );
            recordUsage(persisted, rawResponse, projection?.content);
            const finishReason = cancelled
                ? cancelFinishReason
                : (providerCompleted ? 'provider_complete' : 'upstream_complete');
            if (terminalFailure) {
                finishGenerationJob(
                    job.id,
                    'failed',
                    terminalFailure.finishReason,
                    terminalFailure.message,
                    rawResponse.length,
                );
            } else {
                finishGenerationJob(
                    job.id,
                    cancelled ? 'cancelled' : 'generated',
                    finishReason,
                    null,
                    rawResponse.length,
                );
            }
            // A non-2xx upstream response is still a complete HTTP response, and a
            // decoding failure is the last decoded event. Close the journal
            // normally so the client adapter can read the provider's error body or
            // the decoder's error and surface the precise message instead of a
            // transport level fallback. The job remains failed in durable storage.
            if (['upstream_http_error', 'projection_error'].includes(terminalFailure?.finishReason)) {
                job.terminalEvent = {
                    type: 'done',
                    status: 'failed',
                    partial: false,
                    finishReason: terminalFailure.finishReason,
                };
            } else if (terminalFailure) {
                job.terminalEvent = {
                    type: 'error',
                    status: 502,
                    message: terminalFailure.message,
                };
            } else {
                job.terminalEvent = {
                    type: 'done',
                    status: cancelled ? 'cancelled' : 'generated',
                    partial: cancelled,
                    finishReason,
                };
            }
            markGenerationJobDone(job);
            scheduleHypaWorkflowExecution();
            scheduleRevenantPostprocess();
        } catch (error) {
            job.cancelUpstream = null;
            try { await closeJournal(); } catch (persistError) {
                logger.error('[GenerationJob] Failed to close partial response journal:', persistError);
            }
            const cancelled = job.abortController.signal.aborted;
            const message = cancelled ? 'Generation job aborted' : `${error}`;
            if (eventJournal) {
                try {
                    setGenerationJobProjection(job.id, await eventJournal.finish(true));
                } catch (projectionError) {
                    logger.warn(`[GenerationJob] Partial projection unavailable for ${job.id}:`, projectionError);
                }
            }
            const persistedWithRaw = getGenerationJob(job.id, false);
            const rawResponse = readGenerationJobRaw(job.id);
            updateRequestLogResponseById(
                job.id,
                rawResponse.length > 0 ? rawResponse.toString('utf-8') : message,
                persistedWithRaw?.responseStatus,
                false,
            );
            recordUsage(persistedWithRaw, rawResponse, persistedWithRaw?.projection?.content);
            const hasPartial = rawResponse.length > 0;
            const cancelFinishReason = persistedWithRaw?.finishReason || 'user_cancelled';
            finishGenerationJob(
                job.id,
                cancelled ? 'cancelled' : (hasPartial ? 'failed_partial' : 'failed'),
                cancelled ? cancelFinishReason : 'upstream_error',
                message,
                rawResponse.length,
            );
            job.rawBytes = rawResponse.length;
            job.terminalEvent = cancelled
                ? {
                    type: 'done',
                    status: 'cancelled',
                    partial: true,
                    finishReason: cancelFinishReason,
                }
                : { type: 'error', status: 504, message };
            markGenerationJobDone(job);
            scheduleHypaWorkflowExecution();
        }
    }

    function handleJournalConnection(ws, req, jobId) {
        const job = findJob(jobId);
        if (!job) {
            ws.close();
            return;
        }

        const reqUrl = new URL(req.url, `http://${req.headers.host}`);
        ws.journalRecoverySubscriber = reqUrl.searchParams.get('recovery') === '1';
        job.clients.add(ws);
        ws.send(JSON.stringify({ type: 'job_accepted', jobId }));
        void streamRevenantJournal(
            ws,
            job,
            Number(reqUrl.searchParams.get('offset')),
            reqUrl.searchParams.get('format') === 'events' ? 'events' : 'journal',
        ).catch((error) => {
            logger.error(`[GenerationJob] Failed to stream journal ${jobId}:`, error);
            try { ws.close(); } catch { /* ignore */ }
        });

        const pingTimer = setInterval(() => {
            if (ws.readyState !== ws.OPEN) return;
            ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
        }, job.heartbeatSec * 1000);

        ws.on('close', () => {
            clearInterval(pingTimer);
            const currentJob = generationRuntimeJobs.get(jobId);
            if (!currentJob) return;
            currentJob.clients.delete(ws);
        });

        ws.on('error', () => {
            clearInterval(pingTimer);
        });
    }

    function startGarbageCollection() {
        return setInterval(() => {
            const now = Date.now();
            for (const [jobId, job] of generationRuntimeJobs.entries()) {
                if (!job.done && !job.waitingDispatch && now >= job.deadlineAt && !job.abortController.signal.aborted) {
                    job.abortController.abort();
                }
                if (job.done && job.clients.size === 0 && job.cleanupAt > 0 && now >= job.cleanupAt) {
                    cleanupGenerationRuntimeJob(jobId);
                    continue;
                }
                if (!job.done && !job.waitingDispatch
                    && now - job.updatedAt > Math.max(GENERATION_REQUEST_DEFAULT_TIMEOUT_MS, job.timeoutMs * 2)) {
                    cleanupGenerationRuntimeJob(jobId);
                }
            }
        }, GENERATION_JOB_GC_INTERVAL_MS);
    }

    // Stop every unfinished provider request and return their run promises.
    function abortAll() {
        const runs = [];
        for (const job of generationRuntimeJobs.values()) {
            if (job.done) continue;
            job.abortController.abort();
            if (job.runPromise) runs.push(job.runPromise);
        }
        return runs;
    }

    async function rebuildMissingGenerationProjections() {
        const jobs = listGenerationJobsNeedingProjection(
            200,
            NORMALIZED_PROJECTION_SCHEMA_VERSION,
        );
        let rebuilt = 0;
        for (const job of jobs) {
            const rawResponse = readGenerationJobRaw(job.jobId);
            try {
                const { projection, events } = await projectGenerationJournal(job, rawResponse);
                replaceGenerationJobEvents(job.jobId, events);
                setGenerationJobProjection(job.jobId, projection);
                if (job.status === 'failed' && job.finishReason === 'projection_error') {
                    finishGenerationJob(
                        job.jobId,
                        'generated',
                        'projection_rebuilt',
                        null,
                        rawResponse.length,
                    );
                }
                rebuilt += 1;
            } catch (error) {
                setGenerationJobProjectionError(
                    job.jobId,
                    `Failed to rebuild normalized projection: ${error}`,
                );
            }
        }
        if (rebuilt > 0) {
            logger.info(`[GenerationJob] Rebuilt ${rebuilt} normalized projection(s) from raw journals`);
        }
    }

    return {
        generationRuntimeJobs,
        countActiveJobs,
        createGenerationRuntimeJob,
        markGenerationJobDone,
        findJob,
        runGenerationProviderJob,
        handleJournalConnection,
        startGarbageCollection,
        abortAll,
        rebuildMissingGenerationProjections,
    };
}

module.exports = {
    createProviderJobRunner,
    normalizeForwardHeaders,
    sanitizeGenerationTargetUrl,
};
