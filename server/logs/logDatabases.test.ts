import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const logsDirectory = dirname(fileURLToPath(import.meta.url))

function withIsolatedDatabase(script: string) {
    const workingDirectory = mkdtempSync(join(tmpdir(), 'risu-log-databases-'))
    try {
        return JSON.parse(execFileSync(process.execPath, ['-e', script, logsDirectory], {
            cwd: workingDirectory,
            encoding: 'utf8',
        }))
    } finally {
        rmSync(workingDirectory, { recursive: true, force: true })
    }
}

function withRestartedMigration(interruption: string, recovery: string) {
    const workingDirectory = mkdtempSync(join(tmpdir(), 'risu-file-migration-'))
    try {
        execFileSync(process.execPath, ['-e', interruption, logsDirectory], {
            cwd: workingDirectory,
            encoding: 'utf8',
        })
        return JSON.parse(execFileSync(process.execPath, ['-e', recovery, logsDirectory], {
            cwd: workingDirectory,
            encoding: 'utf8',
        }))
    } finally {
        rmSync(workingDirectory, { recursive: true, force: true })
    }
}

describe('log database migration', () => {
    it('migrates deployed log files, preserves row ordering and sequence, and retains originals', () => {
        const result = withIsolatedDatabase(`
            const fs = require('node:fs');
            const path = require('node:path');
            const base = process.argv[1];
            const save = path.join(process.cwd(), 'save');
            fs.mkdirSync(save, { recursive: true });
            const Database = require(path.join(base, '../sqlite.cjs'));

            const oldSystem = new Database(path.join(save, 'logs.db'));
            oldSystem.exec(\`
                CREATE TABLE logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER NOT NULL,
                    level TEXT NOT NULL, origin TEXT NOT NULL, message TEXT NOT NULL,
                    description TEXT, source TEXT, count INTEGER NOT NULL DEFAULT 1,
                    platform TEXT, client_id TEXT, user_agent TEXT
                );
            \`);
            const insertLog = oldSystem.prepare(\`
                INSERT INTO logs (id, timestamp, level, origin, message, count)
                VALUES (?, ?, ?, ?, ?, ?)
            \`);
            insertLog.run(7, 100, 'warning', 'server', 'retained legacy log', 2);
            insertLog.run(12, 101, 'info', 'client', 'deleted high row', 1);
            oldSystem.prepare('DELETE FROM logs WHERE id = 12').run();
            insertLog.run(50, 102, 'info', 'client', 'deleted sequence row', 1);
            oldSystem.prepare('DELETE FROM logs WHERE id = 50').run();
            oldSystem.close();

            const oldRequests = new Database(path.join(save, 'request-logs.db'));
            oldRequests.exec(\`
                CREATE TABLE request_logs (
                    id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, date TEXT NOT NULL,
                    url TEXT NOT NULL, body TEXT NOT NULL, header TEXT NOT NULL,
                    response TEXT NOT NULL, success INTEGER NOT NULL, response_type TEXT,
                    chat_id TEXT, status INTEGER, client_id TEXT, platform TEXT
                );
                CREATE TABLE generation_usage (
                    job_id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, chat_id TEXT,
                    provider TEXT, model TEXT, prompt_tokens INTEGER, completion_tokens INTEGER,
                    total_tokens INTEGER, cached_tokens INTEGER, cache_read_tokens INTEGER,
                    cache_creation_tokens INTEGER, reasoning_tokens INTEGER,
                    service_tier TEXT, gateway_cost REAL, usage_json TEXT NOT NULL
                );
            \`);
            const insertRequest = oldRequests.prepare(\`
                INSERT INTO request_logs (
                    id, timestamp, date, url, body, header, response, success,
                    response_type, chat_id, status, client_id, platform
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            \`);
            insertRequest.run(
                'req-first', 200, 'legacy date', 'https://api.example.test/v1/chat/completions',
                JSON.stringify({ model: 'legacy-model', messages: [] }),
                '{"x-test":"first"}', '{"answer":"first"}', 1, 'json',
                'chat-legacy', 200, 'client-legacy', 'Desktop',
            );
            insertRequest.run(
                'req-second', 200, 'legacy date', 'https://api.example.test/v1/chat/completions',
                JSON.stringify({ model: 'legacy-model', messages: [{ role: 'user', content: 'x' }] }),
                '{"x-test":"second"}', '{"answer":"second"}', 1, 'json',
                'chat-legacy', 200, 'client-legacy', 'Desktop',
            );
            oldRequests.prepare(\`
                INSERT INTO generation_usage (
                    job_id, timestamp, chat_id, provider, model, prompt_tokens,
                    completion_tokens, total_tokens, cached_tokens, cache_read_tokens,
                    cache_creation_tokens, reasoning_tokens, service_tier, gateway_cost, usage_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            \`).run(
                'req-first', 200, 'chat-legacy', 'openai', 'legacy-model',
                10, 20, 30, 2, 3, 4, 5, 'priority', 0.25, '[{"prompt_tokens":10}]',
            );
            oldRequests.close();

            // An older usage.db can contain rows already deleted from request-logs.db.
            const staleUsage = new Database(path.join(save, 'usage.db'));
            staleUsage.exec(\`
                CREATE TABLE generation_usage (
                    job_id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, chat_id TEXT,
                    provider TEXT, model TEXT, prompt_tokens INTEGER, completion_tokens INTEGER,
                    total_tokens INTEGER, usage_json TEXT NOT NULL
                );
            \`);
            staleUsage.prepare(\`
                INSERT INTO generation_usage (job_id, timestamp, provider, model, prompt_tokens, usage_json)
                VALUES ('stale-deleted-row', 150, 'openai', 'old-model', 99, '[]')
            \`).run();
            staleUsage.close();

            const databasesPath = path.join(base, 'logDatabases.cjs');
            const resetModules = () => {
                for (const name of [
                    'logDatabases.cjs', 'requestScripts.cjs', 'logs.cjs', 'requestLogs.cjs',
                    'usageDb.cjs', 'providerContexts.cjs',
                ]) delete require.cache[require.resolve(path.join(base, name))];
            };
            const closeDatabases = () => {
                const stores = require(databasesPath);
                stores.requestDb.close();
                stores.systemDb.close();
            };
            resetModules();
            const stores = require(databasesPath);
            const logs = require(path.join(base, 'logs.cjs'));
            const requests = require(path.join(base, 'requestLogs.cjs'));
            const usage = require(path.join(base, 'usageDb.cjs'));
            logs.addLog({ timestamp: 300, level: 'info', origin: 'server', message: 'after migration' });
            const databases = stores.requestDb.pragma('database_list');
            const mainTables = stores.requestDb.prepare(
                "SELECT name FROM main.sqlite_master WHERE type = 'table' ORDER BY name",
            ).all().map(row => row.name);
            const scriptTables = stores.requestDb.prepare(
                "SELECT name FROM request_script.sqlite_master WHERE type = 'table' ORDER BY name",
            ).all().map(row => row.name);
            const beforeRestart = {
                logRows: logs.queryLogs({ limit: 10 }),
                requestOrder: requests.queryRequestLogs({ limit: 10 }).map(row => row.id),
                request: requests.queryRequestLogById('req-first'),
                usage: usage.listUsage({ start: 0, end: 500 }),
                databases: databases.map(row => ({ name: row.name, file: path.basename(row.file) })),
                mainTables,
                scriptTables,
                origins: ['logs.db', 'request-logs.db', 'usage.db'].map(name => ({
                    name,
                    retained: fs.existsSync(path.join(save, 'migration', 'origin',
                        name === 'logs.db' ? 'system-logs' : 'request-logs', name)),
                    sourceRemains: fs.existsSync(path.join(save, name)),
                })),
            };
            closeDatabases();

            resetModules();
            const reopenedStores = require(databasesPath);
            const reopenedLogs = require(path.join(base, 'logs.cjs'));
            const reopenedRequests = require(path.join(base, 'requestLogs.cjs'));
            const reopenedUsage = require(path.join(base, 'usageDb.cjs'));
            const afterRestart = {
                logIds: reopenedLogs.queryLogs({ limit: 10 }).map(row => row.id),
                requestOrder: reopenedRequests.queryRequestLogs({ limit: 10 }).map(row => row.id),
                usage: reopenedUsage.listUsage({ start: 0, end: 500 }),
            };
            reopenedUsage.clearUsage();
            reopenedStores.requestDb.close();
            reopenedStores.systemDb.close();

            resetModules();
            require(databasesPath);
            const afterManualClear = require(path.join(base, 'usageDb.cjs')).listUsage({ start: 0, end: 500 });
            closeDatabases();
            process.stdout.write(JSON.stringify({ beforeRestart, afterRestart, afterManualClear }));
        `)

        expect(result.beforeRestart.logRows.map((row: { id: number }) => row.id)).toEqual([51, 7])
        expect(result.beforeRestart.requestOrder).toEqual(['req-second', 'req-first'])
        expect(result.beforeRestart.request).toMatchObject({
            id: 'req-first',
            body: JSON.stringify({ model: 'legacy-model', messages: [] }),
            header: '{"x-test":"first"}',
            response: '{"answer":"first"}',
            responseDurationMs: null,
            model: 'legacy-model',
            payloadAvailable: true,
        })
        expect(result.beforeRestart.usage).toEqual([{
            jobId: 'req-first', timestamp: 200, chatId: 'chat-legacy', provider: 'openai',
            model: 'legacy-model', promptTokens: 10, completionTokens: 20, totalTokens: 30,
            cachedTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4, reasoningTokens: 5,
            serviceTier: 'priority', gatewayCost: 0.25,
        }])
        expect(result.beforeRestart.databases).toEqual([
            { name: 'main', file: 'request-metadata.db' },
            { name: 'request_script', file: 'request-script.db' },
        ])
        expect(result.beforeRestart.mainTables).toEqual(['metadata', 'thought_signatures', 'usage'])
        expect(result.beforeRestart.scriptTables).toEqual(['script'])
        expect(result.beforeRestart.origins).toEqual([
            { name: 'logs.db', retained: true, sourceRemains: false },
            { name: 'request-logs.db', retained: true, sourceRemains: false },
            { name: 'usage.db', retained: true, sourceRemains: false },
        ])
        expect(result.afterRestart).toMatchObject({
            logIds: [51, 7], requestOrder: ['req-second', 'req-first'],
            usage: result.beforeRestart.usage,
        })
        expect(result.afterManualClear).toEqual([])
    })

    it('migrates the current split request layout and ignores stale usage when the request database owns usage', () => {
        const result = withIsolatedDatabase(`
            const fs = require('node:fs');
            const path = require('node:path');
            const base = process.argv[1];
            const save = path.join(process.cwd(), 'save');
            fs.mkdirSync(save, { recursive: true });
            const Database = require(path.join(base, '../sqlite.cjs'));

            const oldRequests = new Database(path.join(save, 'request-logs.db'));
            oldRequests.exec(\`
                CREATE TABLE request_logs (
                    id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, date TEXT NOT NULL,
                    url TEXT NOT NULL, success INTEGER NOT NULL, response_type TEXT,
                    chat_id TEXT, status INTEGER, client_id TEXT, platform TEXT,
                    duration_ms INTEGER, model TEXT
                );
                CREATE TABLE request_log_payloads (
                    id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, body TEXT NOT NULL,
                    header TEXT NOT NULL, response TEXT NOT NULL, bytes INTEGER NOT NULL
                );
                CREATE TABLE request_log_payload_usage (
                    id INTEGER PRIMARY KEY CHECK (id = 1), bytes INTEGER NOT NULL
                );
                CREATE TABLE generation_usage (
                    job_id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, chat_id TEXT,
                    provider TEXT, model TEXT, prompt_tokens INTEGER, completion_tokens INTEGER,
                    total_tokens INTEGER, cached_tokens INTEGER, cache_read_tokens INTEGER,
                    cache_creation_tokens INTEGER, usage_json TEXT NOT NULL
                );
            \`);
            const insertMetadata = oldRequests.prepare(\`
                INSERT INTO request_logs (
                    id, timestamp, date, url, success, response_type, chat_id, status,
                    client_id, platform, duration_ms, model
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            \`);
            insertMetadata.run('split-first', 300, 'split date', 'https://api.example.test/v1/chat/completions',
                1, 'json', 'split-chat', 200, null, 'Desktop', 123, null);
            insertMetadata.run('split-second', 300, 'split date', 'https://generativelanguage.googleapis.com/v1/models/url-model:generateContent',
                1, 'json', 'split-chat', 200, null, 'Desktop', null, null);
            const insertPayload = oldRequests.prepare(\`
                INSERT INTO request_log_payloads (id, timestamp, body, header, response, bytes)
                VALUES (?, ?, ?, ?, ?, ?)
            \`);
            const firstBody = JSON.stringify({ model: 'split-model', messages: [] });
            const secondBody = JSON.stringify({ contents: [] });
            insertPayload.run('split-first', 300, firstBody, '{"x-split":"first"}', 'first response', 50);
            insertPayload.run('split-second', 300, secondBody, '{"x-split":"second"}', 'second response', 40);
            oldRequests.prepare(\`
                INSERT INTO generation_usage (
                    job_id, timestamp, chat_id, provider, model, prompt_tokens,
                    completion_tokens, total_tokens, cached_tokens, cache_read_tokens,
                    cache_creation_tokens, usage_json
                ) VALUES ('split-first', 300, 'split-chat', 'openai', 'split-model', 4, 6, 10, 1, 2, 3, '[]')
            \`).run();
            oldRequests.close();

            const staleUsage = new Database(path.join(save, 'usage.db'));
            staleUsage.exec(\`
                CREATE TABLE generation_usage (
                    job_id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, provider TEXT,
                    model TEXT, prompt_tokens INTEGER, usage_json TEXT NOT NULL
                );
            \`);
            staleUsage.prepare(\`
                INSERT INTO generation_usage (job_id, timestamp, provider, model, prompt_tokens, usage_json)
                VALUES ('must-not-return', 250, 'openai', 'deleted-model', 99, '[]')
            \`).run();
            staleUsage.close();

            const databasesPath = path.join(base, 'logDatabases.cjs');
            const resetModules = () => {
                for (const name of [
                    'logDatabases.cjs', 'requestScripts.cjs', 'logs.cjs', 'requestLogs.cjs',
                    'usageDb.cjs', 'providerContexts.cjs',
                ]) delete require.cache[require.resolve(path.join(base, name))];
            };
            resetModules();
            const stores = require(databasesPath);
            const requests = require(path.join(base, 'requestLogs.cjs'));
            const usage = require(path.join(base, 'usageDb.cjs'));
            const result = {
                order: requests.queryRequestLogs({ limit: 10 }).map(row => row.id),
                first: requests.queryRequestLogById('split-first'),
                second: requests.queryRequestLogById('split-second'),
                usage: usage.listUsage({ start: 0, end: 500 }),
                origins: ['request-logs.db', 'usage.db'].map(name => ({
                    name,
                    retained: fs.existsSync(path.join(save, 'migration', 'origin', 'request-logs', name)),
                    sourceRemains: fs.existsSync(path.join(save, name)),
                })),
            };
            stores.requestDb.close();
            stores.systemDb.close();
            process.stdout.write(JSON.stringify(result));
        `)

        expect(result.order).toEqual(['split-second', 'split-first'])
        expect(result.first).toMatchObject({
            id: 'split-first', body: JSON.stringify({ model: 'split-model', messages: [] }),
            header: '{"x-split":"first"}', response: 'first response',
            responseDurationMs: 123, model: 'split-model', payloadAvailable: true,
        })
        expect(result.second).toMatchObject({
            id: 'split-second', body: JSON.stringify({ contents: [] }),
            model: 'url-model', payloadAvailable: true,
        })
        expect(result.usage).toEqual([{
            jobId: 'split-first', timestamp: 300, chatId: 'split-chat', provider: 'openai',
            model: 'split-model', promptTokens: 4, completionTokens: 6, totalTokens: 10,
            cachedTokens: 1, cacheReadTokens: 2, cacheCreationTokens: 3,
            reasoningTokens: null, serviceTier: null, gatewayCost: null,
        }])
        expect(result.origins).toEqual([
            { name: 'request-logs.db', retained: true, sourceRemains: false },
            { name: 'usage.db', retained: true, sourceRemains: false },
        ])
    })

    it('merges usage.db after an unmarked legacy import without replacing or dropping job IDs', () => {
        const result = withIsolatedDatabase(`
            const fs = require('node:fs');
            const path = require('node:path');
            const base = process.argv[1];
            const save = path.join(process.cwd(), 'save');
            fs.mkdirSync(save, { recursive: true });
            const Database = require(path.join(base, '../sqlite.cjs'));

            const consolidated = new Database(path.join(save, 'request-logs.db'));
            consolidated.exec(\`
                CREATE TABLE request_logs (
                    id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, date TEXT NOT NULL,
                    url TEXT NOT NULL, success INTEGER NOT NULL
                );
                CREATE TABLE generation_usage (
                    job_id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, chat_id TEXT,
                    provider TEXT, model TEXT, prompt_tokens INTEGER, completion_tokens INTEGER,
                    total_tokens INTEGER, usage_json TEXT NOT NULL
                );
                CREATE TABLE request_log_migrations (key TEXT PRIMARY KEY, completed_at INTEGER NOT NULL);
            \`);
            consolidated.prepare(\`
                INSERT INTO generation_usage (
                    job_id, timestamp, chat_id, provider, model,
                    prompt_tokens, completion_tokens, total_tokens, usage_json
                ) VALUES ('job-current', 200, 'chat-1', 'openai', 'current-model', 10, 20, 30, '[{"source":"request-logs"}]')
            \`).run();
            consolidated.close();

            const legacyUsage = new Database(path.join(save, 'usage.db'));
            legacyUsage.exec(\`
                CREATE TABLE generation_usage (
                    job_id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, chat_id TEXT,
                    provider TEXT, model TEXT, prompt_tokens INTEGER, completion_tokens INTEGER,
                    total_tokens INTEGER, usage_json TEXT NOT NULL
                );
            \`);
            legacyUsage.prepare(\`
                INSERT INTO generation_usage (
                    rowid, job_id, timestamp, chat_id, provider, model,
                    prompt_tokens, completion_tokens, total_tokens, usage_json
                ) VALUES (1, 'job-extra', 100, 'chat-2', 'anthropic', 'legacy-model', 4, 5, 9, '[]')
            \`).run();
            legacyUsage.prepare(\`
                INSERT INTO generation_usage (
                    rowid, job_id, timestamp, chat_id, provider, model,
                    prompt_tokens, completion_tokens, total_tokens, usage_json
                ) VALUES (2, 'job-current', 150, 'chat-1', 'openai', 'old-model', 1, 2, 3, '[{"source":"old-usage"}]')
            \`).run();
            legacyUsage.close();

            const stores = require(path.join(base, 'logDatabases.cjs'));
            const usage = require(path.join(base, 'usageDb.cjs'));
            const rows = usage.listUsage({ start: 0, end: 300 });
            const origins = ['request-logs.db', 'usage.db'].map(name => ({
                name,
                retained: fs.existsSync(path.join(save, 'migration', 'origin', 'request-logs', name)),
                sourceRemains: fs.existsSync(path.join(save, name)),
            }));
            stores.requestDb.close();
            stores.systemDb.close();
            process.stdout.write(JSON.stringify({ rows, origins }));
        `)

        expect(result.rows).toEqual([
            {
                jobId: 'job-current', timestamp: 200, chatId: 'chat-1', provider: 'openai',
                model: 'current-model', promptTokens: 10, completionTokens: 20, totalTokens: 30,
                cachedTokens: null, cacheReadTokens: null, cacheCreationTokens: null,
                reasoningTokens: null, serviceTier: null, gatewayCost: null,
            },
            {
                jobId: 'job-extra', timestamp: 100, chatId: 'chat-2', provider: 'anthropic',
                model: 'legacy-model', promptTokens: 4, completionTokens: 5, totalTokens: 9,
                cachedTokens: null, cacheReadTokens: null, cacheCreationTokens: null,
                reasoningTokens: null, serviceTier: null, gatewayCost: null,
            },
        ])
        expect(result.origins).toEqual([
            { name: 'request-logs.db', retained: true, sourceRemains: false },
            { name: 'usage.db', retained: true, sourceRemains: false },
        ])
    })

    it('uses usage.db when the request database has no generation usage table', () => {
        const result = withIsolatedDatabase(`
            const path = require('node:path');
            const fs = require('node:fs');
            const base = process.argv[1];
            const save = path.join(process.cwd(), 'save');
            fs.mkdirSync(save, { recursive: true });
            const Database = require(path.join(base, '../sqlite.cjs'));

            const oldRequests = new Database(path.join(save, 'request-logs.db'));
            oldRequests.exec(\`
                CREATE TABLE request_logs (
                    id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, date TEXT NOT NULL,
                    url TEXT NOT NULL, success INTEGER NOT NULL, response_type TEXT,
                    chat_id TEXT, status INTEGER, client_id TEXT, platform TEXT
                );
            \`);
            oldRequests.close();
            const oldUsage = new Database(path.join(save, 'usage.db'));
            oldUsage.exec(\`
                CREATE TABLE generation_usage (
                    job_id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, chat_id TEXT,
                    provider TEXT, model TEXT, prompt_tokens INTEGER, completion_tokens INTEGER,
                    total_tokens INTEGER, usage_json TEXT NOT NULL
                );
            \`);
            oldUsage.prepare(\`
                INSERT INTO generation_usage (
                    job_id, timestamp, chat_id, provider, model,
                    prompt_tokens, completion_tokens, total_tokens, usage_json
                ) VALUES ('usage-fallback', 400, 'fallback-chat', 'anthropic', 'claude-old', 8, 9, 17, '[]')
            \`).run();
            oldUsage.close();

            const stores = require(path.join(base, 'logDatabases.cjs'));
            const usage = require(path.join(base, 'usageDb.cjs'));
            const rows = usage.listUsage({ start: 0, end: 500 });
            const retained = fs.existsSync(path.join(save, 'migration', 'origin', 'request-logs', 'usage.db'));
            stores.requestDb.close();
            stores.systemDb.close();
            process.stdout.write(JSON.stringify({ rows, retained }));
        `)

        expect(result.rows).toEqual([{
            jobId: 'usage-fallback', timestamp: 400, chatId: 'fallback-chat',
            provider: 'anthropic', model: 'claude-old', promptTokens: 8,
            completionTokens: 9, totalTokens: 17, cachedTokens: null,
            cacheReadTokens: null, cacheCreationTokens: null, reasoningTokens: null,
            serviceTier: null, gatewayCost: null,
        }])
        expect(result.retained).toBe(true)
    })

    it('migrates committed request rows from a source WAL and keeps that backup readable', () => {
        const result = withRestartedMigration(`
            const fs = require('node:fs');
            const path = require('node:path');
            const base = process.argv[1];
            const save = path.join(process.cwd(), 'save');
            fs.mkdirSync(save, { recursive: true });
            const sourcePath = path.join(save, 'request-logs.db');
            const Database = require(path.join(base, '../sqlite.cjs'));
            const source = new Database(sourcePath);
            source.pragma('journal_mode = WAL');
            source.pragma('synchronous = FULL');
            source.pragma('wal_autocheckpoint = 0');
            source.exec(\`
                CREATE TABLE request_logs (
                    id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, date TEXT NOT NULL,
                    url TEXT NOT NULL, body TEXT NOT NULL, header TEXT NOT NULL,
                    response TEXT NOT NULL, success INTEGER NOT NULL
                );
            \`);
            const body = JSON.stringify({ model: 'wal-model', messages: [{ role: 'user', content: 'committed in WAL' }] });
            source.prepare(\`
                INSERT INTO request_logs (id, timestamp, date, url, body, header, response, success)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            \`).run(
                'wal-request', 321, 'WAL date', 'https://api.example.test/v1/chat/completions',
                body, '{"x-wal":"retained"}', '{"answer":"from WAL"}', 1,
            );
            const walPath = sourcePath + '-wal';
            if (!fs.existsSync(walPath) || fs.statSync(walPath).size <= 32) {
                throw new Error('Expected committed request data to remain in the source WAL');
            }
            fs.writeFileSync(path.join(save, 'seeded-wal-size.txt'), String(fs.statSync(walPath).size));
            process.exit(0);
        `, `
            const fs = require('node:fs');
            const path = require('node:path');
            const base = process.argv[1];
            const save = path.join(process.cwd(), 'save');
            const stores = require(path.join(base, 'logDatabases.cjs'));
            const requests = require(path.join(base, 'requestLogs.cjs'));
            const Database = require(path.join(base, '../sqlite.cjs'));
            const originPath = path.join(save, 'migration', 'origin', 'request-logs', 'request-logs.db');
            const origin = new Database(originPath, { readOnly: true });
            const originRow = origin.prepare(
                'SELECT id, body, header, response FROM request_logs WHERE id = ?'
            ).get('wal-request');
            origin.close();
            const result = {
                detail: requests.queryRequestLogById('wal-request'),
                originRow,
                originalWalBytes: Number(fs.readFileSync(path.join(save, 'seeded-wal-size.txt'), 'utf8')),
                backupWalBytes: fs.statSync(originPath + '-wal').size,
            };
            stores.requestDb.close();
            stores.systemDb.close();
            process.stdout.write(JSON.stringify(result));
        `)

        expect(result.originalWalBytes).toBeGreaterThan(32)
        expect(result.backupWalBytes).toBe(result.originalWalBytes)
        expect(result.detail).toMatchObject({
            id: 'wal-request',
            body: JSON.stringify({ model: 'wal-model', messages: [{ role: 'user', content: 'committed in WAL' }] }),
            header: '{"x-wal":"retained"}',
            response: '{"answer":"from WAL"}',
            model: 'wal-model',
            payloadAvailable: true,
        })
        expect(result.originRow).toEqual({
            id: 'wal-request',
            body: JSON.stringify({ model: 'wal-model', messages: [{ role: 'user', content: 'committed in WAL' }] }),
            header: '{"x-wal":"retained"}',
            response: '{"answer":"from WAL"}',
        })
    })

    it('retains successful originals for 24 hours, then cleans them up', () => {
        const result = withIsolatedDatabase(`
            const fs = require('node:fs');
            const path = require('node:path');
            const base = process.argv[1];
            const save = path.join(process.cwd(), 'save');
            fs.mkdirSync(save, { recursive: true });
            fs.writeFileSync(path.join(save, 'legacy.db'), 'original');
            const migration = require(path.join(base, '../fileMigration.cjs'));
            migration.runFileMigration({
                saveDir: save, name: 'retention', sources: ['legacy.db'], targets: ['current.db'],
                build(tmp) { fs.writeFileSync(path.join(tmp, 'current.db'), 'migrated'); },
            });
            const statePath = path.join(save, 'migration', 'retention.json');
            const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
            const originPath = path.join(save, 'migration', 'origin', 'retention', 'legacy.db');
            migration.cleanupMigrationOrigins(save, state.retainUntil - 1);
            const retainedBeforeDeadline = fs.existsSync(originPath);
            const originalRmSync = fs.rmSync;
            let injectedFailure = false;
            fs.rmSync = (target, options) => {
                if (target === path.dirname(originPath)) {
                    injectedFailure = true;
                    throw new Error('simulated expired-origin cleanup failure');
                }
                return originalRmSync(target, options);
            };
            const originalNow = Date.now;
            const originalConsoleError = console.error;
            console.error = () => {};
            let recoveryThrew = false;
            try {
                Date.now = () => state.retainUntil;
                migration.recoverFileMigrations(save);
            } catch {
                recoveryThrew = true;
            } finally {
                Date.now = originalNow;
                fs.rmSync = originalRmSync;
                console.error = originalConsoleError;
            }
            const targetSurvivesFailure = fs.readFileSync(path.join(save, 'current.db'), 'utf8') === 'migrated';
            const originRetainedAfterFailure = fs.existsSync(originPath);
            const stateRetainedAfterFailure = fs.existsSync(statePath);
            migration.cleanupMigrationOrigins(save, state.retainUntil);
            process.stdout.write(JSON.stringify({
                retentionMs: state.retainUntil - state.completedAt,
                phase: state.phase,
                sourceRemoved: !fs.existsSync(path.join(save, 'legacy.db')),
                retainedBeforeDeadline,
                injectedFailure,
                recoveryThrew,
                targetSurvivesFailure,
                originRetainedAfterFailure,
                stateRetainedAfterFailure,
                removedAtDeadline: !fs.existsSync(originPath),
                stateRemovedAtDeadline: !fs.existsSync(statePath),
            }));
        `)

        expect(result).toEqual({
            retentionMs: 24 * 60 * 60 * 1000,
            phase: 'complete',
            sourceRemoved: true,
            retainedBeforeDeadline: true,
            injectedFailure: true,
            recoveryThrew: false,
            targetSurvivesFailure: true,
            originRetainedAfterFailure: true,
            stateRetainedAfterFailure: true,
            removedAtDeadline: true,
            stateRemovedAtDeadline: true,
        })
    })

    it('restores both request targets when installation fails after the first promotion', () => {
        const result = withIsolatedDatabase(`
            const fs = require('node:fs');
            const path = require('node:path');
            const base = process.argv[1];
            const save = path.join(process.cwd(), 'save');
            fs.mkdirSync(save, { recursive: true });
            for (const [filename, value] of Object.entries({
                'request-logs.db': 'legacy requests', 'usage.db': 'legacy usage',
                'request-metadata.db': 'old metadata', 'request-metadata.db-wal': 'old metadata wal',
                'request-script.db': 'old script', 'request-script.db-shm': 'old script shm',
            })) fs.writeFileSync(path.join(save, filename), value);
            const migration = require(path.join(base, '../fileMigration.cjs'));
            const originalRename = fs.renameSync;
            let injectedFailure = false;
            fs.renameSync = (source, target) => {
                originalRename(source, target);
                if (!injectedFailure && target === path.join(save, 'request-metadata.db')) {
                    injectedFailure = true;
                    throw new Error('simulated installation failure');
                }
            };
            let error;
            try {
                migration.runFileMigration({
                    saveDir: save, name: 'request-logs',
                    sources: ['request-logs.db', 'usage.db'],
                    targets: ['request-metadata.db', 'request-script.db'],
                    build(tmp) {
                        fs.writeFileSync(path.join(tmp, 'request-metadata.db'), 'new metadata');
                        fs.writeFileSync(path.join(tmp, 'request-script.db'), 'new script');
                    },
                });
            } catch (caught) { error = caught.message; }
            finally { fs.renameSync = originalRename; }
            const values = Object.fromEntries([
                'request-logs.db', 'usage.db', 'request-metadata.db', 'request-metadata.db-wal',
                'request-script.db', 'request-script.db-shm',
            ].map(filename => [filename, fs.readFileSync(path.join(save, filename), 'utf8')]));
            const state = JSON.parse(fs.readFileSync(path.join(save, 'migration', 'request-logs.json'), 'utf8'));
            process.stdout.write(JSON.stringify({
                error, injectedFailure, values, phase: state.phase,
                backedUp: state.backedUp,
                tempRemoved: !fs.existsSync(path.join(save, 'migration', 'tmp', 'request-logs')),
            }));
        `)

        expect(result.error).toContain('Migration request-logs failed')
        expect(result.injectedFailure).toBe(true)
        expect(result.values).toEqual({
            'request-logs.db': 'legacy requests',
            'usage.db': 'legacy usage',
            'request-metadata.db': 'old metadata',
            'request-metadata.db-wal': 'old metadata wal',
            'request-script.db': 'old script',
            'request-script.db-shm': 'old script shm',
        })
        expect(result.phase).toBe('failed')
        expect(result.backedUp).toEqual(expect.arrayContaining([
            'request-logs.db', 'usage.db', 'request-metadata.db', 'request-metadata.db-wal',
            'request-script.db', 'request-script.db-shm',
        ]))
        expect(result.tempRemoved).toBe(true)
    })

    it('recovers an interrupted request pair while a completed system-log migration survives', () => {
        const result = withRestartedMigration(`
            const fs = require('node:fs');
            const path = require('node:path');
            const base = process.argv[1];
            const save = path.join(process.cwd(), 'save');
            fs.mkdirSync(save, { recursive: true });
            const migration = require(path.join(base, '../fileMigration.cjs'));
            fs.writeFileSync(path.join(save, 'logs.db'), 'legacy logs');
            migration.runFileMigration({
                saveDir: save, name: 'system-logs', sources: ['logs.db'], targets: ['system-logs.db'],
                build(tmp) { fs.writeFileSync(path.join(tmp, 'system-logs.db'), 'migrated logs'); },
            });
            for (const [filename, value] of Object.entries({
                'request-logs.db': 'legacy requests', 'usage.db': 'legacy usage',
                'request-metadata.db': 'old metadata', 'request-script.db': 'old script',
            })) fs.writeFileSync(path.join(save, filename), value);
            const originalRename = fs.renameSync;
            fs.renameSync = (source, target) => {
                originalRename(source, target);
                if (target === path.join(save, 'request-metadata.db')) {
                    process.stdout.write('interrupted');
                    process.exit(0);
                }
            };
            migration.runFileMigration({
                saveDir: save, name: 'request-logs',
                sources: ['request-logs.db', 'usage.db'],
                targets: ['request-metadata.db', 'request-script.db'],
                build(tmp) {
                    fs.writeFileSync(path.join(tmp, 'request-metadata.db'), 'new metadata');
                    fs.writeFileSync(path.join(tmp, 'request-script.db'), 'new script');
                },
            });
        `, `
            const fs = require('node:fs');
            const path = require('node:path');
            const base = process.argv[1];
            const save = path.join(process.cwd(), 'save');
            require(path.join(base, '../fileMigration.cjs')).recoverFileMigrations(save);
            const read = filename => fs.readFileSync(path.join(save, filename), 'utf8');
            const exists = filename => fs.existsSync(path.join(save, filename));
            const systemState = JSON.parse(fs.readFileSync(path.join(save, 'migration', 'system-logs.json'), 'utf8'));
            const requestState = JSON.parse(fs.readFileSync(path.join(save, 'migration', 'request-logs.json'), 'utf8'));
            process.stdout.write(JSON.stringify({
                systemTarget: read('system-logs.db'),
                systemSourceRemoved: !exists('logs.db'),
                requestSources: [read('request-logs.db'), read('usage.db')],
                requestTargets: ['request-metadata.db', 'request-script.db'].map(filename => read(filename)),
                systemPhase: systemState.phase,
                requestPhase: requestState.phase,
                requestOriginRetained: fs.existsSync(path.join(save, 'migration', 'origin', 'request-logs', 'request-logs.db')),
                requestTempRemoved: !fs.existsSync(path.join(save, 'migration', 'tmp', 'request-logs')),
            }));
        `)

        expect(result).toEqual({
            systemTarget: 'migrated logs',
            systemSourceRemoved: true,
            requestSources: ['legacy requests', 'legacy usage'],
            requestTargets: ['old metadata', 'old script'],
            systemPhase: 'complete',
            requestPhase: 'failed',
            requestOriginRetained: true,
            requestTempRemoved: true,
        })
    })
})
