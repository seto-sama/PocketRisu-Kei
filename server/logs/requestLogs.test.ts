import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const logsDirectory = dirname(fileURLToPath(import.meta.url))
const legacyTableSetup = `
    legacyDb.exec('CREATE TABLE request_logs (id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, date TEXT NOT NULL, url TEXT NOT NULL, body TEXT NOT NULL, header TEXT NOT NULL, response TEXT NOT NULL, success INTEGER NOT NULL, response_type TEXT, chat_id TEXT, status INTEGER, client_id TEXT, platform TEXT)');
    const insertLegacyLog = legacyDb.prepare('INSERT INTO request_logs (id, timestamp, date, url, body, header, response, success, response_type, chat_id, status, client_id, platform) VALUES (@id, @timestamp, @date, @url, @body, @header, @response, @success, @responseType, @chatId, @status, @clientId, @platform)');
`

function withIsolatedDatabase(script: string) {
    const workingDirectory = mkdtempSync(join(tmpdir(), 'risu-request-logs-'))
    try {
        return JSON.parse(execFileSync(process.execPath, ['-e', script, logsDirectory], {
            cwd: workingDirectory,
            encoding: 'utf8',
        }))
    } finally {
        rmSync(workingDirectory, { recursive: true, force: true })
    }
}

describe('request log persistence', () => {
    it('preserves payloads, tied timestamp ordering and pagination on reopen', () => {
        const result = withIsolatedDatabase(`
            const path = require('node:path');
            const base = process.argv[1];
            const store = require(path.join(base, 'requestLogs.cjs'));
            for (const entry of [
                { id: 'tie-first', timestamp: 100, response: 'first raw response' },
                { id: 'tie-second', timestamp: 100, response: 'second raw response' },
                { id: 'older', timestamp: 99, response: 'older raw response' },
            ]) {
                store.addRequestLog({
                    ...entry, date: 'test date', url: 'https://example.test/request',
                    body: 'request body ☃', header: '{"x-test":"preserved"}',
                    success: true, responseType: 'json', chatId: 'response', status: 200,
                    clientId: 'client', platform: 'Desktop',
                });
            }

            const databasesPath = path.join(base, 'logDatabases.cjs');
            const resetModules = () => {
                for (const name of [
                    'requestLogs.cjs', 'requestMetadata.cjs', 'providerContexts.cjs',
                    'requestScripts.cjs', 'requestLogLimits.cjs',
                    'usageDb.cjs', 'logs.cjs', 'logDatabases.cjs', '../db.cjs',
                ]) {
                    delete require.cache[require.resolve(path.join(base, name))];
                }
            };
            const closeDatabases = () => {
                const databases = require(databasesPath);
                databases.requestDb.close();
                databases.systemDb.close();
                require(path.join(base, '../db.cjs')).db.close();
            };
            const beforeReopen = {
                count: store.countRequestLogs(),
                order: store.queryRequestLogs({ limit: 3 }).map(log => log.id),
                firstPage: store.queryRequestLogs({ limit: 1 }).map(log => log.id),
                afterTieSecond: store.queryRequestLogs({ limit: 1, beforeId: 'tie-second' }).map(log => log.id),
                afterTieFirst: store.queryRequestLogs({ limit: 1, beforeId: 'tie-first' }).map(log => log.id),
                detail: store.queryRequestLogById('tie-first'),
            };
            closeDatabases();

            resetModules();
            const reopened = require(path.join(base, 'requestLogs.cjs'));
            const afterReopen = {
                count: reopened.countRequestLogs(),
                order: reopened.queryRequestLogs({ limit: 3 }).map(log => log.id),
                detail: reopened.queryRequestLogById('tie-first'),
            };
            closeDatabases();
            process.stdout.write(JSON.stringify({ beforeReopen, afterReopen }));
        `)

        expect(result.beforeReopen).toMatchObject({
            count: 3,
            order: ['tie-second', 'tie-first', 'older'],
            firstPage: ['tie-second'],
            afterTieSecond: ['tie-first'],
            afterTieFirst: ['older'],
            detail: {
                id: 'tie-first',
                timestamp: 100,
                date: 'test date',
                url: 'https://example.test/request',
                body: 'request body ☃',
                header: '{"x-test":"preserved"}',
                response: 'first raw response',
                success: true,
                responseType: 'json',
                chatId: 'response',
                status: 200,
                clientId: 'client',
                platform: 'Desktop',
                responseDurationMs: null,
                payloadAvailable: true,
            },
        })
        expect(result.afterReopen).toEqual({
            count: 3,
            order: ['tie-second', 'tie-first', 'older'],
            detail: result.beforeReopen.detail,
        })
    })

    it('keeps metadata and the newest payloads when a legacy database exceeds the payload budget', () => {
        const result = withIsolatedDatabase(`
            const path = require('node:path');
            const fs = require('node:fs');
            const base = process.argv[1];
            const saveDirectory = path.join(process.cwd(), 'save');
            fs.mkdirSync(saveDirectory, { recursive: true });
            const legacyPath = path.join(saveDirectory, 'request-logs.db');
            const Database = require(path.join(base, '../sqlite.cjs'));
            const legacyDb = new Database(legacyPath);
            ${legacyTableSetup}
            require(path.join(base, 'requestLogLimits.cjs')).setRequestLogMaxBytes(2 * 1024 * 1024);
            const bodyBytes = 256 * 1024;
            for (let index = 0; index < 9; index++) {
                const marker = String.fromCharCode(65 + index);
                insertLegacyLog.run({
                    id: 'legacy-' + String(index).padStart(2, '0'),
                    timestamp: 100,
                    date: 'legacy date',
                    url: 'https://example.test/legacy',
                    body: marker.repeat(bodyBytes),
                    header: '',
                    response: '',
                    success: 1,
                    responseType: 'json',
                    chatId: 'legacy-chat',
                    status: 200,
                    clientId: 'legacy-client',
                    platform: 'Desktop',
                });
            }
            legacyDb.close();

            const databasesPath = path.join(base, 'logDatabases.cjs');
            const resetModules = () => {
                for (const name of [
                    'requestLogs.cjs', 'requestMetadata.cjs', 'providerContexts.cjs',
                    'requestScripts.cjs', 'requestLogLimits.cjs',
                    'usageDb.cjs', 'logs.cjs', 'logDatabases.cjs', '../db.cjs',
                ]) {
                    delete require.cache[require.resolve(path.join(base, name))];
                }
            };
            const scriptDatabaseSize = () => {
                const databases = require(databasesPath);
                const script = databases.requestDb.pragma('database_list')
                    .find(database => database.name === 'request_script');
                databases.requestDb.pragma('request_script.wal_checkpoint(TRUNCATE)');
                return { path: script.file, bytes: fs.statSync(script.file).size };
            };
            const closeDatabases = () => {
                const databases = require(databasesPath);
                databases.requestDb.close();
                databases.systemDb.close();
                require(path.join(base, '../db.cjs')).db.close();
            };
            const inspect = store => {
                const ids = Array.from({ length: 9 }, (_, index) =>
                    'legacy-' + String(index).padStart(2, '0'));
                return {
                    count: store.countRequestLogs(),
                    order: store.queryRequestLogs({ limit: 20 }).map(log => log.id),
                    afterNewest: store.queryRequestLogs({ limit: 1, beforeId: 'legacy-08' }).map(log => log.id),
                    details: ids.map(id => {
                        const log = store.queryRequestLogById(id);
                        return {
                            id: log.id,
                            timestamp: log.timestamp,
                            date: log.date,
                            url: log.url,
                            status: log.status,
                            chatId: log.chatId,
                            payloadAvailable: log.payloadAvailable,
                            bodyLength: log.body.length,
                            marker: log.body[0] || '',
                            lastMarker: log.body.at(-1) || '',
                        };
                    }),
                };
            };

            resetModules();
            const migrated = require(path.join(base, 'requestLogs.cjs'));
            const afterMigration = inspect(migrated);
            const migrationFile = scriptDatabaseSize();
            closeDatabases();

            resetModules();
            const reopened = require(path.join(base, 'requestLogs.cjs'));
            const afterReopen = inspect(reopened);
            const reopenedFile = scriptDatabaseSize();
            closeDatabases();
            process.stdout.write(JSON.stringify({ bodyBytes, afterMigration, afterReopen, migrationFile, reopenedFile }));
        `)

        const ids = Array.from({ length: 9 }, (_, index) =>
            'legacy-' + String(index).padStart(2, '0'))
        const expectedMetadata = {
            count: 9,
            order: [...ids].reverse(),
            afterNewest: ['legacy-07'],
        }
        const verifyMigration = (migration: typeof result.afterMigration) => {
            expect(migration).toMatchObject(expectedMetadata)
            expect(migration.details).toHaveLength(9)
            expect(migration.details[0]).toMatchObject({
                id: 'legacy-00', timestamp: 100, payloadAvailable: false,
                bodyLength: 0, marker: '', lastMarker: '',
            })
            expect(migration.details.at(-1)).toMatchObject({
                id: 'legacy-08', timestamp: 100, payloadAvailable: true,
                bodyLength: 256 * 1024, marker: 'I', lastMarker: 'I',
            })
            for (const [index, detail] of migration.details.entries()) {
                expect(detail).toMatchObject({
                    id: ids[index], date: 'legacy date', url: 'https://example.test/legacy',
                    status: 200, chatId: 'legacy-chat',
                })
                if (detail.payloadAvailable) {
                    const marker = String.fromCharCode(65 + index)
                    expect(detail).toMatchObject({
                        bodyLength: 256 * 1024, marker, lastMarker: marker,
                    })
                } else {
                    expect(detail).toMatchObject({ bodyLength: 0, marker: '', lastMarker: '' })
                }
            }
        }
        expect(result.bodyBytes).toBe(256 * 1024)
        verifyMigration(result.afterMigration)
        expect(result.afterReopen).toEqual(result.afterMigration)
        expect(result.migrationFile.bytes).toBeLessThanOrEqual(2 * 1024 * 1024)
        expect(result.reopenedFile.bytes).toBeLessThanOrEqual(2 * 1024 * 1024)
    })

    it('bounds the payload database and reclaims pages through upsert, delete, and clear', () => {
        const result = withIsolatedDatabase(`
            const path = require('node:path');
            const fs = require('node:fs');
            const base = process.argv[1];
            const logs = require(path.join(base, 'requestLogs.cjs'));
            const databases = require(path.join(base, 'logDatabases.cjs'));
            const database = databases.requestDb;
            logs.setRequestLogMaxBytes(2 * 1024 * 1024);
            const payloadUnit = 8 * 1024;
            const payload = {
                body: '😀'.repeat(payloadUnit + 1),
                header: 'h'.repeat(payloadUnit),
                response: 'r'.repeat(3 * payloadUnit - 4),
            };
            const makeLog = (id, timestamp, values = payload) => ({
                id, timestamp, date: 'test date', url: 'https://example.test/budget',
                ...values, success: true, chatId: 'budget-chat',
            });
            const detail = id => logs.queryRequestLogById(id);
            const scriptPath = database.pragma('database_list')
                .find(entry => entry.name === 'request_script').file;
            const scriptFileBytes = () => {
                database.pragma('request_script.wal_checkpoint(TRUNCATE)');
                return fs.statSync(scriptPath).size;
            };

            for (let index = 0; index < 32; index++) {
                logs.addRequestLog(makeLog('request-' + String(index).padStart(2, '0'), 1000 + index));
            }
            const allIds = Array.from({ length: 32 }, (_, index) =>
                'request-' + String(index).padStart(2, '0'));
            const boundary = {
                count: logs.countRequestLogs(),
                allMetadataPreserved: logs.queryRequestLogs({ limit: 100 }).length === 32
                    && allIds.every(id => logs.queryRequestLogMetadataById(id)?.id === id),
                summariesOmitPayload: logs.queryRequestLogs({ limit: 100 }).every(log =>
                    !('body' in log) && !('header' in log) && !('response' in log)),
                oldestPayloadAvailable: detail('request-00')?.payloadAvailable,
                newestPayloadAvailable: detail('request-31')?.payloadAvailable,
                databaseBytes: scriptFileBytes(),
            };

            const updatedEvicted = logs.updateRequestLogResponseById(
                'request-00', 'metadata-only response', 504, false, 9000,
            );
            const metadataOnlyUpdate = {
                updated: updatedEvicted,
                payloadAvailable: detail('request-00')?.payloadAvailable,
                status: detail('request-00')?.status,
                success: detail('request-00')?.success,
                duration: detail('request-00')?.responseDurationMs,
            };

            logs.addRequestLog(makeLog('request-31', 1031, {
                body: 'small body', header: 'small header', response: 'small response',
            }));
            const upserted = detail('request-31');
            logs.addRequestLog(makeLog('request-32', 1032));
            const afterShrink = {
                count: logs.countRequestLogs(),
                upsertedPayload: upserted?.payloadAvailable,
                upsertedBody: upserted?.body,
                newPayloadAvailable: detail('request-32')?.payloadAvailable,
            };

            const deleted = logs.deleteRequestLog('request-32');
            const afterDelete = detail('request-32');
            logs.addRequestLog(makeLog('request-33', 1033));
            const deleteFreedBudget = {
                count: logs.countRequestLogs(),
                newPayloadAvailable: detail('request-33')?.payloadAvailable,
            };

            const beforePayloadClearBytes = scriptFileBytes();
            logs.clearRequestLogs('payload');
            const afterPayloadClearBytes = scriptFileBytes();
            const afterPayloadClear = {
                count: logs.countRequestLogs(),
                metadataRemains: logs.queryRequestLogMetadataById('request-33')?.id === 'request-33',
                oldestPayloadAvailable: detail('request-00')?.payloadAvailable,
                newestPayloadAvailable: detail('request-33')?.payloadAvailable,
                databaseBytes: afterPayloadClearBytes,
            };
            logs.addRequestLog(makeLog('after-payload-clear', 2000));
            const afterPayloadClearInsert = {
                count: logs.countRequestLogs(),
                payloadAvailable: detail('after-payload-clear')?.payloadAvailable,
                databaseBytes: scriptFileBytes(),
            };

            logs.clearRequestLogs('all');
            const afterClear = {
                count: logs.countRequestLogs(),
                priorMetadata: detail('request-33'),
            };
            database.pragma('request_script.wal_checkpoint(TRUNCATE)');
            database.close();
            databases.systemDb.close();
            process.stdout.write(JSON.stringify({
                boundary,
                metadataOnlyUpdate,
                upserted: upserted && {
                    body: upserted.body, header: upserted.header, response: upserted.response,
                    payloadAvailable: upserted.payloadAvailable, status: upserted.status,
                },
                afterShrink, deleted, afterDelete, deleteFreedBudget,
                beforePayloadClearBytes, afterPayloadClear, afterPayloadClearInsert, afterClear,
            }));
        `)

        const mebibyte = 1024 * 1024
        const payloadBudget = 2 * mebibyte
        expect(result.boundary).toEqual({
            count: 32,
            allMetadataPreserved: true,
            summariesOmitPayload: true,
            oldestPayloadAvailable: false,
            newestPayloadAvailable: true,
            databaseBytes: expect.any(Number),
        })
        expect(result.boundary.databaseBytes).toBeLessThanOrEqual(payloadBudget)
        expect(result.metadataOnlyUpdate).toEqual({
            updated: true, payloadAvailable: false,
            status: 504, success: false, duration: 9000 - 1000,
        })
        expect(result.upserted).toEqual({
            body: 'small body', header: 'small header', response: 'small response',
            payloadAvailable: true, status: null,
        })
        expect(result.afterShrink).toEqual({
            count: 33,
            upsertedPayload: true,
            upsertedBody: 'small body',
            newPayloadAvailable: true,
        })
        expect(result.deleted).toBe(true)
        expect(result.afterDelete).toBeNull()
        expect(result.deleteFreedBudget).toEqual({
            count: 33,
            newPayloadAvailable: true,
        })
        expect(result.afterPayloadClear.count).toBe(33)
        expect(result.afterPayloadClear.metadataRemains).toBe(true)
        expect(result.afterPayloadClear.oldestPayloadAvailable).toBe(false)
        expect(result.afterPayloadClear.newestPayloadAvailable).toBe(false)
        expect(result.afterPayloadClear.databaseBytes).toBeLessThanOrEqual(payloadBudget)
        expect(result.afterPayloadClear.databaseBytes).toBeLessThan(result.beforePayloadClearBytes)
        expect(result.afterPayloadClearInsert.count).toBe(34)
        expect(result.afterPayloadClearInsert.payloadAvailable).toBe(true)
        expect(result.afterPayloadClearInsert.databaseBytes).toBeLessThanOrEqual(payloadBudget)
        expect(result.afterClear).toEqual({ count: 0, priorMetadata: null })
    })

    it('persists an editable quota and trims only raw scripts when lowered', () => {
        const result = withIsolatedDatabase(`
            const path = require('node:path');
            const fs = require('node:fs');
            const base = process.argv[1];
            const mib = 1024 * 1024;
            const databasesPath = path.join(base, 'logDatabases.cjs');
            const mainDatabasePath = path.join(base, '../db.cjs');
            const resetModules = () => {
                for (const name of [
                    'requestLogs.cjs', 'requestMetadata.cjs', 'providerContexts.cjs',
                    'requestScripts.cjs', 'requestLogLimits.cjs',
                    'usageDb.cjs', 'logs.cjs', 'logDatabases.cjs', '../db.cjs',
                ]) {
                    delete require.cache[require.resolve(path.join(base, name))];
                }
            };
            const closeDatabases = () => {
                const databases = require(databasesPath);
                databases.requestDb.close();
                databases.systemDb.close();
                require(mainDatabasePath).db.close();
            };
            const loadStores = () => ({
                logs: require(path.join(base, 'requestLogs.cjs')),
                contexts: require(path.join(base, 'providerContexts.cjs')),
            });
            const makeLog = (id, timestamp) => ({
                id, timestamp, date: 'quota test', url: 'https://example.test/quota',
                body: 'x'.repeat(900 * 1024), header: '', response: '', success: true,
            });

            let { logs, contexts } = loadStores();
            let databases = require(databasesPath);
            databases.requestDb.pragma('wal_autocheckpoint = 0');
            logs.setRequestLogMaxBytes(2 * mib);
            const twoMiB = logs.getRequestLogStorage();
            contexts.recordProviderContext({
                responseId: 'signature-kept', jobId: 'job-1', adapterKind: 'google-gemini',
                model: 'gemini', context: { signature: 'opaque' }, createdAt: 10,
            });
            for (let index = 1; index <= 3; index++) {
                logs.addRequestLog(makeLog('quota-' + index, index));
            }
            const scriptPath = databases.requestDb.pragma('database_list')
                .find(entry => entry.name === 'request_script').file;
            const walPath = scriptPath + '-wal';
            const twoMiBState = {
                storage: logs.getRequestLogStorage(),
                count: logs.countRequestLogs(),
                payloads: [1, 2, 3].map(index => logs.queryRequestLogById('quota-' + index).payloadAvailable),
                signature: contexts.queryProviderContexts(['signature-kept'], 'google-gemini', 'gemini'),
                walBytes: fs.existsSync(walPath) ? fs.statSync(walPath).size : 0,
            };

            logs.setRequestLogMaxBytes(4 * mib);
            const fourMiB = logs.getRequestLogStorage();
            logs.addRequestLog(makeLog('quota-4', 4));
            closeDatabases();
            resetModules();

            ({ logs, contexts } = loadStores());
            const afterRestart = {
                storage: logs.getRequestLogStorage(),
                payloadAvailable: logs.queryRequestLogById('quota-4').payloadAvailable,
                count: logs.countRequestLogs(),
            };
            logs.setRequestLogMaxBytes(mib);
            const oneMiB = logs.getRequestLogStorage();
            const afterLowering = {
                storage: logs.getRequestLogStorage(),
                count: logs.countRequestLogs(),
                metadataIds: ['quota-1', 'quota-2', 'quota-3', 'quota-4'].filter(id =>
                    logs.queryRequestLogMetadataById(id)?.id === id),
                payloads: [1, 2, 3, 4].map(index => logs.queryRequestLogById('quota-' + index).payloadAvailable),
                signature: contexts.queryProviderContexts(['signature-kept'], 'google-gemini', 'gemini'),
            };
            databases = require(databasesPath);
            databases.requestDb.pragma('request_script.wal_checkpoint(TRUNCATE)');
            const activeDatabaseBytes = fs.statSync(scriptPath).size;
            closeDatabases();
            process.stdout.write(JSON.stringify({
                twoMiB, twoMiBState, fourMiB, afterRestart, oneMiB, afterLowering, activeDatabaseBytes,
            }));
        `)

        const mebibyte = 1024 * 1024
        expect(result.twoMiB.maxBytes).toBe(2 * mebibyte)
        expect(result.twoMiBState).toMatchObject({
            count: 3,
            payloads: [false, true, true],
            signature: [{
                responseId: 'signature-kept', adapterKind: 'google-gemini', model: 'gemini',
                turns: [{ signature: 'opaque' }],
            }],
        })
        expect(result.twoMiBState.storage).toMatchObject({ maxBytes: 2 * mebibyte })
        expect(result.twoMiBState.storage.currentBytes).toBeLessThanOrEqual(2 * mebibyte)
        expect(result.twoMiBState.walBytes).toBeGreaterThan(2 * mebibyte)
        expect(result.fourMiB.maxBytes).toBe(4 * mebibyte)
        expect(result.afterRestart).toMatchObject({
            storage: { maxBytes: 4 * mebibyte },
            payloadAvailable: true,
            count: 4,
        })
        expect(result.oneMiB.maxBytes).toBe(mebibyte)
        expect(result.afterLowering).toMatchObject({
            storage: { maxBytes: mebibyte },
            count: 4,
            metadataIds: ['quota-1', 'quota-2', 'quota-3', 'quota-4'],
            payloads: [false, false, false, true],
            signature: [{
                responseId: 'signature-kept', adapterKind: 'google-gemini', model: 'gemini',
                turns: [{ signature: 'opaque' }],
            }],
        })
        expect(result.afterLowering.storage.currentBytes).toBeLessThanOrEqual(mebibyte)
        expect(result.activeDatabaseBytes).toBeLessThanOrEqual(mebibyte)
    })
})
