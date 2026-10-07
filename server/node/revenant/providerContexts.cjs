'use strict';

function resolveGenerationProviderModel(adapterKind, requestSpec) {
    if (!requestSpec) return null;
    try {
        if (adapterKind === 'google-gemini') {
            const match = /\/models\/([^/]+):(?:streamGenerateContent|generateContent)$/.exec(
                new URL(requestSpec.targetUrl).pathname,
            );
            return match ? decodeURIComponent(match[1]) : null;
        }
        if (adapterKind === 'openai-compatible') {
            const model = JSON.parse(Buffer.from(requestSpec.body).toString('utf8')).model;
            return typeof model === 'string' && model ? model : null;
        }
    } catch {
        // Requests with custom payloads can omit a model identity.
    }
    return null;
}

function recordGenerationProviderContext(job, context) {
    if (!job.chatId || !job.providerModel) return;
    try {
        const { recordProviderContext } = require('../logs/providerContexts.cjs');
        recordProviderContext({
            responseId: job.chatId,
            jobId: job.jobId,
            adapterKind: job.adapterKind,
            model: job.providerModel,
            context,
            createdAt: job.createdAt,
        });
    } catch (error) {
        console.error('[GenerationJob] Failed to save thought context:', error);
    }
}

module.exports = { resolveGenerationProviderModel, recordGenerationProviderContext };
