'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const JOURNAL_SUFFIX = '.journal';
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

    function journalPath(workflowId, jobId) {
        const fileName = `${validateId(jobId, 'job id')}${JOURNAL_SUFFIX}`;
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

    function openWriter(workflowId, jobId) {
        return fs.createWriteStream(journalPath(workflowId, jobId), { flags: 'a' });
    }

    function readAll(workflowId, jobId) {
        try {
            return fs.readFileSync(journalPath(workflowId, jobId));
        } catch (error) {
            if (error?.code === 'ENOENT') return Buffer.alloc(0);
            throw error;
        }
    }

    async function readChunk(
        workflowId,
        jobId,
        requestedOffset,
        maxBytes = JOURNAL_READ_CHUNK_BYTES,
    ) {
        const offset = Number.isSafeInteger(requestedOffset) && requestedOffset >= 0
            ? requestedOffset
            : 0;
        const length = Math.max(1, Math.min(
            JOURNAL_READ_CHUNK_BYTES,
            Number(maxBytes) || JOURNAL_READ_CHUNK_BYTES,
        ));
        let file;
        try {
            file = await fsp.open(journalPath(workflowId, jobId), 'r');
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
            if (!entry.isFile() || !entry.name.endsWith(JOURNAL_SUFFIX)) return;
            const jobId = entry.name.slice(0, -JOURNAL_SUFFIX.length);
            if (validJournals.has(journalKey(workflowId, jobId))) return;
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
        readAll,
        readChunk,
        size,
        remove,
        removeOrphans,
    };
}

const generationJournalStore = createGenerationJournalStore();

module.exports = {
    JOURNAL_READ_CHUNK_BYTES,
    createGenerationJournalStore,
    generationJournalStore,
};
