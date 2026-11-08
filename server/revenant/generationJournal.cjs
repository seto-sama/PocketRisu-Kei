'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

// `journal` holds the provider's raw bytes; `events` holds the server's
// decoded NDJSON events for chat responses.
const JOURNAL_KINDS = new Set(['journal', 'events']);
const TEMP_SUFFIX = '.tmp';
const JOURNAL_READ_CHUNK_BYTES = 64 * 1024;

function validateId(value, label) {
    if (
        typeof value !== 'string'
        || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
    ) {
        throw new Error(`Invalid generation journal ${label}`);
    }
    return value;
}

function createGenerationJournalStore(options = {}) {
    const revenantDir = options.revenantDir
        || path.join(process.cwd(), 'save', 'revenant');
    fs.mkdirSync(revenantDir, { recursive: true });

    function journalKey(workflowId, jobId) {
        return `${workflowId || ''}\u0000${jobId}`;
    }

    function journalPath(workflowId, jobId, kind = 'journal') {
        if (!JOURNAL_KINDS.has(kind)) throw new Error('Invalid generation journal kind');
        const fileName = `${validateId(jobId, 'job id')}.${kind}`;
        return workflowId
            ? path.join(revenantDir, validateId(workflowId, 'workflow id'), fileName)
            : path.join(revenantDir, fileName);
    }

    function create(workflowId, jobId) {
        const filePath = journalPath(workflowId, jobId);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        const fd = fs.openSync(filePath, 'wx');
        fs.closeSync(fd);
        return filePath;
    }

    function openWriter(workflowId, jobId, kind = 'journal') {
        return fs.createWriteStream(journalPath(workflowId, jobId, kind), { flags: 'a' });
    }

    /** Replaces a derived file without exposing a partial write to readers. */
    function replace(workflowId, jobId, kind, bytes) {
        const filePath = journalPath(workflowId, jobId, kind);
        const tempPath = `${filePath}${TEMP_SUFFIX}`;
        try {
            fs.writeFileSync(tempPath, bytes);
            fs.renameSync(tempPath, filePath);
        } catch (error) {
            fs.rmSync(tempPath, { force: true });
            throw error;
        }
    }

    function readAll(workflowId, jobId, kind = 'journal') {
        try {
            return fs.readFileSync(journalPath(workflowId, jobId, kind));
        } catch (error) {
            if (error?.code === 'ENOENT') return Buffer.alloc(0);
            throw error;
        }
    }

    async function readChunk(workflowId, jobId, offset, kind = 'journal') {
        const length = JOURNAL_READ_CHUNK_BYTES;
        let file;
        try {
            file = await fsp.open(journalPath(workflowId, jobId, kind), 'r');
            const buffer = Buffer.allocUnsafe(length);
            const { bytesRead } = await file.read(buffer, 0, length, offset);
            return { offset, bytes: buffer.subarray(0, bytesRead) };
        } catch (error) {
            if (error?.code === 'ENOENT') return { offset, bytes: Buffer.alloc(0) };
            throw error;
        } finally {
            await file?.close();
        }
    }

    function size(workflowId, jobId) {
        try {
            return fs.statSync(journalPath(workflowId, jobId)).size;
        } catch (error) {
            if (error?.code === 'ENOENT') return 0;
            throw error;
        }
    }

    function remove(workflowId, jobId) {
        const filePath = journalPath(workflowId, jobId);
        try {
            fs.rmSync(journalPath(workflowId, jobId, 'events'), { force: true });
            fs.rmSync(`${journalPath(workflowId, jobId, 'events')}${TEMP_SUFFIX}`, { force: true });
            fs.unlinkSync(filePath);
            if (workflowId) {
                try {
                    fs.rmdirSync(path.dirname(filePath));
                } catch (error) {
                    if (!['ENOENT', 'ENOTEMPTY'].includes(error?.code)) throw error;
                }
            }
            return true;
        } catch (error) {
            if (error?.code === 'ENOENT') return false;
            throw error;
        }
    }

    function removeOrphans(validJournals, olderThan) {
        let deleted = 0;
        const inspectFile = (workflowId, entry, parentDir) => {
            if (!entry.isFile()) return;
            // A replacement left behind by a crash is never read again.
            const abandoned = entry.name.endsWith(TEMP_SUFFIX);
            const name = abandoned ? entry.name.slice(0, -TEMP_SUFFIX.length) : entry.name;
            const extension = path.extname(name);
            if (!JOURNAL_KINDS.has(extension.slice(1))) return;
            const jobId = name.slice(0, -extension.length);
            if (!abandoned && validJournals.has(journalKey(workflowId, jobId))) return;
            const filePath = path.join(parentDir, entry.name);
            if (fs.statSync(filePath).mtimeMs > olderThan) return;
            fs.unlinkSync(filePath);
            deleted += 1;
        };
        for (const entry of fs.readdirSync(revenantDir, { withFileTypes: true })) {
            if (entry.isFile()) {
                inspectFile(null, entry, revenantDir);
                continue;
            }
            if (!entry.isDirectory()) continue;
            const workflowId = entry.name;
            const workflowDir = path.join(revenantDir, workflowId);
            for (const child of fs.readdirSync(workflowDir, { withFileTypes: true })) {
                inspectFile(workflowId, child, workflowDir);
            }
            try {
                fs.rmdirSync(workflowDir);
            } catch (error) {
                if (!['ENOENT', 'ENOTEMPTY'].includes(error?.code)) throw error;
            }
        }
        return deleted;
    }

    return {
        revenantDir,
        journalKey,
        journalPath,
        create,
        openWriter,
        replace,
        readAll,
        readChunk,
        size,
        remove,
        removeOrphans,
    };
}

const generationJournalStore = createGenerationJournalStore();

module.exports = {
    createGenerationJournalStore,
    generationJournalStore,
};
