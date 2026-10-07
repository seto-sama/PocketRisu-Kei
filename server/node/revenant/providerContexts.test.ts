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
                    adapterKind: 'google-gemini', dispatchGroup: 'native-group', dispatchMaxConcurrent: 1,
                    requestSpec: {
                        targetUrl: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent',
                        method: 'POST', body: Buffer.from(JSON.stringify({ contents: [] })),
                    },
                });
                const compatible = generation.createSingleGenerationJob({
                    jobId: 'compatible-job', chatId: 'compatible-response', jobType: 'model',
                    adapterKind: 'openai-compatible', dispatchGroup: 'compatible-group', dispatchMaxConcurrent: 1,
                    requestSpec: {
                        targetUrl: 'https://openrouter.ai/api/v1/chat/completions',
                        method: 'POST', body: Buffer.from(JSON.stringify({ model: 'google/gemini-2.5-flash', messages: [] })),
                    },
                });
                const nativeClaim = generation.claimQueuedGenerationDispatch(native.jobId);
                const compatibleClaim = generation.claimQueuedGenerationDispatch(compatible.jobId);

                logs.addRequestLog({
                    id: 'request-log', timestamp: 1, date: '', url: 'https://example.test',
                    body: '', header: '', response: '', success: true, chatId: 'native-response',
                });
                logs.clearRequestLogs();

                await projectGenerationJournal({
                    ...nativeClaim.job, responseStatus: 200, streaming: false,
                    responseHeaders: { 'content-type': 'application/json' },
                }, Buffer.from(JSON.stringify({
                    candidates: [{ content: { role: 'model', parts: [{ text: '', thoughtSignature: 'native-opaque-signature' }] } }],
                })));
                await projectGenerationJournal({
                    ...compatibleClaim.job, responseStatus: 200, streaming: false,
                    responseHeaders: { 'content-type': 'application/json' },
                }, Buffer.from(JSON.stringify({
                    choices: [{ message: {
                        role: 'assistant', content: 'answer',
                        extra_content: { google: { thought_signature: 'compatible-opaque-signature' } },
                        reasoning_details: [{ type: 'reasoning.encrypted', data: 'opaque-reasoning', format: 'google-gemini-v1' }],
                    } }],
                })));

                const result = {
                    identities: [nativeClaim.job.providerModel, compatibleClaim.job.providerModel],
                    records: contexts.queryProviderContexts(
                        ['native-response', 'compatible-response'],
                        'google-gemini', 'gemini-2.5-pro',
                    ).concat(contexts.queryProviderContexts(
                        ['compatible-response'], 'openai-compatible', 'google/gemini-2.5-flash',
                    )),
                    remainingRequestLogs: logs.countRequestLogs(),
                };
                require(path.join(base, 'persistence/connection.cjs')).db.close();
                require(path.join(base, '../logs/requestLogDb.cjs')).db.close();
                const withoutStore = await projectGenerationJournal({
                    ...nativeClaim.job, responseStatus: 200, streaming: false,
                }, Buffer.from(JSON.stringify({ candidates: [{ content: { parts: [
                    { text: 'answer retained', thoughtSignature: 'opaque' },
                ] } }] })));
                result.contentWithoutStore = withoutStore.content;
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
            ));
            process.stdout.write(JSON.stringify(result));
            require(path.join(base, '../logs/requestLogDb.cjs')).db.close();
        `, revenantDirectory], { cwd: directory, encoding: 'utf8' }))

        expect(initial.identities).toEqual(['gemini-2.5-pro', 'google/gemini-2.5-flash'])
        expect(initial.remainingRequestLogs).toBe(0)
        expect(initial.contentWithoutStore).toBe('answer retained')
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
        ])
        expect(restarted).toEqual(initial.records)
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
})
