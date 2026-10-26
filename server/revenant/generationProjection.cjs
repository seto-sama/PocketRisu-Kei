'use strict';

const path = require('path');
const { recordGenerationProviderContext } = require('./providerContexts.cjs');

// The server decodes provider responses with the adapters' own decoders and
// the options the adapter attached to the request. Sucrase is a production
// dependency and only strips the TypeScript syntax.
require('sucrase/register/ts');

const source = file => require(path.join(__dirname, '../../src/ts/preset/adapter', file));
const { createDecodedChatProjection, encodeDecodedChatEvent } = source('decodedEvents.ts');
const { decodeAdapterResponseBody, parseAdapterResponseDecoder } = source('responseDecoder.ts');

const PARTIAL_STATUSES = ['interrupted', 'cancelled', 'failed_partial'];

const NORMALIZED_PROJECTION_SCHEMA_VERSION = 1;

function createProjection(job, content, source, journalBytes) {
    return {
        schemaVersion: NORMALIZED_PROJECTION_SCHEMA_VERSION,
        source,
        adapterKind: job.adapterKind || 'openai-compatible',
        content: String(content ?? ''),
        ...(Number.isSafeInteger(journalBytes) && journalBytes >= 0
            ? { journalBytes }
            : {}),
    };
}

function createClientGenerationProjection(job, content, providerResult = false) {
    return createProjection(job, content, providerResult ? 'provider' : 'client',
        providerResult ? job.projection?.journalBytes ?? job.rawBytes : undefined);
}

/**
 * Decodes provider bytes while they arrive. Each decoded event goes to
 * `onEvent`; finish() returns the projection of everything decoded. Partial
 * journals (cancelled, interrupted) can end inside a provider frame, so a
 * decode error there keeps what was decoded before it.
 */
function createGenerationJournalDecoder(job, onEvent) {
    const projection = createDecodedChatProjection();
    let journalBytes = 0;
    let feed;
    let settled = false;
    let thoughtContext;
    const body = new ReadableStream({ start(controller) { feed = controller; } });
    const outcome = decodeAdapterResponseBody(
        job.responseDecoder,
        body,
        event => {
            projection.apply(event);
            onEvent(event);
        },
        job.jobId && job.jobType === 'model'
            ? context => { thoughtContext = context; }
            : undefined,
    ).then(() => { settled = true; }, error => {
        settled = true;
        return error;
    });

    return {
        push(bytes) {
            journalBytes += bytes.length;
            if (!settled) feed.enqueue(new Uint8Array(bytes));
        },
        async finish(partial) {
            if (!settled) feed.close();
            const error = await outcome;
            if (error && !partial) throw error;
            if (thoughtContext) recordGenerationProviderContext(job, thoughtContext);
            // A tool-loop follow-up round inherits its pending provider result.
            const awaitingProviderResult = job.projection?.awaitingProviderResult === true
                || projection.progress().awaitingProviderResult === true;
            return {
                ...createProjection(job, projection.content(), 'server', journalBytes),
                ...(awaitingProviderResult ? { awaitingProviderResult: true } : {}),
            };
        },
    };
}

/** Appends a running job's decoded events to its events journal. */
function openGenerationEventJournal(job, { journalStore, onWritten }) {
    const writer = journalStore.openWriter(job.workflowId, job.jobId, 'events');
    let writeError = null;
    writer.on('error', error => { writeError ||= error; });
    const decoder = createGenerationJournalDecoder(job, event => {
        writer.write(encodeDecodedChatEvent(event), onWritten);
    });
    return {
        push: decoder.push,
        async finish(partial) {
            let projection;
            let decodeError = null;
            try {
                projection = await decoder.finish(partial);
            } catch (error) {
                decodeError = error;
            }
            await new Promise(resolve => writer.end(resolve));
            onWritten();
            if (writeError) throw writeError;
            if (decodeError) throw decodeError;
            return projection;
        },
    };
}

/**
 * Rebuilds a finished job's projection and events from its raw journal. Jobs
 * without a response decoder carry non-chat provider traffic (batch polling,
 * cache management) and have neither.
 */
async function projectGenerationJournal(job, rawResponse) {
    if (!job.responseDecoder) return undefined;
    if (job.responseStatus != null && (job.responseStatus < 200 || job.responseStatus >= 300)) {
        throw new Error(`Provider request failed with HTTP ${job.responseStatus}`);
    }
    const events = [];
    const decoder = createGenerationJournalDecoder(job, event => events.push(encodeDecodedChatEvent(event)));
    decoder.push(Buffer.from(rawResponse || Buffer.alloc(0)));
    const projection = await decoder.finish(PARTIAL_STATUSES.includes(job.status));
    return { projection, events: Buffer.from(events.join('')) };
}

function isGenerationProjectionCurrent(projection, journalBytes) {
    return ['server', 'provider'].includes(projection?.source)
        && Number.isSafeInteger(journalBytes)
        && journalBytes >= 0
        && projection.journalBytes === journalBytes;
}

module.exports = {
    NORMALIZED_PROJECTION_SCHEMA_VERSION,
    parseAdapterResponseDecoder,
    createClientGenerationProjection,
    isGenerationProjectionCurrent,
    openGenerationEventJournal,
    projectGenerationJournal,
};
