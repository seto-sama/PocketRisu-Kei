'use strict';

const { openDatabase, withTransaction } = require('../sqlite.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { extractRequestModel } = require('./requestMetadata.cjs');
const { createScriptStore } = require('./requestScripts.cjs');
const { getRequestLogMaxBytes } = require('./requestLogLimits.cjs');
const { runFileMigration, recoverFileMigrations, scheduleMigrationCleanup } = require('../fileMigration.cjs');

const saveDir = path.join(process.cwd(), 'save');
fs.mkdirSync(saveDir, { recursive: true });

function journalPragmas(journalMode, schema = 'main') {
    return `PRAGMA ${schema}.journal_mode = ${journalMode};
        PRAGMA ${schema}.synchronous = ${journalMode === 'WAL' ? 'NORMAL' : 'FULL'};`;
}

function openLogDatabase(directory, filename, journalMode, initialize) {
    const db = openDatabase(path.join(directory, filename));
    try {
        db.exec(journalPragmas(journalMode));
        initialize(db);
        return db;
    } catch (error) {
        db.close();
        throw error;
    }
}

function openSystemDatabase(directory, journalMode = 'WAL') {
    return openLogDatabase(directory, 'system-logs.db', journalMode, db => {
        db.exec(`
            CREATE TABLE IF NOT EXISTS logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp INTEGER NOT NULL, level TEXT NOT NULL, origin TEXT NOT NULL,
                message TEXT NOT NULL, description TEXT, source TEXT,
                count INTEGER NOT NULL DEFAULT 1, platform TEXT, client_id TEXT, user_agent TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp DESC);
            CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level);
        `);
    });
}

function openRequestDatabase(directory, journalMode = 'WAL') {
    return openLogDatabase(directory, 'request-metadata.db', journalMode, db => {
        db.prepare('ATTACH DATABASE ? AS request_script').run(path.join(directory, 'request-script.db'));
        db.exec(`PRAGMA request_script.auto_vacuum = FULL; ${journalPragmas(journalMode, 'request_script')}`);
        db.exec(`
            CREATE TABLE IF NOT EXISTS metadata (
                id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, date TEXT NOT NULL, url TEXT NOT NULL,
                success INTEGER NOT NULL, response_type TEXT, chat_id TEXT, status INTEGER,
                client_id TEXT, platform TEXT, duration_ms INTEGER, model TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_metadata_timestamp ON metadata(timestamp DESC);
            CREATE INDEX IF NOT EXISTS idx_metadata_chat_timestamp ON metadata(chat_id, timestamp DESC);
            CREATE TABLE IF NOT EXISTS usage (
                job_id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, chat_id TEXT, provider TEXT, model TEXT,
                prompt_tokens INTEGER, completion_tokens INTEGER, total_tokens INTEGER, cached_tokens INTEGER,
                cache_read_tokens INTEGER, cache_creation_tokens INTEGER, reasoning_tokens INTEGER,
                service_tier TEXT, gateway_cost REAL, usage_json TEXT NOT NULL DEFAULT '[]'
            );
            CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON usage(timestamp DESC);
            CREATE TABLE IF NOT EXISTS thought_signatures (
                response_id TEXT PRIMARY KEY, adapter_kind TEXT NOT NULL, model TEXT NOT NULL,
                created_at INTEGER NOT NULL, turns_json TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_thought_signatures_created_at ON thought_signatures(created_at DESC);
            CREATE TABLE IF NOT EXISTS request_script.script (
                id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL,
                body TEXT NOT NULL, header TEXT NOT NULL, response TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS request_script.idx_script_timestamp ON script(timestamp);
        `);
    });
}

function withLegacyDatabase(directory, filename, migrate) {
    const filenamePath = path.join(directory, filename);
    if (!fs.existsSync(filenamePath)) return;
    const source = openDatabase(filenamePath, { readOnly: true });
    try { migrate(source); } finally { source.close(); }
}

function columns(db, table) {
    return db.prepare(`PRAGMA table_info(${table})`).all();
}

function copyTable(source, sourceTable, target, targetTable) {
    const sourceColumns = new Set(columns(source, sourceTable).map(column => column.name));
    if (sourceColumns.size === 0) return;
    const targetColumns = columns(target, targetTable);
    const names = targetColumns.map(column => column.name);
    const expressions = targetColumns.map(column => sourceColumns.has(column.name)
        ? column.name : column.dflt_value ?? 'NULL');
    const insert = target.prepare(`INSERT INTO ${targetTable} (${names.join(', ')})
        VALUES (${names.map(() => '?').join(', ')}) ON CONFLICT DO NOTHING`);
    for (const row of source.prepare(`SELECT ${expressions.map((expression, index) =>
        `${expression} AS ${names[index]}`).join(', ')} FROM ${sourceTable} ORDER BY rowid`).iterate()) {
        insert.run(...names.map(name => row[name]));
    }
}

function migrateRequests(source, requestDb) {
    const scriptStore = createScriptStore(requestDb);
    const maxBytes = getRequestLogMaxBytes();
    const sourceColumns = new Set(columns(source, 'request_logs').map(column => column.name));
    if (sourceColumns.size === 0) return;
    const hasInlineScript = sourceColumns.has('body');
    const scriptTable = hasInlineScript ? 'request_logs' : 'request_log_payloads';
    const hasScripts = columns(source, scriptTable).length > 0;
    const targetColumns = columns(requestDb, 'metadata').map(column => column.name);
    const insert = requestDb.prepare(`INSERT INTO metadata (rowid, ${targetColumns.join(', ')})
        VALUES (${Array(targetColumns.length + 1).fill('?').join(', ')})`);
    const body = hasInlineScript ? 'log.body' : hasScripts ? 'payload.body' : 'NULL';
    const join = !hasInlineScript && hasScripts ? `LEFT JOIN ${scriptTable} AS payload ON payload.id = log.id` : '';
    const fields = targetColumns.map(name => `${sourceColumns.has(name) ? `log.${name}` : 'NULL'} AS ${name}`);
    for (const row of source.prepare(`SELECT log.rowid AS migration_rowid,
        ${fields.join(', ')}, ${body} AS migration_body FROM request_logs AS log ${join} ORDER BY log.rowid`).iterate()) {
        row.model = row.model || extractRequestModel(row.migration_body, row.url);
        insert.run(row.migration_rowid, ...targetColumns.map(name => row[name]));
    }
    if (!hasScripts) return;
    for (const script of source.prepare(`SELECT id, body, header, response FROM ${scriptTable}
        ORDER BY timestamp DESC, rowid DESC`).iterate()) {
        // Skip an oversized entry without discarding other usable recent scripts.
        if (Buffer.byteLength(script.body) + Buffer.byteLength(script.header)
            + Buffer.byteLength(script.response) > maxBytes) continue;
        if (!scriptStore.upsert(script)) break;
    }
}

function validateDatabase(db, schema = 'main') {
    const result = db.prepare(`PRAGMA ${schema}.quick_check`).get().quick_check;
    if (result !== 'ok') throw new Error(`Invalid migrated ${schema} database: ${result}`);
}

recoverFileMigrations(saveDir);

if (fs.existsSync(path.join(saveDir, 'logs.db'))) {
    runFileMigration({
        saveDir, name: 'system-logs', sources: ['logs.db'], targets: ['system-logs.db'],
        build(tmp, origin) {
            const db = openSystemDatabase(tmp, 'DELETE');
            try {
                withTransaction(db, () => {
                    withLegacyDatabase(origin, 'logs.db', source => {
                        copyTable(source, 'logs', db, 'logs');
                        const sequence = source.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'logs'").get();
                        if (sequence) {
                            db.prepare("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = 'logs'").run(sequence.seq);
                            db.prepare("INSERT INTO sqlite_sequence (name, seq) SELECT 'logs', ? WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'logs')").run(sequence.seq);
                        }
                    });
                    db.exec('PRAGMA user_version = 1');
                }, 'IMMEDIATE');
                validateDatabase(db);
            } finally { db.close(); }
        },
    });
}

const requestSources = ['request-logs.db', 'usage.db'];
const requestTargets = ['request-metadata.db', 'request-script.db'];
if (requestSources.some(filename => fs.existsSync(path.join(saveDir, filename)))) {
    runFileMigration({
        saveDir, name: 'request-logs', sources: requestSources, targets: requestTargets,
        build(tmp, origin) {
            const db = openRequestDatabase(tmp, 'DELETE');
            try {
                withTransaction(db, () => {
                    let usageMigrated = false;
                    withLegacyDatabase(origin, 'request-logs.db', source => {
                        migrateRequests(source, db);
                        usageMigrated = columns(source, 'generation_usage').length > 0;
                        if (usageMigrated) copyTable(source, 'generation_usage', db, 'usage');
                        if (columns(source, 'request_log_migrations').length > 0) {
                            usageMigrated = Boolean(source.prepare(`
                                SELECT 1 FROM request_log_migrations WHERE key = 'legacy-usage-db-v1'
                            `).get());
                        }
                    });
                    // A completed consolidation is authoritative even if its usage was later cleared.
                    if (!usageMigrated) withLegacyDatabase(origin, 'usage.db', source =>
                        copyTable(source, 'generation_usage', db, 'usage'));
                    db.exec('PRAGMA user_version = 1; PRAGMA request_script.user_version = 1');
                }, 'IMMEDIATE');
                validateDatabase(db);
                validateDatabase(db, 'request_script');
            } finally { db.close(); }
        },
    });
}

const systemDb = openSystemDatabase(saveDir);
const requestDb = openRequestDatabase(saveDir);
systemDb.exec('PRAGMA user_version = 1');
requestDb.exec('PRAGMA user_version = 1; PRAGMA request_script.user_version = 1');
const scriptStore = createScriptStore(requestDb);
scheduleMigrationCleanup(saveDir);

module.exports = { systemDb, requestDb, scriptStore };
