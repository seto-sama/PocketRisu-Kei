'use strict';

const path = require('path');
const { recordGenerationProviderContext } = require('./providerContexts.cjs');

// The server decodes provider responses with the adapters' own decoders and
// the options the adapter attached to the request. Sucrase is a production
// dependency and only strips the TypeScript syntax.
require('sucrase/register/ts');

const {
    createDecodedChatProjection,
    decodeAdapterResponseBody,
    parseAdapterResponseDecoder,
} = require(path.join(
    __dirname,
    '../../src/ts/preset/adapter/responseDecoder.ts',
));

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
 * Decodes a complete provider journal. Jobs without a response decoder carry
 * non-chat provider traffic (batch polling, cache management) and have no
 * projection.
 */
async function projectGenerationJournal(job, rawResponse) {
    if (!job.responseDecoder) return undefined;
    if (job.responseStatus != null && (job.responseStatus < 200 || job.responseStatus >= 300)) {
        throw new Error(`Provider request failed with HTTP ${job.responseStatus}`);
    }
    const journal = Buffer.from(rawResponse || Buffer.alloc(0));
    const projection = createDecodedChatProjection();
    try {
        await decodeAdapterResponseBody(
            job.responseDecoder,
            new Response(journal).body,
            event => projection.apply(event),
            job.jobId && job.jobType === 'model'
                ? context => recordGenerationProviderContext(job, context)
                : undefined,
        );
    } catch (error) {
        // An interrupted journal can end inside a provider frame; everything
        // decoded before it is the partial result.
        if (!['interrupted', 'cancelled', 'failed_partial'].includes(job.status)) throw error;
    }
    // A tool-loop follow-up round inherits its pending provider result.
    const awaitingProviderResult = job.projection?.awaitingProviderResult === true
        || projection.progress().awaitingProviderResult === true;
    return {
        ...createProjection(job, projection.content(), 'server', journal.length),
        ...(awaitingProviderResult ? { awaitingProviderResult: true } : {}),
    };
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
    projectGenerationJournal,
};
