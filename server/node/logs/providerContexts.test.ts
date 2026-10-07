import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const directory = dirname(fileURLToPath(import.meta.url))
const providerContextsModule = join(directory, 'providerContexts.cjs')
const requestLogsModule = join(directory, 'requestLogs.cjs')
const requestLogDbModule = join(directory, 'requestLogDb.cjs')
const require = createRequire(import.meta.url)

type ProviderContextStore = {
    PROVIDER_CONTEXT_LIMIT: number
    recordProviderContext(arg: {
        responseId: string
        jobId: string
        adapterKind: string
        model: string
        context: unknown
        createdAt?: number
    }): void
    queryProviderContexts(responseIds: unknown[], adapterKind: string, model: string): Array<{
        responseId: string
        adapterKind: string
        model: string
        turns: unknown[]
    }>
}

function resetStoreModules() {
    for (const modulePath of [providerContextsModule, requestLogsModule, requestLogDbModule]) {
        delete require.cache[require.resolve(modulePath)]
    }
}

function withIsolatedStore<T>(run: (store: ProviderContextStore) => T): T {
    const previousWorkingDirectory = process.cwd()
    const workingDirectory = mkdtempSync(join(tmpdir(), 'risu-provider-contexts-'))
    process.chdir(workingDirectory)
    resetStoreModules()
    try {
        return run(require(providerContextsModule) as ProviderContextStore)
    } finally {
        const database = require.cache[require.resolve(requestLogDbModule)]?.exports as { db?: { close(): void } } | undefined
        database?.db?.close()
        resetStoreModules()
        process.chdir(previousWorkingDirectory)
        rmSync(workingDirectory, { recursive: true, force: true })
    }
}

describe.sequential('provider context persistence', () => {
    it('orders out-of-order projections, replaces duplicate jobs, and resets on model changes', () => {
        const result = withIsolatedStore(store => {
            store.recordProviderContext({
                responseId: 'message-1', jobId: 'job-b', adapterKind: 'google-gemini',
                model: 'gemini-2.5-pro', context: { turn: 'later' }, createdAt: 200,
            });
            store.recordProviderContext({
                responseId: 'message-1', jobId: 'job-a', adapterKind: 'google-gemini',
                model: 'gemini-2.5-pro', context: { turn: 'earlier' }, createdAt: 100,
            });
            store.recordProviderContext({
                responseId: 'message-1', jobId: 'job-b', adapterKind: 'google-gemini',
                model: 'gemini-2.5-pro', context: { turn: 'updated later' }, createdAt: 200,
            });
            const beforeModelChange = store.queryProviderContexts(
                ['message-1'], 'google-gemini', 'gemini-2.5-pro',
            )

            store.recordProviderContext({
                responseId: 'message-1', jobId: 'job-c', adapterKind: 'openai-compatible',
                model: 'openrouter/gemini', context: { turn: 'new protocol' }, createdAt: 300,
            });
            return {
                beforeModelChange,
                oldModel: store.queryProviderContexts(['message-1'], 'google-gemini', 'gemini-2.5-pro'),
                newModel: store.queryProviderContexts(['message-1'], 'openai-compatible', 'openrouter/gemini'),
            }
        }) as {
            beforeModelChange: Array<Record<string, unknown>>
            oldModel: unknown[]
            newModel: Array<Record<string, unknown>>
        }

        expect(result.beforeModelChange).toEqual([{
            responseId: 'message-1',
            adapterKind: 'google-gemini',
            model: 'gemini-2.5-pro',
            turns: [{ turn: 'earlier' }, { turn: 'updated later' }],
        }])
        expect(result.oldModel).toEqual([])
        expect(result.newModel).toEqual([{
            responseId: 'message-1',
            adapterKind: 'openai-compatible',
            model: 'openrouter/gemini',
            turns: [{ turn: 'new protocol' }],
        }])
    })

    it('retains the latest 100 response rows regardless of how many turns each contains', () => {
        const result = withIsolatedStore(store => {
            const responseIds: string[] = [];
            for (let index = 0; index < 105; index++) {
                const responseId = 'message-' + String(index).padStart(3, '0');
                responseIds.push(responseId);
                store.recordProviderContext({
                    responseId, jobId: 'job-0', adapterKind: 'google-gemini', model: 'gemini',
                    context: { turn: 0 }, createdAt: 1000 + index,
                });
                if (index === 104) {
                    for (let turn = 1; turn < 8; turn++) {
                        store.recordProviderContext({
                            responseId, jobId: 'job-' + turn, adapterKind: 'google-gemini', model: 'gemini',
                            context: { turn }, createdAt: 1000 + index + turn,
                        });
                    }
                }
            }
            return {
                rows: store.queryProviderContexts(responseIds, 'google-gemini', 'gemini'),
                limit: store.PROVIDER_CONTEXT_LIMIT,
            }
        }) as { rows: Array<{ responseId: string, turns: unknown[] }>, limit: number }

        expect(result.limit).toBe(100)
        expect(result.rows).toHaveLength(100)
        expect(result.rows[0].responseId).toBe('message-005')
        expect(result.rows.at(-1)).toEqual({
            responseId: 'message-104',
            adapterKind: 'google-gemini',
            model: 'gemini',
            turns: Array.from({ length: 8 }, (_, turn) => ({ turn })),
        })
    })

    it('keeps contexts when request logs are cleared', () => {
        const result = withIsolatedStore(store => {
            const requestLogs = require(requestLogsModule) as {
                addRequestLog(log: Record<string, unknown>): void
                clearRequestLogs(): void
                countRequestLogs(): number
            }
            requestLogs.addRequestLog({
                id: 'request-1', timestamp: 10, date: '', url: 'https://example.test',
                body: '', header: '', response: '', success: true, chatId: 'message-1',
            });
            store.recordProviderContext({
                responseId: 'message-1', jobId: 'job-1', adapterKind: 'google-gemini',
                model: 'gemini', context: { signature: 'opaque' }, createdAt: 10,
            });
            requestLogs.clearRequestLogs();
            return {
                requestLogCount: requestLogs.countRequestLogs(),
                contexts: store.queryProviderContexts(['message-1'], 'google-gemini', 'gemini'),
            }
        }) as {
            requestLogCount: number
            contexts: Array<Record<string, unknown>>
        }

        expect(result.requestLogCount).toBe(0)
        expect(result.contexts).toEqual([{
            responseId: 'message-1',
            adapterKind: 'google-gemini',
            model: 'gemini',
            turns: [{ signature: 'opaque' }],
        }])
    })
})
