import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const revenantDirectory = dirname(fileURLToPath(import.meta.url))

it('persists projected provider contexts through queue claim, request-log clearing, and restart', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'pocketrisu-provider-contexts-'))
    try {
        const initial = JSON.parse(execFileSync(process.execPath, ['-e', `
            const path = require('node:path');
            const base = process.argv[1];
            (async () => {
                const generation = require(path.join(base, 'generationDb.cjs'));
                const logs = require(path.join(base, '../logs/requestLogs.cjs'));
                const contexts = require(path.join(base, '../logs/providerContexts.cjs'));
                const { projectGenerationJournal } = require(path.join(base, 'generationProjection.cjs'));

                const native = generation.createSingleGenerationJob({
                    jobId: 'native-job', chatId: 'native-response', jobType: 'model',
                    adapterKind: 'google-gemini', responseDecoder: { adapterKind: 'google-gemini', stream: false }, dispatchGroup: 'native-group', dispatchMaxConcurrent: 1,
                    requestSpec: {
                        targetUrl: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent',
                        method: 'POST', body: Buffer.from(JSON.stringify({ contents: [] })),
                    },
                });
                const compatible = generation.createSingleGenerationJob({
                    jobId: 'compatible-job', chatId: 'compatible-response', jobType: 'model',
                    adapterKind: 'openai-compatible', responseDecoder: { adapterKind: 'openai-compatible', stream: false }, dispatchGroup: 'compatible-group', dispatchMaxConcurrent: 1,
                    requestSpec: {
                        targetUrl: 'https://openrouter.ai/api/v1/chat/completions',
                        method: 'POST', body: Buffer.from(JSON.stringify({ model: 'google/gemini-2.5-flash', messages: [] })),
                    },
                });
                const direct = generation.createSingleGenerationJob({
                    jobId: 'direct-job', chatId: 'direct-response', jobType: 'model',
                    adapterKind: 'openai-compatible', responseDecoder: { adapterKind: 'openai-compatible', stream: false },
                });
                const untracked = generation.createSingleGenerationJob({
                    jobId: 'untracked-job', chatId: 'untracked-response', jobType: 'model',
                    adapterKind: 'google-gemini', responseDecoder: { adapterKind: 'google-gemini', stream: false },
                });

                logs.addRequestLog({
                    id: native.jobId, timestamp: 1, date: '',
                    url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent',
                    body: '{}', header: '', response: '', success: true, chatId: native.chatId,
                });
                logs.addRequestLog({
                    id: compatible.jobId, timestamp: 2, date: '', url: 'https://openrouter.ai/api/v1/chat/completions',
                    body: JSON.stringify({ model: 'google/gemini-2.5-flash', messages: [] }),
                    header: '', response: '', success: true, chatId: compatible.chatId,
                });
                logs.addRequestLog({
                    id: direct.jobId, timestamp: 3, date: '', url: 'https://openrouter.ai/api/v1/chat/completions',
                    body: JSON.stringify({ model: 'direct/model', messages: [] }),
                    header: '', response: '', success: true, chatId: direct.chatId,
                });
                logs.clearRequestLogs('payload');

                const nativeClaim = generation.claimQueuedGenerationDispatch(native.jobId);
                const compatibleClaim = generation.claimQueuedGenerationDispatch(compatible.jobId);
                const directJob = generation.getGenerationJob(direct.jobId, false);
                const untrackedJob = generation.getGenerationJob(untracked.jobId, false);

                await projectGenerationJournal({
                    ...nativeClaim.job, responseStatus: 200,
                    responseHeaders: { 'content-type': 'application/json' },
                }, Buffer.from(JSON.stringify({
                    candidates: [{ content: { role: 'model', parts: [{ text: '', thoughtSignature: 'native-opaque-signature' }] } }],
                })));
                await projectGenerationJournal({
                    ...compatibleClaim.job, responseStatus: 200,
                    responseHeaders: { 'content-type': 'application/json' },
                }, Buffer.from(JSON.stringify({
                    choices: [{ message: {
                        role: 'assistant', content: 'answer',
                        extra_content: { google: { thought_signature: 'compatible-opaque-signature' } },
                        reasoning_details: [{ type: 'reasoning.encrypted', data: 'opaque-reasoning', format: 'google-gemini-v1' }],
                    } }],
                })));
                await projectGenerationJournal({
                    ...directJob, responseStatus: 200,
                    responseHeaders: { 'content-type': 'application/json' },
                }, Buffer.from(JSON.stringify({
                    choices: [{ message: { role: 'assistant', content: 'direct answer', extra_content: { google: { thought_signature: 'direct-opaque-signature' } } } }],
                })));

                const result = {
                    metadataModels: [native.jobId, compatible.jobId, direct.jobId].map(id =>
                        logs.queryRequestLogMetadataById(id)?.model ?? null),
                    payloadAvailability: [native.jobId, compatible.jobId, direct.jobId].map(id =>
                        logs.queryRequestLogById(id)?.payloadAvailable ?? null),
                    records: contexts.queryProviderContexts(
                        ['native-response'],
                        'google-gemini', 'gemini-2.5-pro',
                    ).concat(contexts.queryProviderContexts(
                        ['compatible-response'], 'openai-compatible', 'google/gemini-2.5-flash',
                    ), contexts.queryProviderContexts(
                        ['direct-response'], 'openai-compatible', 'direct/model',
                    )),
                    remainingRequestLogs: logs.countRequestLogs(),
                };
                const withoutMetadata = await projectGenerationJournal({
                    ...untrackedJob, responseStatus: 200,
                }, Buffer.from(JSON.stringify({ candidates: [{ content: { parts: [
                    { text: 'answer retained', thoughtSignature: 'opaque' },
                ] } }] })));
                result.contentWithoutMetadata = withoutMetadata.content;
                result.untrackedContexts = contexts.queryProviderContexts(
                    ['untracked-response'], 'google-gemini', 'unknown-model',
                );
                require(path.join(base, 'persistence/connection.cjs')).db.close();
                const logDatabases = require(path.join(base, '../logs/logDatabases.cjs'));
                logDatabases.requestDb.close();
                logDatabases.systemDb.close();
                process.stdout.write(JSON.stringify(result));
            })().catch(error => { console.error(error); process.exitCode = 1; });
        `, revenantDirectory], { cwd: directory, encoding: 'utf8' }))

        const restarted = JSON.parse(execFileSync(process.execPath, ['-e', `
            const path = require('node:path');
            const base = process.argv[1];
            const contexts = require(path.join(base, '../logs/providerContexts.cjs'));
            const result = contexts.queryProviderContexts(
                ['native-response'], 'google-gemini', 'gemini-2.5-pro',
            ).concat(contexts.queryProviderContexts(
                ['compatible-response'], 'openai-compatible', 'google/gemini-2.5-flash',
            ), contexts.queryProviderContexts(
                ['direct-response'], 'openai-compatible', 'direct/model',
            ));
            process.stdout.write(JSON.stringify(result));
            const logDatabases = require(path.join(base, '../logs/logDatabases.cjs'));
            logDatabases.requestDb.close();
            logDatabases.systemDb.close();
        `, revenantDirectory], { cwd: directory, encoding: 'utf8' }))

        expect(initial.metadataModels).toEqual([
            'gemini-2.5-pro', 'google/gemini-2.5-flash', 'direct/model',
        ])
        expect(initial.payloadAvailability).toEqual([false, false, false])
        expect(initial.remainingRequestLogs).toBe(3)
        expect(initial.contentWithoutMetadata).toBe('answer retained')
        expect(initial.untrackedContexts).toEqual([])
        expect(initial.records).toEqual([
            {
                responseId: 'native-response', adapterKind: 'google-gemini', model: 'gemini-2.5-pro',
                turns: [{ geminiParts: [{ text: '', thoughtSignature: 'native-opaque-signature' }] }],
            },
            {
                responseId: 'compatible-response', adapterKind: 'openai-compatible', model: 'google/gemini-2.5-flash',
                turns: [{
                    extraContent: { google: { thought_signature: 'compatible-opaque-signature' } },
                    reasoningDetails: [{ type: 'reasoning.encrypted', data: 'opaque-reasoning', format: 'google-gemini-v1' }],
                }],
            },
            {
                responseId: 'direct-response', adapterKind: 'openai-compatible', model: 'direct/model',
                turns: [{ extraContent: { google: { thought_signature: 'direct-opaque-signature' } } }],
            },
        ])
        expect(restarted).toEqual(initial.records)
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
})
