'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const JOURNAL_SUFFIX = '.journal';
const JOURNAL_READ_CHUNK_BYTES = 64 * 1024;

function validateJobId(jobId) {
    if (
        typeof jobId !== 'string'
        || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(jobId)
    ) {
        throw new Error('Invalid generation journal job id');
    }
    return jobId;
}

function createGenerationJournalStore(options = {}) {
    const journalDir = options.journalDir
        || path.join(process.cwd(), 'save', 'revenant', 'journals');
    fs.mkdirSync(journalDir, { recursive: true });

    function journalPath(jobId) {
        return path.join(journalDir, `${validateJobId(jobId)}${JOURNAL_SUFFIX}`);
    }

    function create(jobId) {
        const filePath = journalPath(jobId);
        const fd = fs.openSync(filePath, 'wx');
        fs.closeSync(fd);
        return filePath;
    }

    function openWriter(jobId) {
        return fs.createWriteStream(journalPath(jobId), { flags: 'a' });
    }

    function readAll(jobId) {
        try {
            return fs.readFileSync(journalPath(jobId));
        } catch (error) {
            if (error?.code === 'ENOENT') return Buffer.alloc(0);
            throw error;
        }
    }

    async function readChunk(jobId, requestedOffset, maxBytes = JOURNAL_READ_CHUNK_BYTES) {
        const offset = Number.isSafeInteger(requestedOffset) && requestedOffset >= 0
            ? requestedOffset
            : 0;
        const length = Math.max(1, Math.min(
            JOURNAL_READ_CHUNK_BYTES,
            Number(maxBytes) || JOURNAL_READ_CHUNK_BYTES,
        ));
        let file;
        try {
            file = await fsp.open(journalPath(jobId), 'r');
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

    function size(jobId) {
        try {
            return fs.statSync(journalPath(jobId)).size;
        } catch (error) {
            if (error?.code === 'ENOENT') return 0;
            throw error;
        }
    }

    function remove(jobId) {
        try {
            fs.unlinkSync(journalPath(jobId));
            return true;
        } catch (error) {
            if (error?.code === 'ENOENT') return false;
            throw error;
        }
    }

    function removeOrphans(validJobIds, olderThan) {
        let deleted = 0;
        for (const entry of fs.readdirSync(journalDir, { withFileTypes: true })) {
            if (!entry.isFile() || !entry.name.endsWith(JOURNAL_SUFFIX)) continue;
            const jobId = entry.name.slice(0, -JOURNAL_SUFFIX.length);
            if (validJobIds.has(jobId)) continue;
            const filePath = path.join(journalDir, entry.name);
            const stat = fs.statSync(filePath);
            if (stat.mtimeMs > olderThan) continue;
            fs.unlinkSync(filePath);
            deleted += 1;
        }
        return deleted;
    }

    return {
        journalDir,
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
