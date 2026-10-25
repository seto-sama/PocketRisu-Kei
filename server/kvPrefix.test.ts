import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'vitest'

const dbPath = fileURLToPath(new URL('./db.cjs', import.meta.url))

function runWithKv(source: string) {
    const directory = mkdtempSync(join(tmpdir(), 'kei-kv-prefix-'))
    try {
        execFileSync(process.execPath, ['-e', `
            const assert = require('node:assert/strict');
            const { db, kvSet, kvList, kvCount, kvListWithSizes, kvDelPrefix } = require(${JSON.stringify(dbPath)});
            const keys = [
                'assets/', 'assets/a.png', 'assets/B.PNG', 'Assets/upper.png',
                'assets', 'assets0', 'assetsX/x', 'assets/%_\\\\odd.png',
                'assets/other.png', 'pluginstorage/key',
                '한글%_\\\\é/item', '한글XXé/item', '😀/item'
            ];
            const prefixes = ['', 'assets/', 'assets/%_\\\\', '한글%_\\\\é', '😀', 'missing/'];
            function seed() {
                db.prepare('DELETE FROM kv').run();
                keys.forEach((key, index) => {
                    kvSet(key, Buffer.alloc(index + 1));
                    db.prepare('UPDATE kv SET updated_at = ? WHERE key = ?').run(Math.floor(index / 2), key);
                });
            }
            try {
                seed();
                ${source}
            } finally {
                db.close();
            }
        `], { cwd: directory, stdio: 'pipe' })
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
}

describe('KV prefix queries', () => {
    it('lists, counts and sizes only keys matching the literal prefix', () => {
        runWithKv(`
            for (const prefix of prefixes) {
                const expected = keys.filter(key => key.startsWith(prefix)).sort();
                assert.deepEqual(kvList(prefix).sort(), expected);
                assert.equal(kvCount(prefix), expected.length);
                const sizes = kvListWithSizes(prefix).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
                assert.deepEqual(sizes.map(row => [row.key, row.size]), expected.map(key => [key, keys.indexOf(key) + 1]));
            }
            assert.deepEqual(kvList().sort(), keys.toSorted());
            assert.equal(kvCount(), keys.length);
        `)
    })

    it('keeps latest-first pagination and counts consistent with the prefix', () => {
        runWithKv(`
            for (const prefix of [...prefixes, undefined]) {
                const expected = keys.toReversed().filter(key => !prefix || key.startsWith(prefix));
                assert.deepEqual(kvList(prefix, { order: 'updated-desc', limit: 2, offset: 1 }), expected.slice(1, 3));
                assert.equal(kvCount(prefix), expected.length);
            }
        `)
    })

    it('deletes only keys matching the literal prefix', () => {
        runWithKv(`
            for (const prefix of prefixes) {
                seed();
                kvDelPrefix(prefix);
                assert.deepEqual(kvList().sort(), keys.filter(key => !key.startsWith(prefix)).sort());
            }
        `)
    })
})
