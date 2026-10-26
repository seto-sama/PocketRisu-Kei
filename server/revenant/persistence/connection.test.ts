import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import Database from '../../sqlite.cjs'

const persistenceDirectory = dirname(fileURLToPath(import.meta.url))

it('backfills response decoders for journals written before requests carried them', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'pocketrisu-revenant-migration-'))
    try {
        mkdirSync(resolve(directory, 'save/revenant'), { recursive: true })
        const legacy = new Database(resolve(directory, 'save/revenant/revenant.db'))
        legacy.exec(`
            CREATE TABLE generation_jobs (
                job_id TEXT PRIMARY KEY, chat_id TEXT, job_type TEXT NOT NULL DEFAULT 'model',
                character_id TEXT, room_id TEXT, workflow_id TEXT, workflow_step_key TEXT,
                step_execution_id TEXT, adapter_kind TEXT, streaming INTEGER NOT NULL DEFAULT 0,
                dispatch_group TEXT, dispatch_max_concurrent INTEGER, dispatched_at INTEGER,
                request_spec BLOB, status TEXT NOT NULL, response_status INTEGER, response_headers TEXT,
                raw_bytes INTEGER NOT NULL DEFAULT 0, normalized_projection TEXT, projection_error TEXT,
                projected_at INTEGER, finish_reason TEXT, error TEXT, created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL, completed_at INTEGER, materialized_at INTEGER
            );
            INSERT INTO generation_jobs (job_id, adapter_kind, streaming, status, created_at, updated_at) VALUES
                ('stream', 'anthropic-messages', 1, 'generated', 1, 1),
                ('echo', 'echo', 0, 'generated', 1, 1),
                ('plugin', 'plugin', 1, 'generated', 1, 1);
        `)
        legacy.close()

        const rows = JSON.parse(execFileSync(process.execPath, ['-e', `
            const { db } = require(require('node:path').join(process.argv[1], 'connection.cjs'));
            const columns = db.prepare('PRAGMA table_info(generation_jobs)').all().map(column => column.name);
            const rows = db.prepare('SELECT job_id, response_decoder FROM generation_jobs ORDER BY job_id').all();
            db.close();
            process.stdout.write(JSON.stringify({ columns, rows }));
        `, persistenceDirectory], { cwd: directory, encoding: 'utf8' }))

        expect(rows.columns).not.toContain('streaming')
        expect(rows.rows.map((row: { job_id: string, response_decoder: string | null }) => [
            row.job_id, row.response_decoder && JSON.parse(row.response_decoder),
        ])).toEqual([
            ['echo', { adapterKind: 'openai-compatible', stream: false }],
            ['plugin', null],
            ['stream', { adapterKind: 'anthropic-messages', stream: true }],
        ])
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
})
