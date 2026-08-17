'use strict';

const path = require('path');

// The browser and Node server deliberately share the exact same ModelPreset
// adapter decoder. Sucrase is a production dependency and only strips the
// TypeScript syntax; the decoder itself stays the single source of truth.
require('sucrase/register/ts');

const {
    decodeRevenantGenerationJournal,
} = require(path.join(
    __dirname,
    '..',
    '..',
    '..',
    'src',
    'ts',
    'process',
    'revenant',
    'transport',
    'journalDecoder.ts',
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

function createClientGenerationProjection(job, content) {
    return createProjection(job, content, 'client');
}

async function projectGenerationJournal(job, rawResponse) {
    const journal = Buffer.from(rawResponse || Buffer.alloc(0));
    const response = new Response(journal);
    if (!response.body) throw new Error('Generation journal has no readable body');
    const content = await decodeRevenantGenerationJournal(
        {
            ...job,
            status: ['interrupted', 'cancelled', 'failed_partial'].includes(job.status)
                ? job.status
                : 'generated',
            projection: undefined,
        },
        response.body,
    );
    return createProjection(job, content, 'server', journal.length);
}

function isGenerationProjectionCurrent(projection, journalBytes) {
    return projection?.source === 'server'
        && Number.isSafeInteger(journalBytes)
        && journalBytes >= 0
        && projection.journalBytes === journalBytes;
}

module.exports = {
    NORMALIZED_PROJECTION_SCHEMA_VERSION,
    createClientGenerationProjection,
    isGenerationProjectionCurrent,
    projectGenerationJournal,
};
