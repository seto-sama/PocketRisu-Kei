'use strict';

const { queryRequestLogMetadataById } = require('../logs/requestLogs.cjs');

function recordGenerationProviderContext(job, context) {
    if (!job.chatId) return;
    try {
        const metadata = queryRequestLogMetadataById(job.jobId);
        if (!metadata?.model) return;
        const { recordProviderContext } = require('../logs/providerContexts.cjs');
        recordProviderContext({
            responseId: job.chatId,
            jobId: job.jobId,
            adapterKind: job.adapterKind,
            model: metadata.model,
            context,
            createdAt: job.createdAt,
        });
    } catch (error) {
        console.error('[GenerationJob] Failed to save thought context:', error);
    }
}

module.exports = { recordGenerationProviderContext };
